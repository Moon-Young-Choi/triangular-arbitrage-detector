const test = require("node:test");
const assert = require("node:assert/strict");
const { createQueryHash, createQueryString, createJwtToken } = require("../src/exchanges/upbit/auth");
const {
  UpbitExchangeRestClient,
  normalizeOrderChance,
} = require("../src/exchanges/upbit/exchangeRestClient");
const {
  normalizeFeePolicy,
  resolveLegFee,
  calculateFeeAdjustedBreakEven,
} = require("../src/exchanges/upbit/feeModel");
const { normalizeMyOrderEvent } = require("../src/exchanges/upbit/privateWsClient");

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
  const client = new UpbitExchangeRestClient({
    accessKey: "access",
    secretKey: "secret",
    liveTradingEnabled: false,
    client: {
      request() {
        throw new Error("network should not be called");
      },
    },
  });

  await assert.rejects(
    () => client.createOrder({ market: "KRW-BTC", side: "bid", ord_type: "limit" }),
    /liveTradingEnabled=false/,
  );
});

test("Upbit REST client permission probe reports scoped failures without secrets", async () => {
  const client = new UpbitExchangeRestClient({
    accessKey: "access",
    secretKey: "secret",
    client: {
      request({ url }) {
        if (url === "/accounts") return Promise.resolve({ data: [] });
        const error = new Error("out_of_scope");
        error.response = { status: 401 };
        return Promise.reject(error);
      },
    },
  });
  const permissions = await client.checkPermissions({ market: "KRW-BTC" });

  assert.equal(permissions.viewAccounts, true);
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
  assert.equal(resolveLegFee(policy, "bid"), 0.0005);
  assert.equal(resolveLegFee(policy, "ask", { maker: true }), 0.0001);
  assert.equal(
    calculateFeeAdjustedBreakEven([0.0005, 0.0004]).toFixed(12),
    (1 / ((1 - 0.0005) * (1 - 0.0004))).toFixed(12),
  );
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
