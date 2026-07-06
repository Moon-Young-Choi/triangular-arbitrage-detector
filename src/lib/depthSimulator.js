const { parseMarket } = require("./marketGraph");
const { REJECTION_REASONS } = require("../core/rejectionReasons");

function normalizeUnits(orderbook) {
  return (orderbook && Array.isArray(orderbook.orderbook_units) ? orderbook.orderbook_units : [])
    .map((unit) => ({
      askPrice: Number(unit.ask_price ?? unit.askPrice),
      bidPrice: Number(unit.bid_price ?? unit.bidPrice),
      askSize: Number(unit.ask_size ?? unit.askSize),
      bidSize: Number(unit.bid_size ?? unit.bidSize),
    }))
    .filter((unit) => (
      unit.askPrice > 0 &&
      unit.bidPrice > 0 &&
      unit.askSize >= 0 &&
      unit.bidSize >= 0
    ));
}

function insufficientDepth(partial = {}) {
  return {
    available: false,
    rejectionCode: REJECTION_REASONS.DEPTH_INSUFFICIENT,
    outputAmount: null,
    expectedSlippageBps: null,
    ...partial,
  };
}

function simulateBuyWithQuote(orderbook, quoteAmount, feeRate = 0) {
  if (!(quoteAmount >= 0)) {
    throw new Error(`Invalid quote amount: ${quoteAmount}`);
  }

  const units = normalizeUnits(orderbook);

  if (units.length === 0) {
    return insufficientDepth({ residualInputAmount: quoteAmount });
  }

  let remainingQuote = quoteAmount;
  let grossBase = 0;
  let quoteSpent = 0;
  let bestLevelQuoteSpent = 0;
  const bestLevelCapacityQuote = units[0].askPrice * units[0].askSize;

  for (const unit of units) {
    if (remainingQuote <= 1e-15) break;

    const levelCapacityQuote = unit.askPrice * unit.askSize;
    const spend = Math.min(remainingQuote, levelCapacityQuote);

    remainingQuote -= spend;
    quoteSpent += spend;
    grossBase += spend / unit.askPrice;

    if (unit === units[0]) {
      bestLevelQuoteSpent += spend;
    }
  }

  if (remainingQuote > Math.max(quoteAmount * 1e-12, 1e-12)) {
    return insufficientDepth({
      inputAmount: quoteAmount,
      consumedInputAmount: quoteSpent,
      residualInputAmount: remainingQuote,
      bestLevelTouchRatio: bestLevelCapacityQuote > 0 ? bestLevelQuoteSpent / bestLevelCapacityQuote : 1,
      residualAfterOrder: Math.max(0, bestLevelCapacityQuote - bestLevelQuoteSpent),
    });
  }

  const averagePrice = quoteSpent / grossBase;
  const expectedSlippageBps = ((averagePrice / units[0].askPrice) - 1) * 10000;

  return {
    available: true,
    action: "BUY_BASE_WITH_QUOTE",
    usedSide: "ask",
    inputAmount: quoteAmount,
    consumedInputAmount: quoteSpent,
    outputAmount: grossBase * (1 - feeRate),
    grossOutputAmount: grossBase,
    averagePrice,
    bestPrice: units[0].askPrice,
    expectedSlippageBps,
    bestLevelTouchRatio: bestLevelCapacityQuote > 0 ? bestLevelQuoteSpent / bestLevelCapacityQuote : 1,
    residualAfterOrder: Math.max(0, bestLevelCapacityQuote - bestLevelQuoteSpent),
    residualAsset: "quote",
  };
}

function simulateSellBaseForQuote(orderbook, baseAmount, feeRate = 0) {
  if (!(baseAmount >= 0)) {
    throw new Error(`Invalid base amount: ${baseAmount}`);
  }

  const units = normalizeUnits(orderbook);

  if (units.length === 0) {
    return insufficientDepth({ residualInputAmount: baseAmount });
  }

  let remainingBase = baseAmount;
  let baseSold = 0;
  let grossQuote = 0;
  let bestLevelBaseSold = 0;
  const bestLevelCapacityBase = units[0].bidSize;

  for (const unit of units) {
    if (remainingBase <= 1e-15) break;

    const sell = Math.min(remainingBase, unit.bidSize);

    remainingBase -= sell;
    baseSold += sell;
    grossQuote += sell * unit.bidPrice;

    if (unit === units[0]) {
      bestLevelBaseSold += sell;
    }
  }

  if (remainingBase > Math.max(baseAmount * 1e-12, 1e-12)) {
    return insufficientDepth({
      inputAmount: baseAmount,
      consumedInputAmount: baseSold,
      residualInputAmount: remainingBase,
      bestLevelTouchRatio: bestLevelCapacityBase > 0 ? bestLevelBaseSold / bestLevelCapacityBase : 1,
      residualAfterOrder: Math.max(0, bestLevelCapacityBase - bestLevelBaseSold),
    });
  }

  const averagePrice = grossQuote / baseSold;
  const expectedSlippageBps = (1 - (averagePrice / units[0].bidPrice)) * 10000;

  return {
    available: true,
    action: "SELL_BASE_FOR_QUOTE",
    usedSide: "bid",
    inputAmount: baseAmount,
    consumedInputAmount: baseSold,
    outputAmount: grossQuote * (1 - feeRate),
    grossOutputAmount: grossQuote,
    averagePrice,
    bestPrice: units[0].bidPrice,
    expectedSlippageBps,
    bestLevelTouchRatio: bestLevelCapacityBase > 0 ? bestLevelBaseSold / bestLevelCapacityBase : 1,
    residualAfterOrder: Math.max(0, bestLevelCapacityBase - bestLevelBaseSold),
    residualAsset: "base",
  };
}

