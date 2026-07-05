const test = require("node:test");
const assert = require("node:assert/strict");
const { FillTracker } = require("../src/execution/fillTracker");

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
    executedVolume: 0.1,
    paidFee: 100,
    tradeFee: 50,
  });

  const snapshot = tracker.snapshot();

  assert.equal(snapshot.orders[0].state, "trade");
  assert.equal(snapshot.orders[0].mode, "REAL");
  assert.equal(snapshot.fills.length, 1);
  assert.equal(snapshot.fills[0].mode, "REAL");
  assert.equal(snapshot.fills[0].paidFee, 100);
  assert.equal(snapshot.fills[0].tradeFee, 50);
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
