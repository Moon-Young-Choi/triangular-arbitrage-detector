const test = require("node:test");
const assert = require("node:assert/strict");
const { UpbitWsOrderbookClient, normalizeOrderbookMessage } = require("../src/upbit/wsOrderbookClient");
const {
  ObservationOrderbookStore,
  ValidationOrderbookStore,
} = require("../src/live/orderbookStore");

function payload(unitCount) {
  return {
    type: "orderbook",
    code: "KRW-BTC",
    timestamp: 1000,
    stream_type: "REALTIME",
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

  assert.equal(normalized.market, "KRW-BTC");
  assert.equal(normalized.orderbookUnit, 30);
  assert.equal(normalized.orderbook_units.length, 30);
  assert.equal(normalized.askPrice, 100);
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
  assert.equal(observation.getStatus(1010).staleCount, 0);
  assert.equal(validation.getStatus(7000).staleCount, 1);
});
