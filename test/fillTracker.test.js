const test = require("node:test");
const assert = require("node:assert/strict");
const { FillTracker } = require("../src/execution/fillTracker");

function memoryLogStore(events) {
  return {
    append(kind, payload) {
      events.push({ kind, ...payload });
      return Promise.resolve(payload);
    },
  };
}

test("fill tracker updates orders and persists fill fee fields", () => {
  const tracker = new FillTracker();

  tracker.handleMyOrder({
    uuid: "uuid-1",
    identifier: "id-1",
    market: "KRW-BTC",
    state: "wait",
    paidFee: null,
    tradeFee: null,
  });
  tracker.handleMyOrder({
    uuid: "uuid-1",
    identifier: "id-1",
    market: "KRW-BTC",
    state: "trade",
    volume: 0.1,
    executedVolume: 0.1,
    remainingVolume: 0,
    paidFee: 100,
    tradeFee: 50,
    tradeTimestamp: 1234,
    orderTimestamp: 1200,
  });

  const snapshot = tracker.snapshot();

  assert.equal(snapshot.orders[0].state, "trade");
  assert.equal(snapshot.orders[0].mode, "REAL");
  assert.equal(snapshot.fills.length, 1);
  assert.equal(snapshot.fills[0].type, "order.fill");
  assert.equal(snapshot.fills[0].mode, "REAL");
  assert.equal(snapshot.fills[0].paidFee, 100);
  assert.equal(snapshot.fills[0].tradeFee, 50);
  assert.equal(snapshot.fills[0].tradeTimestamp, 1234);
  assert.equal(snapshot.fills[0].orderTimestamp, 1200);
});

test("fill tracker records partial fills and cancel audit events", () => {
  const events = [];
  const tracker = new FillTracker({
    logStore: memoryLogStore(events),
  });

  tracker.handleMyOrder({
    uuid: "uuid-partial",
    identifier: "id-partial",
    market: "KRW-BTC",
    state: "trade",
    volume: "1",
    executed_volume: "0.25",
    remaining_volume: "0.75",
    paid_fee: "0.01",
    cycleId: "cycle-1",
    startAsset: "KRW",
    strategyId: "depthAwareBestIoc",
    legIndex: 1,
  });
  tracker.handleMyOrder({
    uuid: "uuid-cancel",
    identifier: "id-cancel",
    market: "KRW-ETH",
    state: "cancel",
  });

  const partial = tracker.findFill({ uuid: "uuid-partial" });

  assert.equal(partial.type, "order.partial");
  assert.equal(partial.executedVolume, 0.25);
  assert.equal(partial.remainingVolume, 0.75);
  assert.equal(partial.cycleId, "cycle-1");
  assert.equal(partial.startAsset, "KRW");
  assert.equal(events.some((event) => event.kind === "fills" && event.type === "order.partial"), true);
  assert.equal(events.some((event) => event.kind === "orders" && event.type === "order.cancelled"), true);
});

test("fill tracker applies stop policy to open orders", () => {
  const tracker = new FillTracker();

  tracker.handleMyOrder({
    uuid: "uuid-open",
    identifier: "id-open",
    market: "KRW-BTC",
    state: "wait",
  });
  tracker.handleMyOrder({
    uuid: "uuid-done",
    identifier: "id-done",
    market: "KRW-ETH",
    state: "done",
  });

  const events = tracker.handleStopPolicy("CANCEL_OPEN_ORDERS");

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "order.cancel_intent");
  assert.equal(events[0].uuid, "uuid-open");
});
