const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { AppendOnlyLogStore } = require("../src/core/appendOnlyLog");
const {
  readFilteredLogs,
  normalizeType,
  summarizeDryRun,
  dryRunReportCsv,
} = require("../src/live/logReadModel");

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
    latencyMs: 4,
  });
  await store.append("events", {
    type: "cycle.simulated_done",
    mode: "DRY_RUN",
    startAsset: "KRW",
    pnl: 7,
    latencyMs: 6,
  });
  await store.append("events", {
    type: "cycle.simulated_fail",
    mode: "DRY_RUN",
    startAsset: "BTC",
    reason: "DEPTH_INSUFFICIENT",
  });
  await store.append("orders", {
    type: "order.ack",
    mode: "REAL",
    startAsset: "KRW",
  });

  const rows = await readFilteredLogs(store, { mode: "DRY_RUN", startAsset: "KRW" });
  const summary = summarizeDryRun(await readFilteredLogs(store, { mode: "DRY_RUN" }));
  const csv = dryRunReportCsv(summary);

  assert.equal(rows.length, 2);
  assert.equal(summary.totalOpportunities, 1);
  assert.equal(summary.simulatedCompleteCycles, 1);
  assert.equal(summary.simulatedFailedCycles, 1);
  assert.equal(summary.simulatedNetProfit, 7);
  assert.match(csv, /simulatedNetProfit/);
});

test("log type normalization treats simulated fills as fill events", () => {
  assert.equal(normalizeType("order.simulated_fill"), "fill");
  assert.equal(normalizeType("order.ack"), "order");
});
