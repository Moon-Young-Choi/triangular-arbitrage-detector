const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { AppendOnlyLogStore } = require("../src/core/appendOnlyLog");
const {
  readFilteredLogs,
  normalizeType,
} = require("../src/live/logReadModel");
const {
  dryRunReportCsv,
  summarizeDryRun,
} = require("../src/dashboard/dryRunReport");

test("log read model filters dry-run logs and summarizes report metrics", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "q-gagarin-logread-"));
  const store = new AppendOnlyLogStore({ logDir: dir });

  await store.ensureFiles();
  await store.append("decisions", {
    type: "strategy-decision",
    mode: "DRY_RUN",
    accepted: true,
    startAsset: "KRW",
    strategyId: "topOfBookBaseline",
    cycleId: "cycle-a",
    expectedNetProfit: 10,
    latencyMs: 80,
    bestLevelTouchRatio: 0.18,
  });
  await store.append("events", {
    type: "strategy.rejected",
    mode: "DRY_RUN",
    startAsset: "KRW",
    reason: "PROFIT_BELOW_THRESHOLD",
    excludeFromDryRunSummary: true,
  });
  await store.append("events", {
    type: "cycle.simulated_done",
    mode: "DRY_RUN",
    startAsset: "KRW",
    pnl: 7,
    latencyMs: 110,
    bestLevelTouchRatio: 0.22,
  });
  await store.append("events", {
    type: "cycle.simulated_fail",
    mode: "DRY_RUN",
    startAsset: "BTC",
    reason: "DEPTH_INSUFFICIENT",
    latencyMs: 700,
    bestLevelTouchRatio: 0.8,
  });
  await store.append("orders", {
    type: "order.ack",
    mode: "REAL",
    startAsset: "KRW",
  });

  const rows = await readFilteredLogs(store, { mode: "DRY_RUN", startAsset: "KRW" });
  const summary = summarizeDryRun(await readFilteredLogs(store, { mode: "DRY_RUN" }));
  const csv = dryRunReportCsv(summary);

  assert.equal(rows.length, 3);
  assert.equal(summary.totalOpportunities, 1);
  assert.equal(summary.simulatedCompleteCycles, 1);
  assert.equal(summary.simulatedFailedCycles, 1);
  assert.equal(summary.simulatedCompleteRate, 0.5);
  assert.equal(summary.depthRejectionRate, 1);
  assert.equal(summary.latencyRejectionRate, 0);
  assert.equal(summary.rejectionRate, 1);
  assert.equal(summary.simulatedNetProfit, 7);
  assert.equal(summary.expectedSimulatedGap, 3);
  assert.equal(summary.expectedSimulatedGapRate, 0.3);
  assert.equal(summary.byStartAsset.KRW.opportunities, 1);
  assert.equal(summary.byStartAsset.KRW.simulatedCompleteCycles, 1);
  assert.equal(summary.byStartAsset.BTC.simulatedFailedCycles, 1);
  assert.equal(summary.byMarketState.unknown.opportunities, 1);
  assert.equal(summary.byLatencyBand["0-100ms"].opportunities, 1);
  assert.equal(summary.byLatencyBand["100-250ms"].simulatedCompleteCycles, 1);
  assert.equal(summary.byLatencyBand["500-1000ms"].simulatedFailedCycles, 1);
  assert.equal(summary.byBestLevelTouchRatio["10-25%"].opportunities, 1);
  assert.equal(summary.byBestLevelTouchRatio["10-25%"].simulatedCompleteCycles, 1);
  assert.equal(summary.byBestLevelTouchRatio["75-100%"].simulatedFailedCycles, 1);
  assert.match(csv, /simulatedNetProfit/);
  assert.match(csv, /simulatedCompleteRate/);
  assert.match(csv, /depthRejectionRate/);
  assert.match(csv, /bestTouchP95/);
  assert.match(csv, /periodFrom/);
  assert.match(csv, /startAsset:KRW:opportunities/);
  assert.match(csv, /startAsset:BTC:simulatedFailedCycles/);
  assert.match(csv, /strategy:topOfBookBaseline:accepted/);
  assert.match(csv, /route:cycle-a:simulatedCompleteCycles/);
  assert.match(csv, /marketState:unknown:opportunities/);
  assert.match(csv, /latencyBand:0-100ms:opportunities/);
  assert.match(csv, /bestLevelTouchRatio:10-25%:simulatedCompleteCycles/);
});

