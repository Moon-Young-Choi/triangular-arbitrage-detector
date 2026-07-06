const test = require("node:test");
const assert = require("node:assert/strict");
const { FillTracker } = require("../src/execution/fillTracker");
const { OrderManager } = require("../src/execution/orderManager");

function memoryLogStore(events) {
  return {
    append(kind, payload) {
      events.push({ kind, ...payload });
      return Promise.resolve(payload);
    },
  };
}

test("order manager generates bounded unique identifiers and logs submit intent", async () => {
  const events = [];
  const submitted = [];
  const manager = new OrderManager({
    logStore: memoryLogStore(events),
    restClient: {
      async createOrder(order) {
        submitted.push(order);
        return {
          uuid: "uuid-1",
          state: "wait",
          ...order,
        };
      },
    },
  });
  const identifier = manager.createIdentifier({
    planId: "plan:with:punctuation",
    legIndex: 1,
  });

  assert.equal(identifier.length <= 64, true);
  assert.match(identifier, /^qg-/u);

  const result = await manager.submitOrder({
    market: "KRW-BTC",
    side: "bid",
    ord_type: "limit",
    price: "100",
    volume: "1",
    identifier,
  }, {
    planId: "plan-1",
    legIndex: 1,
  });

  assert.equal(result.identifier, identifier);
  assert.equal(result.ack.identifier, identifier);
  assert.equal(submitted[0].identifier, identifier);
  assert.equal(events.some((event) => event.type === "order.submitted"), true);

  await assert.rejects(
    () => manager.submitOrder({
      market: "KRW-BTC",
      side: "bid",
      ord_type: "limit",
      identifier,
    }),
    /DUPLICATE_ORDER_IDENTIFIER/,
  );
});

test("order manager preserves execution metadata on tracked acknowledgements", async () => {
  const tracker = new FillTracker();
  const manager = new OrderManager({
    fillTracker: tracker,
    restClient: {
      async createOrder(order) {
        return {
          uuid: "uuid-meta",
          state: "wait",
          ...order,
        };
      },
    },
  });

  const result = await manager.submitOrder({
    market: "KRW-BTC",
    side: "bid",
    ord_type: "limit",
    price: "100",
    volume: "1",
  }, {
    planId: "plan-meta",
    cycleId: "cycle-meta",
    startAsset: "KRW",
    strategyId: "depthAwareBestIoc",
    legIndex: 1,
  });
  const tracked = tracker.findOrder({
    uuid: result.ack.uuid,
    identifier: result.identifier,
  });

  assert.equal(tracked.planId, "plan-meta");
  assert.equal(tracked.cycleId, "cycle-meta");
  assert.equal(tracked.startAsset, "KRW");
  assert.equal(tracked.strategyId, "depthAwareBestIoc");
  assert.equal(tracked.legIndex, 1);
});

test("order manager enforces submit rate limit before REST createOrder", async () => {
  const events = [];
  let createOrderCalls = 0;
  const manager = new OrderManager({
    logStore: memoryLogStore(events),
    orderRateLimitPerSecond: 1,
    rateLimiter: {
      allow() {
        return false;
      },
    },
    restClient: {
      async createOrder() {
        createOrderCalls += 1;
        throw new Error("REST should not be called");
      },
    },
  });

  await assert.rejects(
    () => manager.submitOrder({
      market: "KRW-BTC",
      side: "bid",
      ord_type: "limit",
      price: "100",
      volume: "1",
    }, {
      planId: "plan-rate",
      cycleId: "cycle-rate",
      startAsset: "KRW",
      legIndex: 1,
    }),
    /ORDER_RATE_LIMIT/,
  );

  assert.equal(createOrderCalls, 0);
  assert.equal(events.some((event) => (
    event.kind === "orders" &&
    event.type === "order.rejected" &&
    event.rejectionReason === "ORDER_RATE_LIMIT" &&
    event.planId === "plan-rate"
  )), true);
});

