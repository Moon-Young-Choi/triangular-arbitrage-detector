const test = require("node:test");
const assert = require("node:assert/strict");
const { buildExecutionPlan, legTimestampSkewMs } = require("../src/execution/executionPlan");

const cycle = {
  cycleId: "cycle-1",
  startAsset: "KRW",
  steps: [
    { index: 0, fromAsset: "KRW", toAsset: "BTC", market: "KRW-BTC" },
    { index: 1, fromAsset: "BTC", toAsset: "ETH", market: "BTC-ETH" },
  ],
};

test("execution plan preserves strategy, depth, expected profit, and latency fields", () => {
  const plan = buildExecutionPlan({
    cycle,
    row: {
      cycleId: "cycle-1",
      startAsset: "KRW",
      strategyId: "depthAwareBestIoc",
      executableStartAmount: 10000,
      netMultiplier: 1.01,
      netProfitRate: 0.01,
      oldestLegAgeMs: 80,
      legTimestamps: [1000, 1120, 1090],
      latency: {
        upbitToServerMs: 7,
        estimatedEndToDisplayMs: 25,
      },
      calculatedAtEpochMs: 2000,
      validationStatus: "accepted",
      validationReason: "ACCEPTED",
    },
    validationOrderbooks: new Map([
      ["KRW-BTC", { market: "KRW-BTC" }],
      ["BTC-ETH", { market: "BTC-ETH" }],
    ]),
    runtimeConfig: {
      runMode: "DRY_RUN",
      executionMode: "LIMIT_IOC_AT_OBSERVED_BEST",
      activeStrategyId: "depthAwareBestIoc",
      candidateValidation: {},
    },
    feeRate: 0.0005,
    staleOrderbookMs: 1000,
    engineState: "RUNNING",
    nowMs: 2500,
  });

  assert.equal(plan.mode, "DRY_RUN");
  assert.equal(plan.strategyId, "depthAwareBestIoc");
  assert.equal(plan.expectedNetProfit, 100);
  assert.equal(plan.legTimestampSkewMs, 120);
  assert.equal(plan.exchangeToServerLatencyMs, 7);
  assert.equal(plan.decisionAgeMs, 500);
  assert.equal(plan.validationOrderbooks.get("KRW-BTC").market, "KRW-BTC");
});

test("leg timestamp skew handles incomplete timestamp sets", () => {
  assert.equal(legTimestampSkewMs([100, 150, 125]), 50);
  assert.equal(legTimestampSkewMs([100]), 0);
  assert.equal(legTimestampSkewMs([]), 0);
});
