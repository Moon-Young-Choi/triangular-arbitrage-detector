const { parseMarket } = require("./marketGraph");
const { resolveLegFeeRate } = require("./depthSimulator");

function getBestOrderbookUnit(orderbook) {
  const unit = orderbook && Array.isArray(orderbook.orderbook_units) && orderbook.orderbook_units[0];

  if (!unit) {
    throw new Error("Missing best orderbook unit");
  }

  if (!(unit.ask_price > 0) || !(unit.bid_price > 0)) {
    throw new Error("Invalid best bid/ask prices");
  }

  return unit;
}

function getOrderbookTimestamp(orderbook) {
  const timestamp = Number(orderbook && (orderbook.timestamp || orderbook.tms));

  return Number.isFinite(timestamp) ? timestamp : null;
}

function convertAmountDetailed(
  amount,
  fromAsset,
  toAsset,
  marketCode,
  orderbook,
  feeRate = 0,
  options = {},
) {
  if (!(amount >= 0)) {
    throw new Error(`Invalid amount: ${amount}`);
  }

  if (!(feeRate >= 0) || feeRate >= 1) {
    throw new Error(`Invalid fee rate: ${feeRate}`);
  }

  const { quote, base } = parseMarket(marketCode);
  const unit = getBestOrderbookUnit(orderbook);
  const timestamp = getOrderbookTimestamp(orderbook);
  const nowMs = options.nowMs || Date.now();
  let action;
  let usedSide;
  let usedPrice;
  let feeSide;
  let feeAmount;
  let feeAsset;
  let tradeAmount;
  let grossOutputAmount;
  let outputAmount;

  if (fromAsset === quote && toAsset === base) {
    action = "BUY_BASE_WITH_QUOTE";
    usedSide = "ask";
    feeSide = "bid";
    usedPrice = Number(unit.ask_price);
    tradeAmount = feeRate > 0 ? amount / (1 + feeRate) : amount;
    feeAmount = tradeAmount * feeRate;
    feeAsset = quote;
    grossOutputAmount = tradeAmount / usedPrice;
    outputAmount = grossOutputAmount;
  } else if (fromAsset === base && toAsset === quote) {
    action = "SELL_BASE_FOR_QUOTE";
    usedSide = "bid";
    feeSide = "ask";
    usedPrice = Number(unit.bid_price);
    tradeAmount = amount * usedPrice;
    feeAmount = tradeAmount * feeRate;
    feeAsset = quote;
    grossOutputAmount = tradeAmount;
    outputAmount = tradeAmount - feeAmount;
  } else {
    throw new Error(`Market ${marketCode} cannot convert ${fromAsset} -> ${toAsset}`);
  }

  return {
    outputAmount,
    leg: {
      legIndex: options.legIndex || 0,
      fromAsset,
      toAsset,
      marketCode,
      quote,
      base,
      action,
      usedSide,
      feeSide,
      feeRate,
      feeAmount,
      feeAsset,
      usedPrice,
      askPrice: Number(unit.ask_price),
      bidPrice: Number(unit.bid_price),
      askSize: Number(unit.ask_size),
      bidSize: Number(unit.bid_size),
      inputAmount: amount,
      outputAmount,
      tradeAmount,
      grossOutputAmount,
      netOutputAmount: outputAmount,
      orderbookTimestampMs: timestamp,
      orderbookAgeMs: timestamp === null ? null : Math.max(0, nowMs - timestamp),
      streamType: orderbook.streamType || orderbook.stream_type || null,
    },
  };
}

function convertAmount(amount, fromAsset, toAsset, marketCode, orderbook, feeRate = 0) {
  return convertAmountDetailed(amount, fromAsset, toAsset, marketCode, orderbook, feeRate).outputAmount;
}

function calculateCycleMultiplier(cycle, pairMap, orderbooks, feeRate = 0, options = {}) {
  let amount = 1;

  try {
    const conversions = [];

    for (const step of cycle.steps) {
      const orderbook = orderbooks instanceof Map ? orderbooks.get(step.market) : orderbooks[step.market];

      if (!orderbook) {
        return {
          available: false,
          unavailableReason: `Missing orderbook for ${step.market}`,
          multiplier: null,
          profitRate: null,
          conversions,
        };
      }

      const amountIn = amount;
      const { quote, base } = parseMarket(step.market);
      let feeSide;

      if (step.fromAsset === quote && step.toAsset === base) {
        feeSide = "bid";
      } else if (step.fromAsset === base && step.toAsset === quote) {
        feeSide = "ask";
      }

      const converted = convertAmountDetailed(
        amount,
        step.fromAsset,
        step.toAsset,
        step.market,
        orderbook,
        resolveLegFeeRate(step, feeSide, feeRate, options),
        {
          legIndex: step.index + 1,
          nowMs: options.nowMs,
        },
      );
      amount = converted.outputAmount;

      conversions.push({
        ...converted.leg,
        fromAsset: step.fromAsset,
        toAsset: step.toAsset,
        market: step.market,
        amountIn,
        amountOut: amount,
      });
    }

    return {
      available: true,
      unavailableReason: null,
      multiplier: amount,
      profitRate: amount - 1,
      conversions,
    };
  } catch (error) {
    return {
      available: false,
      unavailableReason: error.message,
      multiplier: null,
      profitRate: null,
      conversions: [],
    };
  }
}

module.exports = {
  convertAmount,
  convertAmountDetailed,
  calculateCycleMultiplier,
};
