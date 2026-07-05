const test = require("node:test");
const assert = require("node:assert/strict");
const { DryRunExecutor } = require("../src/execution/dryRunExecutor");

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
  assert.equal(result.events.some((event) => event.type === "cycle.simulated_done"), true);
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
});
