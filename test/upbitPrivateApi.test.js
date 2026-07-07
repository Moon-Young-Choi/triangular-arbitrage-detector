const test = require("node:test");
const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const { createQueryHash, createQueryString, createJwtToken } = require("../src/exchanges/upbit/auth");
const {
  UpbitExchangeRestClient,
  normalizeOrderChance,
} = require("../src/exchanges/upbit/exchangeRestClient");
const {
  normalizeFeePolicy,
  defaultFeePolicyForMarket,
  defaultTakerFeeRateForMarket,
  resolveLegFee,
  hasCompleteFeePolicy,
  isFeePolicyExpired,
  calculateFeeAdjustedBreakEven,
  marketCodeFromChance,
} = require("../src/exchanges/upbit/feeModel");
const {
  UpbitPrivateWsClient,
  normalizeMyOrderEvent,
} = require("../src/exchanges/upbit/privateWsClient");

function memoryLogStore(events) {
  return {
    append(kind, payload) {
      events.push({ kind, ...payload });
      return Promise.resolve(payload);
    },
  };
}

function createFakeWebSocketClass() {
  class FakeWebSocket extends EventEmitter {
    constructor(endpoint, options = {}) {
      super();
      this.endpoint = endpoint;
      this.options = options;
      this.readyState = FakeWebSocket.CONNECTING;
      this.sent = [];
      this.pings = 0;
      this.closeCalls = [];
      this.terminated = false;
      FakeWebSocket.instances.push(this);
    }

    send(payload) {
      this.sent.push(payload);
    }

    ping() {
      this.pings += 1;
    }

    close(code, reason) {
      this.closeCalls.push({ code, reason });
      this.emitClose(code, reason);
    }

    terminate() {
      this.terminated = true;
      this.readyState = FakeWebSocket.CLOSED;
    }

    emitOpen() {
      this.readyState = FakeWebSocket.OPEN;
      this.emit("open");
    }

    emitMessage(payload) {
      const data = typeof payload === "string" ? payload : JSON.stringify(payload);
      this.emit("message", Buffer.from(data));
    }

    emitClose(code = 1006, reason = "") {
      this.readyState = FakeWebSocket.CLOSED;
      this.emit("close", code, Buffer.from(String(reason)));
    }
  }

  FakeWebSocket.CONNECTING = 0;
  FakeWebSocket.OPEN = 1;
  FakeWebSocket.CLOSED = 3;
  FakeWebSocket.instances = [];

  return FakeWebSocket;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("Upbit JWT auth builds query strings, hashes, and signed tokens", () => {
  const query = { market: "KRW-BTC", side: "bid" };
  const token = createJwtToken({
    accessKey: "access",
    secretKey: "secret",
    query,
    nonce: "fixed-nonce",
  });

  assert.equal(createQueryString(query), "market=KRW-BTC&side=bid");
  assert.equal(createQueryHash(query).length, 128);
  assert.equal(token.split(".").length, 3);
});

test("Upbit REST client refuses createOrder when live trading is disabled", async () => {
  const events = [];
  let networkCalls = 0;
  const client = new UpbitExchangeRestClient({
    accessKey: "access",
    secretKey: "secret",
    liveTradingEnabled: false,
    logStore: memoryLogStore(events),
    client: {
      request() {
        networkCalls += 1;
        throw new Error("network should not be called");
      },
    },
  });

  await assert.rejects(
    () => client.createOrder({ market: "KRW-BTC", side: "bid", ord_type: "limit" }),
    /liveTradingEnabled=false/,
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "events");
  assert.equal(events[0].type, "exchange.rest.refused");
  assert.equal(events[0].reason, "LIVE_TRADING_DISABLED");
  assert.equal(events[0].body.market, "KRW-BTC");
  assert.equal(networkCalls, 0);
});

test("Upbit REST client refuses cancelOrder when live trading is disabled", async () => {
  const events = [];
  let networkCalls = 0;
  const client = new UpbitExchangeRestClient({
    accessKey: "access",
    secretKey: "secret",
    liveTradingEnabled: false,
    logStore: memoryLogStore(events),
    client: {
      request() {
        networkCalls += 1;
        throw new Error("network should not be called");
      },
    },
  });

  await assert.rejects(
    () => client.cancelOrder({ uuid: "order-1", identifier: "cycle-1-leg-1" }),
    /cancelOrder refused because liveTradingEnabled=false/,
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "events");
  assert.equal(events[0].type, "exchange.rest.refused");
  assert.equal(events[0].operation, "cancelOrder");
  assert.equal(events[0].method, "DELETE");
  assert.equal(events[0].pathname, "/order");
  assert.equal(events[0].reason, "LIVE_TRADING_DISABLED");
  assert.equal(events[0].params.uuid, "order-1");
  assert.equal(events[0].params.identifier, "cycle-1-leg-1");
  assert.equal(networkCalls, 0);
});

test("Upbit REST client audits request response and error summaries without auth headers", async () => {
  const events = [];
  const client = new UpbitExchangeRestClient({
    accessKey: "access",
    secretKey: "secret",
    liveTradingEnabled: true,
    logStore: memoryLogStore(events),
    client: {
      async request({ url }) {
        if (url === "/orders/chance") {
          return {
            status: 200,
            data: {
              bid_fee: "0.0005",
              ask_fee: "0.0005",
              market: { id: "KRW-BTC", state: "active", bid: { min_total: "5000" }, ask: { min_total: "5000" } },
            },
          };
        }

        const error = new Error("order not found");
        error.response = {
          status: 404,
          data: {
            error: {
              name: "order_not_found",
              message: "Order not found",
            },
          },
        };
        throw error;
      },
    },
  });

  const chance = await client.getOrderChance("KRW-BTC");

  await assert.rejects(
    () => client.getOrder({ uuid: "missing-order" }),
    /order not found/,
  );

  const requestEvents = events.filter((event) => event.type === "exchange.rest.request");
  const response = events.find((event) => event.type === "exchange.rest.response");
  const failure = events.find((event) => event.type === "exchange.rest.error");
  const serialized = JSON.stringify(events);

  assert.equal(chance.market.id, "KRW-BTC");
  assert.equal(requestEvents.length, 2);
  assert.equal(requestEvents[0].pathname, "/orders/chance");
  assert.equal(requestEvents[0].params.market, "KRW-BTC");
  assert.equal(response.status, 200);
  assert.equal(response.response.bid_fee, "0.0005");
  assert.equal(response.response.market.id, "KRW-BTC");
  assert.equal(failure.pathname, "/order");
  assert.equal(failure.error.status, 404);
  assert.equal(failure.error.code, "order_not_found");
  assert.equal(serialized.includes("Authorization"), false);
  assert.equal(serialized.includes("Bearer"), false);
  assert.equal(serialized.includes("secret"), false);
});

test("Upbit REST client permission probe reports scoped failures without secrets", async () => {
  const client = new UpbitExchangeRestClient({
    accessKey: "access",
    secretKey: "secret",
    client: {
      request({ url }) {
        if (url === "/accounts") return Promise.resolve({ data: [
          { currency: "KRW", balance: "1000", locked: "10" },
        ] });
        const error = new Error("out_of_scope");
        error.response = { status: 401 };
        return Promise.reject(error);
      },
    },
  });
  const permissions = await client.checkPermissions({ market: "KRW-BTC" });

  assert.equal(permissions.viewAccounts, true);
  assert.equal(permissions.accounts[0].currency, "KRW");
  assert.equal(permissions.viewOrdersChance, false);
  assert.equal(permissions.errors[0].message, "HTTP 401");
  assert.equal(JSON.stringify(permissions).includes("secret"), false);
});

test("orders chance and fee policy normalization supports taker and maker fees", () => {
  const normalized = normalizeOrderChance({
    bid_fee: "0.0005",
    ask_fee: "0.0004",
    maker_bid_fee: "0.0002",
    maker_ask_fee: "0.0001",
    market: { id: "KRW-BTC", bid: { min_total: "5000" }, ask: { min_total: "5000" } },
  });
  const policy = normalizeFeePolicy(normalized);

  assert.equal(policy.bidFee, 0.0005);
  assert.equal(policy.askFee, 0.0004);
  assert.equal(policy.market, "KRW-BTC");
  assert.equal(policy.source, "orders/chance");
  assert.equal(normalized.market.bid.minTotal, "5000");
  assert.equal(normalized.market.ask.minTotal, "5000");
  assert.equal(resolveLegFee(policy, "bid"), 0.0005);
  assert.equal(resolveLegFee(policy, "ask", { expectedMaker: true }), 0.0001);
  assert.equal(hasCompleteFeePolicy(policy), true);
  assert.equal(hasCompleteFeePolicy({ ...policy, makerAskFee: null }), false);
  assert.equal(isFeePolicyExpired({ ...policy, expiresAt: "1970-01-01T00:00:01.000Z" }, 2000), true);
  assert.equal(isFeePolicyExpired({ ...policy, expiresAt: "1970-01-01T00:00:03.000Z" }, 2000), false);
  assert.equal(
    calculateFeeAdjustedBreakEven([0.0005, 0.0004]).toFixed(12),
    (1 / ((1 - 0.0005) * (1 - 0.0004))).toFixed(12),
  );
  assert.equal(marketCodeFromChance({ market: { market: "BTC-ETH" } }), "BTC-ETH");
  assert.equal(marketCodeFromChance({ marketId: "KRW-ETH" }), "KRW-ETH");
});

test("default Upbit taker fee policy follows quote market guide", () => {
  assert.equal(defaultTakerFeeRateForMarket("KRW-BTC"), 0.0005);
  assert.equal(defaultTakerFeeRateForMarket("BTC-ETH"), 0.0025);
  assert.equal(defaultTakerFeeRateForMarket("USDT-SOL"), 0.0025);

  const policy = defaultFeePolicyForMarket("USDT-SOL");

  assert.equal(policy.bidFee, 0.0025);
  assert.equal(policy.askFee, 0.0025);
  assert.equal(policy.source, "upbit-default");
});

test("myOrder events normalize order and fee fields", () => {
  const event = normalizeMyOrderEvent({
    uuid: "order-1",
    identifier: "client-1",
    code: "KRW-BTC",
    side: "bid",
    ord_type: "limit",
    state: "trade",
    price: "100",
    avg_price: "99",
    volume: "1.5",
    remaining_volume: "0.5",
    executed_volume: "1.0",
    paid_fee: "0.01",
    trade_fee: "0.005",
    is_maker: true,
    trade_timestamp: 123,
    order_timestamp: 100,
    timestamp: 130,
  });

  assert.equal(event.uuid, "order-1");
  assert.equal(event.market, "KRW-BTC");
  assert.equal(event.state, "trade");
  assert.equal(event.paidFee, 0.01);
  assert.equal(event.tradeFee, 0.005);
  assert.equal(event.isMaker, true);
});

test("private websocket subscribes to myOrder with auth and emits normalized fills", async () => {
  const FakeWebSocket = createFakeWebSocketClass();
  const statuses = [];
  const orders = [];
  const errors = [];
  const client = new UpbitPrivateWsClient({
    endpoint: "wss://example.test/private",
    accessKey: "access",
    secretKey: "secret",
    codes: ["KRW-BTC"],
    WebSocket: FakeWebSocket,
    pingIntervalMs: 5,
  });

  client.on("status", (status) => statuses.push(status));
  client.on("myOrder", (event) => orders.push(event));
  client.on("error", (error) => errors.push(error));

  client.start();
  const socket = FakeWebSocket.instances[0];
  socket.emitOpen();
  socket.emitMessage({
    uuid: "uuid-private",
    identifier: "identifier-private",
    code: "KRW-BTC",
    state: "trade",
    executed_volume: "0.5",
    paid_fee: "0.01",
    trade_fee: "0.01",
  });
  socket.emitMessage("{not-json");
  await delay(12);
  client.stop();

  const subscription = JSON.parse(socket.sent[0]);

  assert.equal(FakeWebSocket.instances.length, 1);
  assert.equal(socket.endpoint, "wss://example.test/private");
  assert.match(socket.options.headers.Authorization, /^Bearer /);
  assert.equal(socket.options.headers.Authorization.includes("secret"), false);
  assert.match(subscription[0].ticket, /^q-gagarin-private-/);
  assert.deepEqual(subscription[1], { type: "myOrder", codes: ["KRW-BTC"] });
  assert.equal(statuses.some((status) => status.status === "connecting"), true);
  assert.equal(statuses.some((status) => status.status === "open"), true);
  assert.equal(orders.length, 1);
  assert.equal(orders[0].uuid, "uuid-private");
  assert.equal(orders[0].executedVolume, 0.5);
  assert.equal(orders[0].paidFee, 0.01);
  assert.equal(errors.some((error) => error.type === "parse"), true);
  assert.equal(socket.pings > 0, true);
  assert.equal(Number.isFinite(client.lastMessageAt), true);
});

test("private websocket reconnects after unexpected close and stops cleanly", async () => {
  const FakeWebSocket = createFakeWebSocketClass();
  const statuses = [];
  const client = new UpbitPrivateWsClient({
    endpoint: "wss://example.test/private",
    accessKey: "access",
    secretKey: "secret",
    WebSocket: FakeWebSocket,
    reconnectMinMs: 1,
    reconnectMaxMs: 1,
  });

  client.on("status", (status) => statuses.push(status));

  client.start();
  const firstSocket = FakeWebSocket.instances[0];
  firstSocket.emitOpen();
  firstSocket.emitClose(1006, "network down");
  await delay(5);

  assert.equal(FakeWebSocket.instances.length, 2);
  assert.equal(statuses.some((status) => (
    status.status === "closed" &&
    status.code === 1006 &&
    status.reason === "network down"
  )), true);
  assert.equal(statuses.at(-1).status, "connecting");
  assert.equal(statuses.at(-1).reconnectAttempt, 1);

  client.stop();

  assert.equal(client.stopped, true);
  assert.equal(FakeWebSocket.instances[1].terminated, true);
  assert.equal(statuses.at(-1).status, "stopped");
});