function orderbookForMarket(orderbooks, market) {
  return orderbooks instanceof Map ? orderbooks.get(market) : orderbooks[market];
}

function policyForMarket(feePolicyByMarket, market) {
  if (!feePolicyByMarket) return null;
  if (feePolicyByMarket instanceof Map) return feePolicyByMarket.get(market) || null;
  return feePolicyByMarket[market] || null;
}

function feeFromPolicy(policy, side, options = {}) {
  if (!policy) return null;
  const maker = options.expectedMaker === true || options.maker === true;
  const value = side === "bid"
    ? (maker ? policy.makerBidFee : policy.bidFee)
    : (maker ? policy.makerAskFee : policy.askFee);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveLegFeeRate(step, side, fallbackFeeRate, options = {}) {
  if (typeof options.resolveLegFee === "function") {
    const resolved = Number(options.resolveLegFee({
      market: step.market,
      side,
      orderType: options.orderType || "limit",
      timeInForce: options.timeInForce || "ioc",
      expectedMaker: options.expectedMaker === true,
      step,
    }));

    if (Number.isFinite(resolved)) {
      return resolved;
    }
  }

  const policyFee = feeFromPolicy(policyForMarket(options.feePolicyByMarket, step.market), side, options);

  if (policyFee !== null) {
    return policyFee;
  }

  return Number(fallbackFeeRate || 0);
}

function orderbookTimestamp(orderbook) {
  const timestamp = Number(orderbook && (orderbook.timestamp || orderbook.tms));

  return Number.isFinite(timestamp) ? timestamp : null;
}

function simulateCycleWithDepth(cycle, orderbooks, startAmount, feeRate = 0, options = {}) {
  let amount = startAmount;
  const legs = [];
  const nowMs = options.nowMs || Date.now();

  for (const step of cycle.steps) {
    const orderbook = orderbookForMarket(orderbooks, step.market);

    if (!orderbook) {
      return {
        available: false,
        rejectionCode: REJECTION_REASONS.DEPTH_INSUFFICIENT,
        rejectionReason: `Missing validation orderbook for ${step.market}`,
        outputAmount: null,
        profitRate: null,
        legs,
      };
    }

    const timestamp = orderbookTimestamp(orderbook);
    if (
      options.staleOrderbookMs &&
      (!timestamp || nowMs - timestamp > options.staleOrderbookMs)
    ) {
      return {
        available: false,
        rejectionCode: REJECTION_REASONS.STALE_ORDERBOOK,
        rejectionReason: `Stale validation orderbook for ${step.market}`,
        outputAmount: null,
        profitRate: null,
        legs,
      };
    }

    const { quote, base } = parseMarket(step.market);
    let simulated;

    let feeSide;
    let legFeeRate;

    if (step.fromAsset === quote && step.toAsset === base) {
      feeSide = "bid";
      legFeeRate = resolveLegFeeRate(step, feeSide, feeRate, options);
      simulated = simulateBuyWithQuote(orderbook, amount, legFeeRate);
    } else if (step.fromAsset === base && step.toAsset === quote) {
      feeSide = "ask";
      legFeeRate = resolveLegFeeRate(step, feeSide, feeRate, options);
      simulated = simulateSellBaseForQuote(orderbook, amount, legFeeRate);
    } else {
      return {
        available: false,
        rejectionCode: REJECTION_REASONS.DEPTH_INSUFFICIENT,
        rejectionReason: `Market ${step.market} cannot convert ${step.fromAsset} -> ${step.toAsset}`,
        outputAmount: null,
        profitRate: null,
        legs,
      };
    }

    const leg = {
      legIndex: step.index + 1,
      fromAsset: step.fromAsset,
      toAsset: step.toAsset,
      market: step.market,
      marketCode: step.market,
      inputAmount: amount,
      outputAmount: simulated.outputAmount,
      action: simulated.action,
      usedSide: simulated.usedSide,
      feeSide,
      feeRate: legFeeRate,
      averagePrice: simulated.averagePrice,
      bestPrice: simulated.bestPrice,
      expectedSlippageBps: simulated.expectedSlippageBps,
      bestLevelTouchRatio: simulated.bestLevelTouchRatio,
      residualAfterOrder: simulated.residualAfterOrder,
      residualAsset: step.fromAsset,
      orderbookTimestampMs: timestamp,
      orderbookAgeMs: timestamp === null ? null : Math.max(0, nowMs - timestamp),
    };

    legs.push(leg);

    if (!simulated.available) {
      return {
        available: false,
        rejectionCode: simulated.rejectionCode,
        rejectionReason: `Insufficient validation depth for ${step.market}`,
        outputAmount: null,
        profitRate: null,
        limitingLeg: leg.legIndex,
        limitingMarket: step.market,
        legs,
      };
    }

    amount = simulated.outputAmount;
  }

  return {
    available: true,
    rejectionCode: null,
    rejectionReason: null,
    startAmount,
    outputAmount: amount,
    multiplier: startAmount > 0 ? amount / startAmount : null,
    profitRate: startAmount > 0 ? amount / startAmount - 1 : null,
    legs,
  };
}

module.exports = {
  normalizeUnits,
  simulateBuyWithQuote,
  simulateSellBaseForQuote,
  simulateCycleWithDepth,
  resolveLegFeeRate,
};
