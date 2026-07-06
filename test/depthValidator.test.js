const test = require("node:test");
const assert = require("node:assert/strict");
const {
  simulateBuyWithQuote,
  simulateSellBaseForQuote,
  simulateCycleWithDepth,
} = require("../src/core/depthSimulator");
const {
  limitingLegFor,
  maxExecutableStartAmount,
  mergeValidationConfig,
} = require("../src/core/liquidityPolicy");
const { REJECTION_REASONS } = require("../src/core/rejectionReasons");
const { validateDepthAwareCandidate } = require("../src/core/candidateValidator");

const cycle = {
  cycleId: "BTC|ETH|KRW:canonical:KRW",
  startAsset: "KRW",
  steps: [
    { index: 0, fromAsset: "KRW", toAsset: "BTC", market: "KRW-BTC" },
    { index: 1, fromAsset: "BTC", toAsset: "ETH", market: "BTC-ETH" },
    { index: 2, fromAsset: "ETH", toAsset: "KRW", market: "KRW-ETH" },
  ],
};

function orderbook(market, units, metadata = {}) {
  return {
    market,
    timestamp: metadata.timestamp ?? 1000,
    exchangeTimestampMs: metadata.exchangeTimestampMs ?? metadata.timestamp ?? 1000,
    receivedAt: metadata.receivedAt ?? 1000,
    serverReceivedAtMs: metadata.serverReceivedAtMs ?? metadata.receivedAt ?? 1000,
    streamType: metadata.streamType || "REALTIME",
    orderbookUnit: metadata.orderbookUnit,
    unit: metadata.unit,
    orderbookLevel: metadata.orderbookLevel,
    traceId: metadata.traceId,
    localSequence: metadata.localSequence,
    orderbook_units: units,
  };
}