test("order manager audits REST order submit failures without reusing identifiers", async () => {
  const events = [];
  const manager = new OrderManager({
    logStore: memoryLogStore(events),
    restClient: {
      async createOrder() {
        const error = new Error("insufficient funds");
        error.response = {
          status: 400,
          data: {
            error: {
              name: "insufficient_funds_bid",
              message: "Insufficient bid balance",
            },
          },
        };
        throw error;
      },
    },
  });

  await assert.rejects(
    () => manager.submitOrder({
      market: "KRW-BTC",
      side: "bid",
      ord_type: "limit",
      price: "100",
      volume: "1",
      identifier: "submit-failure-id",
    }, {
      planId: "plan-submit-fail",
      cycleId: "cycle-submit-fail",
      startAsset: "KRW",
      legIndex: 1,
    }),
    /insufficient funds/,
  );

  assert.equal(manager.usedIdentifiers.has("submit-failure-id"), true);
  assert.equal(events.some((event) => event.kind === "orders" && event.type === "order.submitted"), true);
  assert.equal(events.some((event) => (
    event.kind === "orders" &&
    event.type === "order.submit_failed" &&
    event.rejectionReason === "ORDER_SUBMIT_FAILED" &&
    event.error.code === "insufficient_funds_bid" &&
    event.identifier === "submit-failure-id"
  )), true);
});

test("order manager cancels open orders through REST and tracks cancel acknowledgements", async () => {
  const events = [];
  const cancelled = [];
  const tracker = new FillTracker({
    logStore: memoryLogStore(events),
  });
  const manager = new OrderManager({
    fillTracker: tracker,
    logStore: memoryLogStore(events),
    restClient: {
      async cancelOrder(params) {
        cancelled.push(params);
        return {
          uuid: params.uuid,
          identifier: "id-open",
          market: "KRW-BTC",
          state: "cancel",
        };
      },
    },
  });

  const results = await manager.cancelOpenOrders([{
    uuid: "uuid-open",
    identifier: "id-open",
    market: "KRW-BTC",
    state: "wait",
    cycleId: "cycle-open",
    startAsset: "KRW",
    strategyId: "depthAwareBestIoc",
    legIndex: 1,
  }], {
    stopPolicy: "CANCEL_OPEN_ORDERS",
    source: "operator",
  });
  const tracked = tracker.findOrder({ uuid: "uuid-open" });

  assert.deepEqual(cancelled, [{ uuid: "uuid-open" }]);
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, true);
  assert.equal(results[0].ack.state, "cancel");
  assert.equal(tracked.state, "cancel");
  assert.equal(tracked.cycleId, "cycle-open");
  assert.equal(events.some((event) => event.kind === "orders" && event.type === "order.cancel_requested"), true);
  assert.equal(events.some((event) => event.kind === "orders" && event.type === "order.cancel_ack"), true);
  assert.equal(events.some((event) => event.kind === "orders" && event.type === "order.cancelled"), true);
});

test("order manager refuses to cancel unidentified open orders without REST calls", async () => {
  const events = [];
  let cancelCalls = 0;
  const manager = new OrderManager({
    logStore: memoryLogStore(events),
    restClient: {
      async cancelOrder() {
        cancelCalls += 1;
        throw new Error("network should not be called");
      },
    },
  });

  const results = await manager.cancelOpenOrders([{
    market: "KRW-BTC",
    state: "wait",
  }], {
    stopPolicy: "CANCEL_OPEN_ORDERS",
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].ok, false);
  assert.equal(results[0].error.message, "ORDER_CANCEL_IDENTIFIER_REQUIRED");
  assert.equal(cancelCalls, 0);
  assert.equal(events.some((event) => (
    event.kind === "orders" &&
    event.type === "order.cancel_failed" &&
    event.error.code === "ORDER_CANCEL_IDENTIFIER_REQUIRED"
  )), true);
});
