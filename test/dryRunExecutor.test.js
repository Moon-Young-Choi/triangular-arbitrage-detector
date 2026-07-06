const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { DryRunExecutor } = require("../src/execution/dryRunExecutor");
const { AppendOnlyLogStore } = require("../src/core/appendOnlyLog");

const cycle = {
  cycleId: "BTC|ETH|KRW:canonical:KRW",
  startAsset: "KRW",
  steps: [
    { index: 0, fromAsset: "KRW", toAsset: "BTC", market: "KRW-BTC" },
    { index: 1, fromAsset: "BTC", toAsset: "ETH", market: "BTC-ETH" },
    { index: 2, fromAsset: "ETH", toAsset: "KRW", market: "KRW-ETH" },
  ],
};

function orderbook(market, unit) {
  return {
    market,
    timestamp: 1000,
    receivedAt: 1000,
    orderbook_units: [unit],
  };
}

async function readUntil(logStore, kind, predicate, attempts = 20) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const rows = await logStore.readAll(kind, { limit: 100 });
    if (predicate(rows)) return rows;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  return logStore.readAll(kind, { limit: 100 });
}

test("dry-run executor simulates fills and PnL without real orders", async () => {
  const executor = new DryRunExecutor({
    simulatedBalances: { KRW: 20000 },
    validationConfig: {
      minOrderAmountByAsset: { KRW: 5000 },
    },
  });
  const result = await executor.execute({
    planId: "plan-1",
    cycle,
    startAmount: 10000,
    feeRate: 0,
    nowMs: 1000,
    staleOrderbookMs: 5000,
    validationOrderbooks: new Map([
      ["KRW-BTC", orderbook("KRW-BTC", { ask_price: 100, bid_price: 99, ask_size: 200, bid_size: 200 })],
      ["BTC-ETH", orderbook("BTC-ETH", { ask_price: 0.1, bid_price: 0.09, ask_size: 2000, bid_size: 2000 })],
      ["KRW-ETH", orderbook("KRW-ETH", { ask_price: 20, bid_price: 18, ask_size: 2000, bid_size: 2000 })],
    ]),
  });

  assert.equal(result.mode, "DRY_RUN");
  assert.equal(result.ok, true);
  assert.equal(result.events.some((event) => event.type === "order.simulated_fill"), true);
  assert.equal(result.events.some((event) => event.type === "capital.reserved"), true);
  assert.equal(result.events.some((event) => event.type === "cycle.simulated_done"), true);
  assert.equal(result.events.some((event) => (
    event.type === "cycle.done" &&
    event.legacyType === "cycle.simulated_done" &&
    event.excludeFromDryRunSummary === true
  )), true);
  assert.equal(executor.capitalSnapshot().buckets.KRW.availableBalance, 28000);
  assert.equal(executor.capitalSnapshot().buckets.KRW.reservedBalance, 0);
});

test("dry-run executor writes schema-complete cycle and simulated fill audit events", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "q-gagarin-dry-audit-"));
  const logStore = new AppendOnlyLogStore({ logDir: dir });
  const executor = new DryRunExecutor({
    logStore,
    simulatedBalances: { KRW: 20000 },
    validationConfig: {
      minOrderAmountByAsset: { KRW: 5000 },
    },
  });

  await executor.execute({
    planId: "dry-audit-1",
    cycle,
    startAmount: 10000,
    feeRate: 0,
    nowMs: 1000,
    staleOrderbookMs: 5000,
    strategyId: "depthAwareBestIoc",
    engineState: "RUNNING",
    marketState: "available",
    feePolicyByMarket: new Map([
      ["KRW-BTC", { bidFee: 0.001, askFee: 0.001 }],
      ["BTC-ETH", { bidFee: 0.002, askFee: 0.002 }],
      ["KRW-ETH", { bidFee: 0.003, askFee: 0.003 }],
    ]),
    validationOrderbooks: new Map([
      ["KRW-BTC", orderbook("KRW-BTC", { ask_price: 100, bid_price: 99, ask_size: 200, bid_size: 200 })],
      ["BTC-ETH", orderbook("BTC-ETH", { ask_price: 0.1, bid_price: 0.09, ask_size: 2000, bid_size: 2000 })],
      ["KRW-ETH", orderbook("KRW-ETH", { ask_price: 20, bid_price: 18, ask_size: 2000, bid_size: 2000 })],
    ]),
  });
  const events = await readUntil(logStore, "events", (rows) => rows.some((event) => event.type === "cycle.done"));
  const fills = await readUntil(logStore, "fills", (rows) => rows.some((event) => event.type === "order.simulated_fill"));
  const cycleDone = events.find((event) => event.type === "cycle.done");
  const simulatedFill = fills.find((event) => event.type === "order.simulated_fill");

  assert.equal(cycleDone.auditSchema.ok, true);
  assert.equal(cycleDone.engineState, "RUNNING");
  assert.equal(cycleDone.marketState, "available");
  assert.equal(simulatedFill.auditSchema.ok, true);
  assert.equal(simulatedFill.startAsset, "KRW");
  assert.equal(simulatedFill.strategyId, "depthAwareBestIoc");
  assert.equal(simulatedFill.feeSide, "bid");
  assert.equal(simulatedFill.feeRate, 0.001);
});

test("dry-run executor enforces simulated balance guard", async () => {
  const executor = new DryRunExecutor({
    simulatedBalances: { KRW: 1000 },
    validationConfig: {
      minOrderAmountByAsset: { KRW: 500 },
    },
  });
  const result = await executor.execute({
    planId: "plan-2",
    cycle,
    startAmount: 5000,
    validationOrderbooks: new Map(),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "BALANCE_INSUFFICIENT");
  assert.equal(result.events.some((event) => event.type === "cycle.simulated_fail"), true);
  assert.equal(result.events.some((event) => (
    event.type === "cycle.aborted" &&
    event.legacyType === "cycle.simulated_fail" &&
    event.reason === "BALANCE_INSUFFICIENT"
  )), true);
  assert.equal(executor.capitalSnapshot().buckets.KRW.availableBalance, 1000);
  assert.equal(executor.capitalSnapshot().buckets.KRW.reservedBalance, 0);
});

test("dry-run executor blocks new executions while paused", async () => {
  const executor = new DryRunExecutor({
    simulatedBalances: { KRW: 10000 },
    validationConfig: {
      minOrderAmountByAsset: { KRW: 500 },
    },
  });
  const result = await executor.execute({
    planId: "plan-paused",
    cycle,
    engineState: "PAUSED",
    startAmount: 1000,
    validationOrderbooks: new Map(),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "EXECUTION_PAUSED");
  assert.equal(result.events.find((event) => event.type === "order.simulated_fill"), undefined);
  assert.equal(result.events.some((event) => event.type === "cycle.aborted" && event.reason === "EXECUTION_PAUSED"), true);
});

test("dry-run executor releases reserved capital when depth simulation fails", async () => {
  const executor = new DryRunExecutor({
    simulatedBalances: { KRW: 10000 },
    validationConfig: {
      minOrderAmountByAsset: { KRW: 500 },
    },
  });
  const result = await executor.execute({
    planId: "plan-depth-fail",
    cycle,
    startAmount: 1000,
    validationOrderbooks: new Map(),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "DEPTH_INSUFFICIENT");
  assert.equal(result.events.some((event) => event.type === "capital.reserved"), true);
  assert.equal(executor.capitalSnapshot().buckets.KRW.availableBalance, 10000);
  assert.equal(executor.capitalSnapshot().buckets.KRW.reservedBalance, 0);
});
