const test = require("node:test");
const assert = require("node:assert/strict");
const { simulateBuyWithQuote, simulateSellBaseForQuote } = require("../src/lib/depthSimulator");
const { validateDepthAwareCandidate } = require("../src/live/candidateValidator");

const cycle = {
  cycleId: "BTC|ETH|KRW:canonical:KRW",
  startAsset: "KRW",
  steps: [
    { index: 0, fromAsset: "KRW", toAsset: "BTC", market: "KRW-BTC" },
    { index: 1, fromAsset: "BTC", toAsset: "ETH", market: "BTC-ETH" },
    { index: 2, fromAsset: "ETH", toAsset: "KRW", market: "KRW-ETH" },
  ],
};

function orderbook(market, units) {
  return {
    market,
    timestamp: 1000,
    receivedAt: 1000,
    orderbook_units: units,
  };
}

test("depth simulator buys and sells across orderbook levels with fee-adjusted output", () => {
  const buy = simulateBuyWithQuote(orderbook("KRW-BTC", [
    { ask_price: 100, bid_price: 90, ask_size: 1, bid_size: 1 },
    { ask_price: 110, bid_price: 80, ask_size: 1, bid_size: 1 },
  ]), 155, 0.001);
  const sell = simulateSellBaseForQuote(orderbook("KRW-BTC", [
    { ask_price: 100, bid_price: 90, ask_size: 1, bid_size: 1 },
    { ask_price: 110, bid_price: 80, ask_size: 1, bid_size: 1 },
  ]), 1.5, 0.001);

  assert.equal(buy.available, true);
  assert.equal(Number(buy.outputAmount.toFixed(12)), 1.4985);
  assert.equal(sell.available, true);
  assert.equal(Number(sell.outputAmount.toFixed(12)), 129.87);
  assert.equal(buy.bestLevelTouchRatio, 1);
  assert.equal(sell.bestLevelTouchRatio, 1);
});

test("candidate validation rejects insufficient validation depth", () => {
  const validation = validateDepthAwareCandidate(cycle, new Map([
    ["KRW-BTC", orderbook("KRW-BTC", [{ ask_price: 1000000, bid_price: 999000, ask_size: 0.000001, bid_size: 0.000001 }])],
    ["BTC-ETH", orderbook("BTC-ETH", [{ ask_price: 0.1, bid_price: 0.09, ask_size: 1, bid_size: 1 }])],
    ["KRW-ETH", orderbook("KRW-ETH", [{ ask_price: 110000, bid_price: 109000, ask_size: 1, bid_size: 1 }])],
  ]), {
    startAmount: 10000,
    feeRate: 0,
    nowMs: 1000,
    staleOrderbookMs: 5000,
    config: {
      minOrderAmountByAsset: { KRW: 5000 },
      maxTouchRatioPerBestLevel: 1,
      minResidualRatioPerBestLevel: 0,
      minResidualAbsoluteByAsset: { KRW: 0, BTC: 0, ETH: 0 },
      minNetProfitRate: 0,
    },
  });

  assert.equal(validation.validationReason, "DEPTH_INSUFFICIENT");
  assert.equal(validation.accepted, false);
  assert.equal(validation.limitingMarket, "KRW-BTC");
});

test("candidate validation rejects best-level overconsumption and reports limit fields", () => {
  const validation = validateDepthAwareCandidate(cycle, new Map([
    ["KRW-BTC", orderbook("KRW-BTC", [{ ask_price: 1000000, bid_price: 999000, ask_size: 0.02, bid_size: 0.02 }])],
    ["BTC-ETH", orderbook("BTC-ETH", [{ ask_price: 0.1, bid_price: 0.09, ask_size: 1, bid_size: 1 }])],
    ["KRW-ETH", orderbook("KRW-ETH", [{ ask_price: 90000, bid_price: 120000, ask_size: 1, bid_size: 1 }])],
  ]), {
    startAmount: 10000,
    feeRate: 0,
    nowMs: 1000,
    staleOrderbookMs: 5000,
    config: {
      minOrderAmountByAsset: { KRW: 5000 },
      maxTouchRatioPerBestLevel: 0.3,
      minResidualRatioPerBestLevel: 0,
      minResidualAbsoluteByAsset: { KRW: 0, BTC: 0, ETH: 0 },
      minNetProfitRate: 0,
    },
  });

  assert.equal(validation.validationReason, "BEST_LEVEL_OVERCONSUMPTION");
  assert.equal(validation.accepted, false);
  assert.equal(validation.limitingLeg, 1);
  assert.equal(validation.limitingMarket, "KRW-BTC");
  assert.equal(validation.bestLevelTouchRatio, 0.5);
  assert.equal(validation.maxExecutableStartAmount, 6000);
});