test("dry-run report supports period filters and market-state performance groups", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "q-gagarin-logread-period-"));
  const store = new AppendOnlyLogStore({ logDir: dir });

  await store.ensureFiles();
  await store.append("decisions", {
    type: "strategy-decision",
    timestamp: "2026-07-06T00:00:00.000Z",
    mode: "DRY_RUN",
    accepted: true,
    startAsset: "KRW",
    strategyId: "depthAwareBestIoc",
    cycleId: "old-cycle",
    status: "available",
    marketState: "available",
    expectedNetProfit: 5,
  });
  await store.append("decisions", {
    type: "strategy-decision",
    timestamp: "2026-07-06T00:10:00.000Z",
    mode: "DRY_RUN",
    accepted: false,
    startAsset: "BTC",
    strategyId: "depthAwareBestIoc",
    cycleId: "stale-cycle",
    status: "stale",
    validationStatus: "rejected",
    validationReason: "STALE_ORDERBOOK",
    expectedNetProfit: 8,
  });
  await store.append("events", {
    type: "cycle.aborted",
    timestamp: "2026-07-06T00:10:05.000Z",
    mode: "DRY_RUN",
    startAsset: "BTC",
    strategyId: "depthAwareBestIoc",
    cycleId: "stale-cycle",
    marketState: "stale",
    reason: "STALE_ORDERBOOK",
  });

  const rows = await readFilteredLogs(store, {
    mode: "DRY_RUN",
    from: "2026-07-06T00:05:00.000Z",
    to: "2026-07-06T00:11:00.000Z",
  });
  const summary = summarizeDryRun(rows);
  const csv = dryRunReportCsv(summary);

  assert.equal(rows.length, 2);
  assert.equal(summary.period.from, "2026-07-06T00:10:00.000Z");
  assert.equal(summary.period.to, "2026-07-06T00:10:05.000Z");
  assert.equal(summary.totalOpportunities, 1);
  assert.equal(summary.byMarketState.stale.opportunities, 1);
  assert.equal(summary.byMarketState.stale.rejected, 1);
  assert.equal(summary.byMarketState.stale.simulatedFailedCycles, 1);
  assert.equal(summary.byStartAsset.KRW, undefined);
  assert.match(csv, /marketState:stale:simulatedFailedCycles/);
});

test("log type normalization treats simulated fills as fill events", () => {
  assert.equal(normalizeType("market.orderbook_update"), "market");
  assert.equal(normalizeType("order.simulated_fill"), "fill");
  assert.equal(normalizeType("order.ack"), "order");
  assert.equal(normalizeType("position.residual_recorded"), "position");
  assert.equal(normalizeType("cycle.aborted"), "rejection");
  assert.equal(normalizeType("cycle.done"), "cycle");
});

test("log read model filters residual position audit events", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "q-gagarin-logread-position-"));
  const store = new AppendOnlyLogStore({ logDir: dir });

  await store.ensureFiles();
  await store.append("events", {
    type: "position.residual_recorded",
    mode: "REAL",
    startAsset: "KRW",
    cycleId: "cycle-residual",
    asset: "BTC",
    amount: 0.001,
    reason: "PARTIAL_FILL_ABORTED_BY_POLICY",
  });
  await store.append("events", {
    type: "cycle.done",
    mode: "REAL",
    startAsset: "KRW",
    cycleId: "cycle-done",
  });

  const rows = await readFilteredLogs(store, { type: "position" });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, "position.residual_recorded");
  assert.equal(rows[0].normalizedType, "position");
  assert.equal(rows[0].asset, "BTC");
});

test("dry-run summary accepts canonical cycle audit events", () => {
  const summary = summarizeDryRun([
    {
      type: "strategy-decision",
      mode: "DRY_RUN",
      accepted: true,
      startAsset: "KRW",
      strategyId: "depthAwareBestIoc",
      cycleId: "cycle-canonical",
      expectedNetProfit: 12,
    },
    {
      type: "cycle.done",
      mode: "DRY_RUN",
      startAsset: "KRW",
      strategyId: "depthAwareBestIoc",
      cycleId: "cycle-canonical",
      pnl: 9,
    },
    {
      type: "cycle.aborted",
      mode: "DRY_RUN",
      startAsset: "BTC",
      strategyId: "depthAwareBestIoc",
      cycleId: "cycle-aborted",
      reason: "LATENCY_GUARD",
    },
  ]);

  assert.equal(summary.simulatedCompleteCycles, 1);
  assert.equal(summary.simulatedFailedCycles, 1);
  assert.equal(summary.simulatedCompleteRate, 0.5);
  assert.equal(summary.simulatedNetProfit, 9);
  assert.equal(summary.rejectedByReason.LATENCY_GUARD, 1);
  assert.equal(summary.byStartAsset.KRW.simulatedCompleteCycles, 1);
  assert.equal(summary.byStartAsset.BTC.simulatedFailedCycles, 1);
});
