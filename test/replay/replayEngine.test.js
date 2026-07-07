const test = require("node:test");
const assert = require("node:assert/strict");
const { buildOrderbookTape, latestOrderbooksAt } = require("../../src/replay/orderbookTape");
const { replayExecutionPlans, replayDryRunReport } = require("../../src/replay/replayEngine");
const {
  buildReplayManifest,
  replayFingerprint,
  stableStringify,
} = require("../../src/replay/replayManifest");

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

function profitableTape() {
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

const runtimeConfig = {
  runMode: "DRY_RUN",
  executionMode: "LIMIT_IOC_AT_OBSERVED_BEST",
  activeStrategyId: "depthAwareBestIoc",
  candidateValidation: {
    startAmountByAsset: { KRW: 100 },
    minOrderAmountByAsset: { KRW: 1, BTC: 0, ETH: 0 },
    maxTouchRatioPerBestLevel: 1,
    minResidualRatioPerBestLevel: 0,
    minResidualAbsoluteByAsset: { KRW: 0, BTC: 0, ETH: 0 },
    minNetProfitRate: 0,
  },
  marketPolicyByMarket,
};

test("orderbook tape keeps deterministic latest snapshots by replay time", () => {
  const tape = buildOrderbookTape([
    entry("KRW-BTC", 2000, 110, 109),
    entry("KRW-BTC", 1000, 100, 99),
  ]);
  const latest = latestOrderbooksAt(tape, 1500);

  assert.equal(tape[0].traceId, "replay:KRW-BTC:1000:2");
  assert.equal(latest.get("KRW-BTC").orderbook_units[0].ask_price, 100);
});

test("orderbook tape accepts market orderbook audit log rows", () => {
  const tape = buildOrderbookTape([
    {
      type: "market.orderbook_update",
      exchange: "upbit",
      feedName: "validation",
      market: "KRW-BTC",
      timestamp: "2026-07-06T00:00:00.000Z",
      exchangeTimestampMs: 1000,
      serverReceivedAtMs: 1010,
      unit: 30,
      orderbookLevel: 0,
      traceId: "validation:KRW-BTC:1000:1",
      orderbook_units: [{
        ask_price: 100,
        bid_price: 99,
        ask_size: 1,
        bid_size: 2,
      }],
    },
  ]);

  assert.equal(tape.length, 1);
  assert.equal(tape[0].streamType, "REPLAY");
  assert.equal(tape[0].unit, 30);
  assert.equal(tape[0].orderbookLevel, 0);
  assert.equal(tape[0].traceId, "validation:KRW-BTC:1000:1");
  assert.equal(tape[0].exchangeTimestampMs, 1000);
  assert.equal(tape[0].serverReceivedAtMs, 1010);
  assert.equal(tape[0].orderbook_units[0].ask_price, 100);
});

test("replay generates deterministic accepted execution plans from the same tape", () => {
  const first = replayExecutionPlans({
    cycles: [cycle],
    tape: profitableTape(),
    runtimeConfig,
    nowMs: 1000,
    staleOrderbookMs: 5000,
  });
  const second = replayExecutionPlans({
    cycles: [cycle],
    tape: profitableTape(),
    runtimeConfig,
    nowMs: 1000,
    staleOrderbookMs: 5000,
  });

  assert.equal(first.acceptedCount, 1);
  assert.equal(first.executionPlans.length, 1);
  assert.equal(first.executionPlans[0].cycleId, second.executionPlans[0].cycleId);
  assert.equal(first.executionPlans[0].startAmount, second.executionPlans[0].startAmount);
  assert.equal(first.executionPlans[0].strategyVersion, "0.1.0");
  assert.equal(first.results[0].row.strategyVersion, "0.1.0");
  assert.equal(first.results[0].depthValidation.validationStatus, "accepted");
  assert.equal(first.replayManifest.fingerprints.candidates, second.replayManifest.fingerprints.candidates);
  assert.equal(first.replayManifest.fingerprints.executionPlans, second.replayManifest.fingerprints.executionPlans);
  assert.equal(first.replayManifest.fingerprints.overall, second.replayManifest.fingerprints.overall);
});

test("replay manifest fingerprints deterministic candidates and plans", () => {
  const accepted = replayExecutionPlans({
    cycles: [cycle],
    tape: profitableTape(),
    runtimeConfig,
    nowMs: 1000,
    staleOrderbookMs: 5000,
    includeCanonicalReplayManifest: true,
  });
  const changedTape = replayExecutionPlans({
    cycles: [cycle],
    tape: [
      entry("KRW-BTC", 1000, 100, 99),
      entry("BTC-ETH", 1000, 0.1, 0.09),
      entry("KRW-ETH", 1000, 18, 13),
    ],
    runtimeConfig,
    nowMs: 1000,
    staleOrderbookMs: 5000,
    includeCanonicalReplayManifest: true,
  });
  const rebuiltManifest = buildReplayManifest(accepted, { includeCanonical: true });

  assert.equal(accepted.replayManifest.fingerprints.overall, rebuiltManifest.fingerprints.overall);
  assert.notEqual(
    accepted.replayManifest.fingerprints.candidates,
    changedTape.replayManifest.fingerprints.candidates,
  );
  assert.equal(accepted.replayManifest.canonical.executionPlans[0].executionEnqueuePerfNs, undefined);
  assert.equal(typeof accepted.replayManifest.fingerprints.executionPlans, "string");
  assert.equal(accepted.replayManifest.fingerprints.executionPlans.length, 64);
  assert.equal(replayFingerprint({ b: 1, a: 2 }), replayFingerprint({ a: 2, b: 1 }));
  assert.equal(stableStringify({ b: 1, a: 2 }), "{\"a\":2,\"b\":1}");
});

test("replay reproduces stale and depth rejections", () => {
  const stale = replayExecutionPlans({
    cycles: [cycle],
    tape: profitableTape(),
    runtimeConfig,
    nowMs: 10000,
    staleOrderbookMs: 500,
  });
  const depth = replayExecutionPlans({
    cycles: [cycle],
    tape: [
      entry("KRW-BTC", 1000, 100, 99, 0.000001, 0.000001),
      entry("BTC-ETH", 1000, 0.1, 0.09),
      entry("KRW-ETH", 1000, 18, 12),
    ],
    runtimeConfig,
    nowMs: 1000,
    staleOrderbookMs: 5000,
  });

  assert.equal(stale.acceptedCount, 0);
  assert.equal(stale.results[0].depthValidation.validationReason, "STALE_ORDERBOOK");
  assert.equal(depth.acceptedCount, 0);
  assert.equal(depth.results[0].depthValidation.validationReason, "DEPTH_INSUFFICIENT");
});

test("replay regenerates deterministic dry-run performance reports", async () => {
  const first = await replayDryRunReport({
    cycles: [cycle],
    tape: profitableTape(),
    runtimeConfig,
    nowMs: 1000,
    staleOrderbookMs: 5000,
  });
  const second = await replayDryRunReport({
    cycles: [cycle],
    tape: profitableTape(),
    runtimeConfig,
    nowMs: 1000,
    staleOrderbookMs: 5000,
  });

  assert.equal(first.dryRunReport.generatedAt, "1970-01-01T00:00:01.000Z");
  assert.deepEqual(first.dryRunReport, second.dryRunReport);
  assert.deepEqual(first.replayManifest, second.replayManifest);
  assert.equal(first.dryRunReport.totalOpportunities, 1);
  assert.equal(first.dryRunReport.accepted, 1);
  assert.equal(first.dryRunReport.simulatedCompleteCycles, 1);
  assert.equal(first.dryRunReport.simulatedFailedCycles, 0);
  assert.equal(first.dryRunReport.byStartAsset.KRW.simulatedCompleteCycles, 1);
  assert.equal(first.dryRunReport.byStrategy.depthAwareLimitIoc.opportunities, 1);
  assert.equal(first.dryRunExecutions.length, 1);
  assert.equal(first.dryRunExecutions[0].ok, true);
  assert.ok(first.dryRunReport.simulatedNetProfit > 0);
  assert.ok(Math.abs(first.dryRunReport.expectedSimulatedGap) < 1e-9);
  assert.equal(first.replayManifest.dryRunExecutionCount, 1);
  assert.equal(typeof first.replayManifest.fingerprints.dryRunReport, "string");
  assert.equal(typeof first.replayManifest.fingerprints.dryRunExecutions, "string");
});

test("replay dry-run report preserves rejection reasons without execution plans", async () => {
  const stale = await replayDryRunReport({
    cycles: [cycle],
    tape: profitableTape(),
    runtimeConfig,
    nowMs: 10000,
    staleOrderbookMs: 500,
  });

  assert.equal(stale.executionPlans.length, 0);
  assert.equal(stale.dryRunReport.totalOpportunities, 1);
  assert.equal(stale.dryRunReport.accepted, 0);
  assert.equal(stale.dryRunReport.strategyRejected, 1);
  assert.equal(stale.dryRunReport.rejectedByReason.STALE_ORDERBOOK, 1);
  assert.equal(stale.dryRunReport.simulatedAttemptCycles, 0);
});
