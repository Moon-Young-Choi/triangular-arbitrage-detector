const test = require("node:test");
const assert = require("node:assert/strict");
const {
  minTotalForQuoteAsset,
  normalizeLimitPrice,
  orderTotal,
  policyForMarket,
  priceUnitForMarket,
  hasCompleteMarketPolicy,
  validateOrderMinimum,
} = require("../src/exchanges/upbit/marketPolicy");

test("Upbit market policy resolves documented KRW/BTC/USDT fallback minimum totals", () => {
  assert.equal(minTotalForQuoteAsset("KRW"), 5000);
  assert.equal(minTotalForQuoteAsset("BTC"), 0.00005);
  assert.equal(minTotalForQuoteAsset("USDT"), 0.5);
});

test("Upbit market policy resolves documented price units by quote market", () => {
  assert.equal(priceUnitForMarket("KRW-BTC", 2100000), 1000);
  assert.equal(priceUnitForMarket("KRW-BTC", 750000), 500);
  assert.equal(priceUnitForMarket("KRW-BTC", 123456), 100);
  assert.equal(priceUnitForMarket("KRW-BTC", 1234), 1);
  assert.equal(priceUnitForMarket("KRW-BTC", 12.34), 0.1);
  assert.equal(priceUnitForMarket("BTC-ETH", 0.012345678), 0.00000001);
  assert.equal(priceUnitForMarket("USDT-BTC", 12.345), 0.01);
  assert.equal(priceUnitForMarket("USDT-BTC", 1.2345), 0.001);
  assert.equal(priceUnitForMarket("USDT-BTC", 0.12345), 0.0001);
});

test("Upbit market policy normalizes limit prices without crossing observed best", () => {
  const bid = normalizeLimitPrice({ market: "KRW-BTC", price: 123456, side: "bid" });
  const ask = normalizeLimitPrice({ market: "KRW-BTC", price: 123456, side: "ask" });

  assert.equal(bid.price, "123400");
  assert.equal(ask.price, "123500");
  assert.equal(bid.priceUnit, 100);
  assert.equal(ask.priceUnit, 100);
  assert.equal(bid.priceWasRounded, true);
  assert.equal(ask.priceWasRounded, true);
});

test("orders/chance minimum totals override fallback market minimums", () => {
  const policy = policyForMarket("KRW-BTC", {
    market: {
      id: "KRW-BTC",
      bid: { min_total: "10000" },
      ask: { min_total: "7000" },
    },
  });

  assert.equal(policy.bid.minTotal, 10000);
  assert.equal(policy.ask.minTotal, 7000);
  assert.equal(hasCompleteMarketPolicy(policy), true);
  assert.equal(hasCompleteMarketPolicy({ ...policy, ask: {} }), true);
  assert.equal(hasCompleteMarketPolicy({ ...policy, quoteAsset: "UNKNOWN", bid: {}, ask: {}, minTotal: null }), false);
});

test("market policy validates order totals before submission", () => {
  const policy = policyForMarket("KRW-BTC");
  const order = {
    market: "KRW-BTC",
    side: "bid",
    ord_type: "limit",
    price: "100",
    volume: "10",
  };

  assert.equal(orderTotal(order), 1000);
  assert.deepEqual(validateOrderMinimum(order, policy), {
    ok: false,
    total: 1000,
    minTotal: 5000,
    rejectionReason: "MIN_ORDER_TOTAL",
  });
});
