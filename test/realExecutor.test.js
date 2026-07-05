const test = require("node:test");
const assert = require("node:assert/strict");
const { RealExecutor } = require("../src/execution/realExecutor");

const cycle = {
  cycleId: "BTC|ETH|KRW:canonical:KRW",
  startAsset: "KRW",
  steps: [
    { index: 0, fromAsset: "KRW", toAsset: "BTC", market: "KRW-BTC" },
    { index: 1, fromAsset: "BTC", toAsset: "KRW", market: "KRW-BTC" },
  ],
};

function orderbook() {
  return {
    market: "KRW-BTC",
    timestamp: 1000,
    orderbook_units: [{ ask_price: 100, bid_price: 90, ask_size: 10, bid_size: 10 }],
  };
}

test("real executor refuses to run unless live trading is enabled", async () => {
  const executor = new RealExecutor({
    liveTradingEnabled: false,
    restClient: {},
  });

  await assert.rejects(() => executor.execute({}), /liveTradingEnabled=false/);
});

test("real executor submits limit IOC at observed best price", async () => {
  const submitted = [];
  const executor = new RealExecutor({
    liveTradingEnabled: true,
    runtimeConfig: {
      executionMode: "LIMIT_IOC_AT_OBSERVED_BEST",
      candidateValidation: { minOrderAmountByAsset: { BTC: 0, KRW: 0 } },
      executionPolicy: {
        realRunLimits: {},
        marketDataGuards: {},
        executionGuards: {},
      },
    },
    restClient: {
      async createOrder(order) {
        submitted.push(order);
        return { uuid: `uuid-${submitted.length}`, ...order, executed_volume: order.volume || "1", avg_price: order.price || "90" };
      },
      async getOrder(params) {
        const order = submitted.find((item) => item.identifier === params.identifier) || submitted.at(-1);
        return { ...order, uuid: params.uuid, executed_volume: order.volume || "1", avg_price: order.price || "90" };
      },
    },
  });
  const result = await executor.execute({
    planId: "real-1",
    cycle,
    startAmount: 100,
    validationOrderbooks: new Map([["KRW-BTC", orderbook()]]),
  }, {
    privateWsConnected: true,
    orderChanceFresh: true,
    accountBalanceFresh: true,
    validationDepthFresh: true,
  });

  assert.equal(result.ok, true);
  assert.equal(submitted[0].ord_type, "limit");
  assert.equal(submitted[0].time_in_force, "ioc");
  assert.equal(submitted[0].price, "100");
  assert.equal(submitted[1].side, "ask");
  assert.equal(submitted[1].price, "90");
});

test("real executor can build BEST_IOC orders only when configured by caller", () => {
  const executor = new RealExecutor({
    liveTradingEnabled: true,
    runtimeConfig: {
      executionMode: "BEST_IOC",
      executionPolicy: {},
    },
    restClient: {},
  });
  const buy = executor.buildOrderForLeg(cycle.steps[0], 100, orderbook(), "id-1");
  const sell = executor.buildOrderForLeg(cycle.steps[1], 1, orderbook(), "id-2");

  assert.equal(buy.ord_type, "best");
  assert.equal(buy.side, "bid");
  assert.equal(buy.price, "100");
  assert.equal(sell.ord_type, "best");
  assert.equal(sell.side, "ask");
  assert.equal(sell.volume, "1");
});
