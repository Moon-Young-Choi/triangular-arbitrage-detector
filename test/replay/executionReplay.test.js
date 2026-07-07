const test = require("node:test");
const assert = require("node:assert/strict");
const { replayExecutionPlans } = require("../../src/replay/replayEngine");
const { replayRealExecution } = require("../../src/replay/executionReplay");

const cycle = {
  triangleId: "BTC|ETH|KRW",
  cycleId: "BTC|ETH|KRW:canonical:KRW",
  routeVariantId: "BTC|ETH|KRW:canonical:KRW",
  startAsset: "KRW",
  endAsset: "KRW",
  direction: "canonical",
  directionLabel: "Canonical",
  route: ["KRW", "BTC", "ETH", "KRW"],
  routeLabel: "KRW -> BTC -> ETH -> KRW",
  markets: ["KRW-BTC", "BTC-ETH", "KRW-ETH"],
  steps: [
    { index: 0, fromAsset: "KRW", toAsset: "BTC", market: "KRW-BTC" },
    { index: 1, fromAsset: "BTC", toAsset: "ETH", market: "BTC-ETH" },
    { index: 2, fromAsset: "ETH", toAsset: "KRW", market: "KRW-ETH" },
  ],
};

function entry(market, timestamp, askPrice, bidPrice, askSize = 1000, bidSize = 1000) {
  return {
    market,
    timestamp,
    receivedAt: timestamp,
    orderbook_units: [{
      ask_price: askPrice,
      bid_price: bidPrice,
      ask_size: askSize,
      bid_size: bidSize,
    }],
  };
}

function tape() {
  return [
    entry("KRW-BTC", 1000, 100, 99),
    entry("BTC-ETH", 1000, 0.1, 0.09),
    entry("KRW-ETH", 1000, 18, 12),
  ];
}

const marketPolicyByMarket = {
  "KRW-BTC": { bid: { minTotal: 0, maxTotal: 1000000000 }, ask: { minTotal: 0, maxTotal: 1000000000 } },
  "BTC-ETH": { bid: { minTotal: 0, maxTotal: 1000 }, ask: { minTotal: 0, maxTotal: 1000 } },
  "KRW-ETH": { bid: { minTotal: 0, maxTotal: 1000000000 }, ask: { minTotal: 0, maxTotal: 1000000000 } },
};

function runtimeConfig(overrides = {}) {
  return {
    runMode: "DRY_RUN",
    executionMode: "LIMIT_IOC_AT_OBSERVED_BEST",
    activeStrategyId: "depthAwareBestIoc",
    executionPolicy: {
      partialFillPolicy: "CONTINUE_IF_ABOVE_MIN",
      realRunLimits: {},
      marketDataGuards: {},
      executionGuards: {
        maxOrderAckMs: 500,
        maxReconciliationMs: 3000,
      },
      ...(overrides.executionPolicy || {}),
    },
    candidateValidation: {
      startAmountByAsset: { KRW: 100 },
      minOrderAmountByAsset: { KRW: 1, BTC: 0, ETH: 0 },
      maxTouchRatioPerBestLevel: 1,
      minResidualRatioPerBestLevel: 0,
      minResidualAbsoluteByAsset: { KRW: 0, BTC: 0, ETH: 0 },
      minNetProfitRate: 0,
      ...(overrides.candidateValidation || {}),
    },
    marketPolicyByMarket,
  };
}

function acceptedPlan(config = runtimeConfig()) {
  const replay = replayExecutionPlans({
    cycles: [cycle],
    tape: tape(),
    runtimeConfig: config,
    nowMs: 1000,
    staleOrderbookMs: 5000,
  });

  assert.equal(replay.executionPlans.length, 1);
  return replay.executionPlans[0];
}

test("execution replay reproduces partial fill continuation", async () => {
  const result = await replayRealExecution(acceptedPlan(), {
    runtimeConfig: runtimeConfig(),
    scenario: {
      legs: [
        { fillRatio: 0.5, source: "private-ws", privateWsFillDelayMs: 2 },
        { fillRatio: 1 },
        { fillRatio: 1 },
      ],
    },
  });

  assert.equal(result.result.ok, true);
  assert.equal(result.replayEvents.filter((event) => event.type === "replay.order_submitted").length, 3);
  assert.equal(result.logEvents.some((event) => event.type === "order.partial" && event.legIndex === 1), true);
});

test("execution replay reproduces zero fill abort", async () => {
  const result = await replayRealExecution(acceptedPlan(), {
    runtimeConfig: runtimeConfig(),
    scenario: {
      legs: [{ fillRatio: 0 }],
    },
  });

  assert.equal(result.result.ok, false);
  assert.equal(result.result.reason, "ZERO_FILL");
  assert.equal(result.result.residualAsset, "KRW");
  assert.equal(result.result.actualAmount, 100);
  assert.equal(result.replayEvents.filter((event) => event.type === "replay.order_submitted").length, 1);
});

test("execution replay reproduces REST ack latency guard", async () => {
  const config = runtimeConfig({
    executionPolicy: {
      executionGuards: {
        maxOrderAckMs: 1,
        maxReconciliationMs: 3000,
      },
    },
  });
  const result = await replayRealExecution(acceptedPlan(config), {
    runtimeConfig: config,
    scenario: {
      legs: [{ ackDelayMs: 5, fillRatio: 1 }],
    },
  });

  assert.equal(result.result.ok, false);
  assert.equal(result.result.reason, "ORDER_ACK_LATENCY");
  assert.equal(result.replayEvents.filter((event) => event.type === "replay.order_submitted").length, 1);
  assert.equal(result.logEvents.some((event) => event.type === "risk.rejected"), true);
});

test("execution replay reproduces delayed private WS with REST fallback", async () => {
  const result = await replayRealExecution(acceptedPlan(), {
    runtimeConfig: runtimeConfig(),
    scenario: {
      legs: [
        { source: "rest-query", reconciliationDelayMs: 20, fillRatio: 1 },
        { source: "private-ws", privateWsFillDelayMs: 2, fillRatio: 1 },
        { source: "private-ws", privateWsFillDelayMs: 2, fillRatio: 1 },
      ],
    },
  });

  assert.equal(result.result.ok, true);
  assert.equal(result.replayEvents.some((event) => event.type === "replay.order_reconciled" && event.source === "rest-query"), true);
  assert.equal(result.logEvents.some((event) => event.kind === "fills" && event.source === "rest-query"), true);
});

test("execution replay reproduces private WS disconnected guard", async () => {
  const result = await replayRealExecution(acceptedPlan(), {
    runtimeConfig: runtimeConfig(),
    privateWsConnected: false,
  });

  assert.equal(result.result.ok, false);
  assert.equal(result.result.reason, "PRIVATE_WS_DISCONNECTED");
  assert.equal(result.replayEvents.length, 0);
});
