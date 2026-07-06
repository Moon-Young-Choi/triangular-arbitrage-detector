const test = require("node:test");
const assert = require("node:assert/strict");
const { UpbitWsOrderbookClient, normalizeOrderbookMessage } = require("../src/exchanges/upbit/publicWsOrderbookClient");
const {
  ObservationOrderbookStore,
  ValidationOrderbookStore,
} = require("../src/core/orderbookStore");
const { normalizeOrderbookSnapshot } = require("../src/core/orderbookSnapshot");
const { summarizeOrderbookFreshness } = require("../src/core/freshnessMonitor");

function payload(unitCount, extra = {}) {
  return {
    type: "orderbook",
    code: "KRW-BTC",
    timestamp: 1000,
    stream_type: "REALTIME",
    ...extra,
    orderbook_units: Array.from({ length: unitCount }, (_item, index) => ({
      ask_price: 100 + index,
      bid_price: 90 - index,
      ask_size: 10 + index,
      bid_size: 9 + index,
    })),
  };
}

test("Upbit orderbook normalization preserves received depth units", () => {
  const normalized = normalizeOrderbookMessage(payload(30), 1010);

  assert.equal(normalized.exchange, "upbit");
  assert.equal(normalized.market, "KRW-BTC");
  assert.equal(normalized.orderbookUnit, 30);
  assert.equal(normalized.unit, 30);
  assert.equal(normalized.orderbook_units.length, 30);
  assert.equal(normalized.orderbookUnits.length, 30);
  assert.equal(normalized.askPrice, 100);
  assert.equal(normalized.exchangeTimestampMs, 1000);
  assert.equal(normalized.serverReceivedAtMs, 1010);
});

test("core orderbook snapshot normalization assigns trace metadata", () => {
  const normalized = normalizeOrderbookSnapshot(payload(30), {
    orderbookUnit: 5,
    receivedAt: 1010,
    localSequence: 7,
    storeName: "observation",
  });

  assert.equal(normalized.market, "KRW-BTC");
  assert.equal(normalized.orderbook_units.length, 5);
  assert.equal(normalized.traceId, "observation:KRW-BTC:1000:7");
  assert.equal(normalized.localSequence, 7);
  assert.equal(normalized.serverReceivedAtMs, 1010);
});

test("Upbit orderbook normalization preserves grouping level separately from depth unit", () => {
  const normalized = normalizeOrderbookMessage(payload(30, { level: 100000 }), 1010);
  const validation = new ValidationOrderbookStore({ staleOrderbookMs: 5000 });

  validation.update(normalized, 1010);

  assert.equal(normalized.orderbookUnit, 30);
  assert.equal(normalized.orderbookLevel, 100000);
  assert.equal(validation.get("KRW-BTC").orderbookUnit, 30);
  assert.equal(validation.get("KRW-BTC").orderbookLevel, 100000);
});

test("Upbit orderbook client exposes configured subscription unit", () => {
  const observationClient = new UpbitWsOrderbookClient(["KRW-BTC"], { orderbookUnit: 5 });
  const validationClient = new UpbitWsOrderbookClient(["KRW-BTC"], { orderbookUnit: 30 });

  assert.equal(observationClient.getStatus().orderbookUnit, 5);
  assert.equal(validationClient.getStatus().orderbookUnit, 30);
});

test("observation and validation stores retain their configured depth", () => {
  const normalized = normalizeOrderbookMessage(payload(30), 1010);
  const observation = new ObservationOrderbookStore({ staleOrderbookMs: 5000 });
  const validation = new ValidationOrderbookStore({ staleOrderbookMs: 5000 });

  observation.update(normalized, 1010);
  validation.update(normalized, 1010);

  assert.equal(observation.get("KRW-BTC").orderbook_units.length, 5);
  assert.equal(validation.get("KRW-BTC").orderbook_units.length, 30);
  assert.equal(observation.get("KRW-BTC").unit, 5);
  assert.equal(validation.get("KRW-BTC").unit, 30);
  assert.equal(observation.get("KRW-BTC").localSequence, 1);
  assert.equal(validation.get("KRW-BTC").localSequence, 1);
  assert.equal(observation.get("KRW-BTC").traceId, "observation:KRW-BTC:1000:1");
  assert.equal(validation.get("KRW-BTC").traceId, "validation:KRW-BTC:1000:1");
  assert.equal(observation.get("KRW-BTC").exchangeTimestampMs, 1000);
  assert.equal(observation.get("KRW-BTC").serverReceivedAtMs, 1010);
  assert.equal(observation.getStatus(1010).staleCount, 0);
  assert.equal(observation.getStatus(1010).localSequence, 1);
  assert.equal(validation.getStatus(7000).staleCount, 1);
  assert.equal(validation.getStatus(7000).oldestAgeMs, 5990);
  assert.equal(summarizeOrderbookFreshness(validation.orderbooks, 7000, 5000).staleCount, 1);
});