function liquidOrderbooks(metadata = {}) {
  return new Map([
    ["KRW-BTC", orderbook("KRW-BTC", [{ ask_price: 100, bid_price: 99, ask_size: 100, bid_size: 100 }], metadata["KRW-BTC"] || metadata)],
    ["BTC-ETH", orderbook("BTC-ETH", [{ ask_price: 0.1, bid_price: 0.09, ask_size: 100, bid_size: 100 }], metadata["BTC-ETH"] || metadata)],
    ["KRW-ETH", orderbook("KRW-ETH", [{ ask_price: 21, bid_price: 20, ask_size: 100, bid_size: 100 }], metadata["KRW-ETH"] || metadata)],
  ]);
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

test("liquidity policy merges validation config and calculates limiting best-level use", () => {
  const config = mergeValidationConfig({
    maxTouchRatioPerBestLevel: 0.25,
    minResidualAbsoluteByAsset: { KRW: 1000 },
  });
  const legs = [
    {
      legIndex: 1,
      market: "KRW-BTC",
      bestLevelTouchRatio: 0.2,
      residualAfterOrder: 5000,
      residualAsset: "KRW",
    },
    {
      legIndex: 2,
      market: "BTC-ETH",
      bestLevelTouchRatio: 0.5,
      residualAfterOrder: 10,
      residualAsset: "BTC",
    },
  ];

  assert.equal(config.minOrderAmountByAsset.KRW, 5000);
  assert.equal(config.maxTouchRatioPerBestLevel, 0.25);
  assert.equal(limitingLegFor(legs, config).market, "BTC-ETH");
  assert.equal(maxExecutableStartAmount(10000, legs, config.maxTouchRatioPerBestLevel), 5000);
  assert.equal(REJECTION_REASONS.BEST_LEVEL_OVERCONSUMPTION, "BEST_LEVEL_OVERCONSUMPTION");
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

  assert.equal(validation.validationReason, REJECTION_REASONS.DEPTH_INSUFFICIENT);
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

  assert.equal(validation.validationReason, REJECTION_REASONS.BEST_LEVEL_OVERCONSUMPTION);
  assert.equal(validation.accepted, false);
  assert.equal(validation.limitingLeg, 1);
  assert.equal(validation.limitingMarket, "KRW-BTC");
  assert.equal(validation.bestLevelTouchRatio, 0.5);
  assert.equal(validation.maxExecutableStartAmount, 6000);
});

test("depth simulation and candidate validation use market and side specific fee policies", () => {
  const feePolicyByMarket = new Map([
    ["KRW-BTC", { bidFee: 0.01, askFee: 0.04, makerBidFee: 0, makerAskFee: 0 }],
    ["BTC-ETH", { bidFee: 0.02, askFee: 0.04, makerBidFee: 0, makerAskFee: 0 }],
    ["KRW-ETH", { bidFee: 0.04, askFee: 0.03, makerBidFee: 0, makerAskFee: 0 }],
  ]);
  const orderbooks = new Map([
    ["KRW-BTC", orderbook("KRW-BTC", [{ ask_price: 100, bid_price: 99, ask_size: 100, bid_size: 100 }])],
    ["BTC-ETH", orderbook("BTC-ETH", [{ ask_price: 0.1, bid_price: 0.09, ask_size: 100, bid_size: 100 }])],
    ["KRW-ETH", orderbook("KRW-ETH", [{ ask_price: 21, bid_price: 20, ask_size: 100, bid_size: 100 }])],
  ]);
  const simulated = simulateCycleWithDepth(cycle, orderbooks, 100, 0, {
    feePolicyByMarket,
    nowMs: 1000,
  });
  const validation = validateDepthAwareCandidate(cycle, orderbooks, {
    startAmount: 100,
    feePolicyByMarket,
    nowMs: 1000,
    config: {
      minOrderAmountByAsset: { KRW: 0 },
      maxTouchRatioPerBestLevel: 1,
      minResidualRatioPerBestLevel: 0,
      minResidualAbsoluteByAsset: { KRW: 0, BTC: 0, ETH: 0 },
      minNetProfitRate: 0,
    },
  });

  assert.equal(simulated.available, true);
  assert.equal(Number(simulated.outputAmount.toFixed(6)), 188.2188);
  assert.deepEqual(simulated.legs.map((leg) => leg.feeSide), ["bid", "bid", "ask"]);
  assert.deepEqual(simulated.legs.map((leg) => leg.feeRate), [0.01, 0.02, 0.03]);
  assert.equal(validation.depthLegs[2].feeRate, 0.03);
});

test("candidate validation rejects observation and validation snapshot gap", () => {
  const validation = validateDepthAwareCandidate(cycle, liquidOrderbooks({
    orderbookUnit: 30,
    timestamp: 1000,
    receivedAt: 1300,
    traceId: "validation-gap",
  }), {
    startAmount: 100,
    feeRate: 0,
    nowMs: 1300,
    staleOrderbookMs: 5000,
    observationOrderbooks: liquidOrderbooks({
      orderbookUnit: 5,
      timestamp: 1000,
      receivedAt: 1000,
      traceId: "observation-gap",
    }),
    config: {
      minOrderAmountByAsset: { KRW: 0 },
      maxTouchRatioPerBestLevel: 1,
      minResidualRatioPerBestLevel: 0,
      minResidualAbsoluteByAsset: { KRW: 0, BTC: 0, ETH: 0 },
      minNetProfitRate: 0,
      expectedValidationOrderbookUnit: 30,
      maxObservationValidationGapMs: 100,
    },
  });

  assert.equal(validation.accepted, false);
  assert.equal(validation.validationReason, REJECTION_REASONS.OBSERVATION_VALIDATION_SNAPSHOT_GAP);
  assert.equal(validation.observationValidationGapMs, 300);
  assert.equal(validation.observationValidationGapMarket, "KRW-BTC");
  assert.equal(validation.validationOrderbookSources["KRW-BTC"], "REALTIME");
  assert.equal(validation.validationOrderbookMetadata[0].traceId, "validation-gap");
});

test("candidate validation rejects validation leg timestamp skew", () => {
  const validation = validateDepthAwareCandidate(cycle, liquidOrderbooks({
    "KRW-BTC": { orderbookUnit: 30, timestamp: 1000, receivedAt: 1000 },
    "BTC-ETH": { orderbookUnit: 30, timestamp: 1125, receivedAt: 1000 },
    "KRW-ETH": { orderbookUnit: 30, timestamp: 1000, receivedAt: 1000 },
  }), {
    startAmount: 100,
    feeRate: 0,
    nowMs: 1125,
    staleOrderbookMs: 5000,
    config: {
      minOrderAmountByAsset: { KRW: 0 },
      maxTouchRatioPerBestLevel: 1,
      minResidualRatioPerBestLevel: 0,
      minResidualAbsoluteByAsset: { KRW: 0, BTC: 0, ETH: 0 },
      minNetProfitRate: 0,
      expectedValidationOrderbookUnit: 30,
      maxValidationLegTimestampSkewMs: 50,
    },
  });

  assert.equal(validation.accepted, false);
  assert.equal(validation.validationReason, REJECTION_REASONS.VALIDATION_LEG_TIMESTAMP_SKEW);
  assert.equal(validation.validationLegTimestampSkewMs, 125);
});

test("candidate validation rejects non-30 validation unit and grouped orderbooks", () => {
  const wrongUnit = validateDepthAwareCandidate(cycle, liquidOrderbooks({ orderbookUnit: 5 }), {
    startAmount: 100,
    feeRate: 0,
    nowMs: 1000,
    config: {
      minOrderAmountByAsset: { KRW: 0 },
      expectedValidationOrderbookUnit: 30,
    },
  });
  const grouped = validateDepthAwareCandidate(cycle, liquidOrderbooks({ orderbookUnit: 30, orderbookLevel: 100000 }), {
    startAmount: 100,
    feeRate: 0,
    nowMs: 1000,
    config: {
      minOrderAmountByAsset: { KRW: 0 },
      expectedValidationOrderbookUnit: 30,
    },
  });

  assert.equal(wrongUnit.validationReason, REJECTION_REASONS.VALIDATION_DEPTH_UNIT_MISMATCH);
  assert.equal(wrongUnit.limitingMarket, "KRW-BTC");
  assert.equal(grouped.validationReason, REJECTION_REASONS.ORDERBOOK_LEVEL_GROUPING_UNSUPPORTED);
  assert.equal(grouped.limitingMarket, "KRW-BTC");
});
