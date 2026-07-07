const { parseMarket } = require("./marketGraph");
const { REJECTION_REASONS } = require("../core/rejectionReasons");
const { defaultFeePolicyForMarket } = require("../exchanges/upbit/feeModel");
const {
  policyForMarket: normalizeMarketPolicyForMarket,
  validateOrderTotal,
} = require("../exchanges/upbit/marketPolicy");

function normalizeUnits(orderbook, options = {}) {
  const maxDepthLevels = Number(options.maxDepthLevels || 0);
  const rawUnits = orderbook && Array.isArray(orderbook.orderbook_units) ? orderbook.orderbook_units : [];
  const units = maxDepthLevels > 0 ? rawUnits.slice(0, maxDepthLevels) : rawUnits;

  return units
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

function simulateBuyWithQuote(orderbook, quoteAmount, feeRate = 0, options = {}) {
  if (!(quoteAmount >= 0)) {
    throw new Error(`Invalid quote amount: ${quoteAmount}`);
  }

  const units = normalizeUnits(orderbook, options);

  if (units.length === 0) {
    return insufficientDepth({ residualInputAmount: quoteAmount });
  }

  const tradeBudget = feeRate > 0 ? quoteAmount / (1 + feeRate) : quoteAmount;
  let remainingQuote = tradeBudget;
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

  if (remainingQuote > Math.max(tradeBudget * 1e-12, 1e-12)) {
    const feeAmount = quoteSpent * feeRate;
    return insufficientDepth({
      inputAmount: quoteAmount,
      consumedInputAmount: quoteSpent + feeAmount,
      tradeAmount: quoteSpent,
      feeAmount,
      feeAsset: "quote",
      residualInputAmount: Math.max(0, quoteAmount - quoteSpent - feeAmount),
      bestLevelTouchRatio: bestLevelCapacityQuote > 0 ? bestLevelQuoteSpent / bestLevelCapacityQuote : 1,
      residualAfterOrder: Math.max(0, bestLevelCapacityQuote - bestLevelQuoteSpent),
    });
  }

  const averagePrice = quoteSpent / grossBase;
  const expectedSlippageBps = ((averagePrice / units[0].askPrice) - 1) * 10000;
  const feeAmount = quoteSpent * feeRate;

  return {
    available: true,
    action: "BUY_BASE_WITH_QUOTE",
    usedSide: "ask",
    inputAmount: quoteAmount,
    consumedInputAmount: quoteSpent + feeAmount,
    tradeAmount: quoteSpent,
    feeAmount,
    feeAsset: "quote",
    outputAmount: grossBase,
    grossOutputAmount: grossBase,
    netOutputAmount: grossBase,
    averagePrice,
    bestPrice: units[0].askPrice,
    expectedSlippageBps,
    bestLevelTouchRatio: bestLevelCapacityQuote > 0 ? bestLevelQuoteSpent / bestLevelCapacityQuote : 1,
    residualAfterOrder: Math.max(0, bestLevelCapacityQuote - bestLevelQuoteSpent),
    residualAsset: "quote",
  };
}

function simulateSellBaseForQuote(orderbook, baseAmount, feeRate = 0, options = {}) {
  if (!(baseAmount >= 0)) {
    throw new Error(`Invalid base amount: ${baseAmount}`);
  }

  const units = normalizeUnits(orderbook, options);

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
  const feeAmount = grossQuote * feeRate;

  return {
    available: true,
    action: "SELL_BASE_FOR_QUOTE",
    usedSide: "bid",
    inputAmount: baseAmount,
    consumedInputAmount: baseSold,
    tradeAmount: grossQuote,
    feeAmount,
    feeAsset: "quote",
    outputAmount: grossQuote - feeAmount,
    grossOutputAmount: grossQuote,
    netOutputAmount: grossQuote - feeAmount,
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

function marketPolicyForMarket(marketPolicyByMarket, market) {
  if (!marketPolicyByMarket) return normalizeMarketPolicyForMarket(market);
  const policy = marketPolicyByMarket instanceof Map
    ? marketPolicyByMarket.get(market)
    : marketPolicyByMarket[market];
  return normalizeMarketPolicyForMarket(market, policy || null);
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

  if (options.useDefaultFeePolicy === true) {
    const defaultFee = feeFromPolicy(defaultFeePolicyForMarket(step.market), side, options);

    if (defaultFee !== null) {
      return defaultFee;
    }
  }

  return Number(fallbackFeeRate || 0);
}

function orderbookTimestamp(orderbook) {
  const timestamp = Number(orderbook && (orderbook.timestamp || orderbook.tms));

  return Number.isFinite(timestamp) ? timestamp : null;
}

function validationOrderForLeg(step, side, simulated) {
  const price = simulated.averagePrice;
  const volume = side === "bid"
    ? simulated.grossOutputAmount
    : simulated.consumedInputAmount;

  return {
    market: step.market,
    side,
    ord_type: "limit",
    price,
    volume,
    observedBestPrice: simulated.bestPrice,
  };
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
      simulated = simulateBuyWithQuote(orderbook, amount, legFeeRate, {
        maxDepthLevels: options.maxDepthLevels,
      });
    } else if (step.fromAsset === base && step.toAsset === quote) {
      feeSide = "ask";
      legFeeRate = resolveLegFeeRate(step, feeSide, feeRate, options);
      simulated = simulateSellBaseForQuote(orderbook, amount, legFeeRate, {
        maxDepthLevels: options.maxDepthLevels,
      });
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
      feeAmount: simulated.feeAmount,
      feeAsset: simulated.feeAsset === "quote" ? parseMarket(step.market).quote : simulated.feeAsset,
      tradeAmount: simulated.tradeAmount,
      grossOutputAmount: simulated.grossOutputAmount,
      netOutputAmount: simulated.netOutputAmount,
      averagePrice: simulated.averagePrice,
      bestPrice: simulated.bestPrice,
      expectedSlippageBps: simulated.expectedSlippageBps,
      bestLevelTouchRatio: simulated.bestLevelTouchRatio,
      residualAfterOrder: simulated.residualAfterOrder,
      residualAsset: step.fromAsset,
      orderbookTimestampMs: timestamp,
      orderbookAgeMs: timestamp === null ? null : Math.max(0, nowMs - timestamp),
    };

    if (simulated.available && options.validateOrderTotals === true) {
      const totalCheck = validateOrderTotal(
        validationOrderForLeg(step, feeSide, simulated),
        marketPolicyForMarket(options.marketPolicyByMarket, step.market),
      );
      leg.orderTotal = totalCheck.total;
      leg.minOrderTotal = totalCheck.minTotal;
      leg.maxOrderTotal = totalCheck.maxTotal;

      if (!totalCheck.ok) {
        legs.push(leg);
        return {
          available: false,
          rejectionCode: totalCheck.rejectionReason,
          rejectionReason: totalCheck.rejectionReason,
          outputAmount: null,
          profitRate: null,
          limitingLeg: leg.legIndex,
          limitingMarket: step.market,
          legs,
        };
      }
    }

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
    feeSummary: summarizeFeeByAsset(legs),
    legs,
  };
}

function summarizeFeeByAsset(legs = []) {
  const totalByAsset = {};

  for (const leg of legs) {
    const asset = leg.feeAsset;
    const amount = Number(leg.feeAmount);
    if (!asset || !Number.isFinite(amount)) continue;
    totalByAsset[asset] = (totalByAsset[asset] || 0) + amount;
  }

  return {
    legs: legs.length,
    totalByAsset,
  };
}

module.exports = {
  normalizeUnits,
  simulateBuyWithQuote,
  simulateSellBaseForQuote,
  simulateCycleWithDepth,
  resolveLegFeeRate,
  summarizeFeeByAsset,
};
