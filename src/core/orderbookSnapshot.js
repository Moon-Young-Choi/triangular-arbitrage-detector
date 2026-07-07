function cloneOrderbookUnit(unit) {
  return {
    ask_price: Number(unit.ask_price ?? unit.askPrice),
    bid_price: Number(unit.bid_price ?? unit.bidPrice),
    ask_size: Number(unit.ask_size ?? unit.askSize),
    bid_size: Number(unit.bid_size ?? unit.bidSize),
  };
}

function normalizeOrderbookSnapshot(orderbook, options = {}) {
  const orderbookUnit = options.orderbookUnit || 1;
  const receivedAt = options.receivedAt ?? Date.now();
  const units = orderbook && Array.isArray(orderbook.orderbook_units)
    ? orderbook.orderbook_units.slice(0, orderbookUnit).map(cloneOrderbookUnit)
    : [];
  const best = units[0];

  const market = orderbook && (orderbook.market || orderbook.code);

  if (!orderbook || !market || !best) {
    return null;
  }

  const exchangeTimestampMs = Number(orderbook.exchangeTimestampMs ?? orderbook.timestamp ?? orderbook.tms);
  const serverReceivedAtMs = Number(orderbook.serverReceivedAtMs ?? orderbook.receivedAt ?? receivedAt);
  const localSequence = Number.isInteger(options.localSequence)
    ? options.localSequence
    : orderbook.localSequence ?? null;
  const traceId = orderbook.traceId ||
    [
      options.storeName || "orderbook",
      market,
      Number.isFinite(exchangeTimestampMs) ? exchangeTimestampMs : "no-exchange-ts",
      localSequence ?? "no-seq",
    ].join(":");

  return {
    exchange: orderbook.exchange || "upbit",
    market,
    askPrice: Number(best.ask_price),
    bidPrice: Number(best.bid_price),
    askSize: Number(best.ask_size),
    bidSize: Number(best.bid_size),
    timestamp: exchangeTimestampMs,
    exchangeTimestampMs,
    streamType: orderbook.streamType || orderbook.stream_type || "UNKNOWN",
    receivedAt: serverReceivedAtMs,
    serverReceivedAtMs,
    sourceState: orderbook.sourceState || null,
    wsConfirmed: orderbook.wsConfirmed === true,
    firstWsReceivedAt: orderbook.firstWsReceivedAt || null,
    lastWsReceivedAt: orderbook.lastWsReceivedAt || null,
    wsMessageCount: Number.isFinite(Number(orderbook.wsMessageCount)) ? Number(orderbook.wsMessageCount) : 0,
    localSequence,
    traceId,
    unit: orderbookUnit,
    orderbookUnit,
    orderbookLevel: orderbook.orderbookLevel ?? orderbook.level ?? null,
    orderbook_units: units,
    orderbookUnits: units,
    timings: orderbook.timings || {},
  };
}

function normalizeStoreOrderbook(orderbook, orderbookUnit, receivedAt = Date.now(), metadata = {}) {
  return normalizeOrderbookSnapshot(orderbook, {
    ...metadata,
    orderbookUnit,
    receivedAt,
  });
}

module.exports = {
  cloneOrderbookUnit,
  normalizeOrderbookSnapshot,
  normalizeStoreOrderbook,
};
