const { parseMarket } = require("./marketGraph");

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

function convertAmount(amount, fromAsset, toAsset, marketCode, orderbook, feeRate = 0) {
  if (!(amount >= 0)) {
    throw new Error(`Invalid amount: ${amount}`);
  }

  if (!(feeRate >= 0) || feeRate >= 1) {
    throw new Error(`Invalid fee rate: ${feeRate}`);
  }

  const { quote, base } = parseMarket(marketCode);
  const unit = getBestOrderbookUnit(orderbook);
  const feeMultiplier = 1 - feeRate;

  if (fromAsset === quote && toAsset === base) {
    return amount / unit.ask_price * feeMultiplier;
  }

  if (fromAsset === base && toAsset === quote) {
    return amount * unit.bid_price * feeMultiplier;
  }

  throw new Error(`Market ${marketCode} cannot convert ${fromAsset} -> ${toAsset}`);
}

function calculateCycleMultiplier(cycle, pairMap, orderbooks, feeRate = 0) {
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
      amount = convertAmount(amount, step.fromAsset, step.toAsset, step.market, orderbook, feeRate);

      conversions.push({
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
  calculateCycleMultiplier,
};
