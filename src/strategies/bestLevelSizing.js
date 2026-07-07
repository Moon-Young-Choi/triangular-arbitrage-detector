const { calculateCycleMultiplier } = require("../lib/multiplier");
const { parseMarket } = require("../lib/marketGraph");
const { resolveLegFeeRate } = require("../lib/depthSimulator");

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function orderbookForMarket(orderbooks, market) {
  if (!orderbooks) return null;
  return orderbooks instanceof Map ? orderbooks.get(market) : orderbooks[market];
}

function firstUnit(orderbook) {
  const raw = orderbook && Array.isArray(orderbook.orderbook_units) && orderbook.orderbook_units[0];
  if (!raw) return null;

  const unit = {
    askPrice: numberOrNull(raw.ask_price ?? raw.askPrice),
    bidPrice: numberOrNull(raw.bid_price ?? raw.bidPrice),
    askSize: numberOrNull(raw.ask_size ?? raw.askSize),
    bidSize: numberOrNull(raw.bid_size ?? raw.bidSize),
  };

  if (
    !(unit.askPrice > 0) ||
    !(unit.bidPrice > 0) ||
    !(unit.askSize >= 0) ||
    !(unit.bidSize >= 0)
  ) {
    return null;
  }

  return unit;
}

function bestLevelResidualInputCap(step, orderbook, feeRate, config = {}) {
  const unit = firstUnit(orderbook);
  if (!unit) {
    return {
      ok: false,
      reason: "BEST_LEVEL_ORDERBOOK_MISSING",
    };
  }

  const { quote, base } = parseMarket(step.market);
  const residualRatio = Math.max(0, Math.min(1, Number(config.minResidualRatioPerBestLevel || 0)));

  if (step.fromAsset === quote && step.toAsset === base) {
    const minResidualTotal = 0;
    const bestLevelTotal = unit.askPrice * unit.askSize;
    const maxTradeTotalByRatio = bestLevelTotal * (1 - residualRatio);
    const tradeInputCap = maxTradeTotalByRatio;
    const inputCap = tradeInputCap * (1 + Number(feeRate || 0));

    return {
      ok: inputCap > 0,
      reason: inputCap > 0 ? null : "BEST_LEVEL_RESIDUAL_BELOW_MIN_ORDER",
      side: "bid",
      usedSide: "ask",
      price: unit.askPrice,
      bestLevelSize: unit.askSize,
      bestLevelTotal,
      minResidualTotal,
      inputCap,
      tradeInputCap,
      residualAfterCapTotal: Math.max(0, bestLevelTotal - tradeInputCap),
      residualRatio,
    };
  }

  if (step.fromAsset === base && step.toAsset === quote) {
    const minResidualTotal = 0;
    const bestLevelTotal = unit.bidPrice * unit.bidSize;
    const maxTradeTotalByRatio = bestLevelTotal * (1 - residualRatio);
    const tradeQuoteCap = maxTradeTotalByRatio;
    const inputCap = tradeQuoteCap / unit.bidPrice;

    return {
      ok: inputCap > 0,
      reason: inputCap > 0 ? null : "BEST_LEVEL_RESIDUAL_BELOW_MIN_ORDER",
      side: "ask",
      usedSide: "bid",
      price: unit.bidPrice,
      bestLevelSize: unit.bidSize,
      bestLevelTotal,
      minResidualTotal,
      inputCap,
      tradeInputCap: tradeQuoteCap,
      residualAfterCapTotal: Math.max(0, bestLevelTotal - tradeQuoteCap),
      residualRatio,
    };
  }

  return {
    ok: false,
    reason: "MARKET_ROUTE_MISMATCH",
  };
}

function maxStartAmountCap(config = {}, startAsset) {
  const caps = config.maxStartAmountByAsset || {};
  const cap = numberOrNull(caps[startAsset]);
  return cap !== null && cap > 0 ? cap : Infinity;
}

function computeBestLevelResidualStartAmount(cycle, orderbooks, options = {}) {
  const config = options.config || {};
  const startAsset = cycle.startAsset || (Array.isArray(cycle.route) ? cycle.route[0] : null);
  const feeRate = Number(options.feeRate || 0);
  const quoteModel = calculateCycleMultiplier(cycle, null, orderbooks, feeRate, {
    feePolicyByMarket: options.feePolicyByMarket,
    useDefaultFeePolicy: options.useDefaultFeePolicy === true,
    expectedMaker: options.expectedMaker === true,
    orderType: options.orderType || "limit",
    timeInForce: options.timeInForce || "ioc",
    nowMs: options.nowMs,
  });

  if (!quoteModel.available) {
    return {
      ok: false,
      reason: quoteModel.unavailableReason || "QUOTE_MODEL_UNAVAILABLE",
      startAsset,
      startAmount: null,
      legs: [],
    };
  }

  const candidateStarts = [];
  const legs = [];

  for (const step of cycle.steps || []) {
    const modeledLeg = quoteModel.conversions.find((leg) => leg.legIndex === step.index + 1);
    const inputPerStart = numberOrNull(modeledLeg && modeledLeg.inputAmount);
    const feeSide = modeledLeg && modeledLeg.feeSide || null;
    const legFeeRate = resolveLegFeeRate(step, feeSide, feeRate, {
      feePolicyByMarket: options.feePolicyByMarket,
      useDefaultFeePolicy: options.useDefaultFeePolicy === true,
      expectedMaker: options.expectedMaker === true,
      orderType: options.orderType || "limit",
      timeInForce: options.timeInForce || "ioc",
    });
    const cap = bestLevelResidualInputCap(
      step,
      orderbookForMarket(orderbooks, step.market),
      legFeeRate,
      config,
    );
    const maxStartAmount = cap.ok && inputPerStart > 0 ? cap.inputCap / inputPerStart : null;

    legs.push({
      legIndex: step.index + 1,
      market: step.market,
      fromAsset: step.fromAsset,
      toAsset: step.toAsset,
      inputPerStart,
      feeRate: legFeeRate,
      maxStartAmount,
      ...cap,
    });

    if (!(maxStartAmount > 0)) {
      return {
        ok: false,
        reason: cap.reason || "BEST_LEVEL_SIZE_UNAVAILABLE",
        startAsset,
        startAmount: null,
        limitingLeg: step.index + 1,
        limitingMarket: step.market,
        legs,
      };
    }

    candidateStarts.push(maxStartAmount);
  }

  const liquidityStartAmount = candidateStarts.length > 0 ? Math.min(...candidateStarts) : null;
  const cappedStartAmount = liquidityStartAmount === null
    ? null
    : Math.min(liquidityStartAmount, maxStartAmountCap(config, startAsset));

  return {
    ok: cappedStartAmount > 0,
    reason: cappedStartAmount > 0 ? null : "BEST_LEVEL_SIZE_UNAVAILABLE",
    mode: "best-level-residual",
    startAsset,
    startAmount: cappedStartAmount,
    liquidityStartAmount,
    maxConfiguredStartAmount: maxStartAmountCap(config, startAsset),
    limitingLeg: legs.reduce((limiting, leg) => {
      if (!(leg.maxStartAmount > 0)) return limiting;
      if (!limiting || leg.maxStartAmount < limiting.maxStartAmount) return leg;
      return limiting;
    }, null),
    legs,
  };
}

module.exports = {
  bestLevelResidualInputCap,
  computeBestLevelResidualStartAmount,
};
