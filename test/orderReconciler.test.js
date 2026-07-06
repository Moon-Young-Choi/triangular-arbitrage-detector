const test = require("node:test");
const assert = require("node:assert/strict");
const { FillTracker } = require("../src/execution/fillTracker");
const { OrderReconciler } = require("../src/execution/orderReconciler");

function memoryLogStore(events) {
  return {
    append(kind, payload) {
      events.push({ kind, ...payload });
      return Promise.resolve(payload);
    },
  };
}

test("order reconciler prefers private MyOrder fill events over REST query", async () => {
  const tracker = new FillTracker();
  let restCalls = 0;
  tracker.handleMyOrder({
    uuid: "uuid-1",
    identifier: "id-1",
    market: "KRW-BTC",
    state: "trade",
    executedVolume: 0.5,
    avgPrice: 100,
    paidFee: 0.01,
    tradeFee: 0.01,
  });
  const reconciler = new OrderReconciler({
    fillTracker: tracker,
    timeoutMs: 5,
    pollMs: 1,
    restClient: {
      async getOrder() {
        restCalls += 1;
        throw new Error("REST should not be called");
      },
    },
  });

  const result = await reconciler.reconcile({
    orderAck: { uuid: "uuid-1" },
    identifier: "id-1",
  });

  assert.equal(result.source, "private-ws");
  assert.equal(result.order.executedVolume, 0.5);
  assert.equal(restCalls, 0);
});

test("order reconciler queries REST after private WS timeout and tracks result", async () => {
  const events = [];
  const tracker = new FillTracker({
    logStore: memoryLogStore(events),
  });
  let restCalls = 0;
  const reconciler = new OrderReconciler({
    fillTracker: tracker,
    timeoutMs: 1,
    pollMs: 1,
    restClient: {
      async getOrder(params) {
        restCalls += 1;
        return {
          uuid: params.uuid,
          identifier: params.identifier,
          market: "KRW-BTC",
          state: "done",
          executed_volume: "1",
          remaining_volume: "0",
          avg_price: "100",
          paid_fee: "0.05",
          trade_fee: "0.05",
        };
      },
    },
  });

  const result = await reconciler.reconcile({
    orderAck: { uuid: "uuid-2" },
    identifier: "id-2",
    metadata: {
      cycleId: "cycle-rest",
      startAsset: "KRW",
      strategyId: "depthAwareBestIoc",
      legIndex: 1,
    },
  });
  const tracked = tracker.findOrder({ uuid: "uuid-2", identifier: "id-2" });
  const fill = tracker.findFill({ uuid: "uuid-2", identifier: "id-2" });

  assert.equal(result.source, "rest-query");
  assert.equal(result.timedOut, true);
  assert.equal(restCalls, 1);
  assert.equal(tracked.state, "done");
  assert.equal(tracked.paid_fee, "0.05");
  assert.equal(fill.type, "order.fill");
  assert.equal(fill.source, "rest-query");
  assert.equal(fill.paidFee, 0.05);
  assert.equal(fill.cycleId, "cycle-rest");
  assert.equal(fill.legIndex, 1);
  assert.equal(events.some((event) => event.kind === "fills" && event.type === "order.fill"), true);
});

test("order reconciler records ack-only when no REST client is available", async () => {
  const reconciler = new OrderReconciler({
    timeoutMs: 0,
    pollMs: 0,
  });

  const result = await reconciler.reconcile({
    orderAck: { uuid: "uuid-ack" },
    identifier: "id-ack",
  });

  assert.equal(result.source, "ack-only");
  assert.equal(result.restQueried, false);
  assert.equal(result.order.identifier, "id-ack");
});
