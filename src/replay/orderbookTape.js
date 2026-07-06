function cloneUnit(unit = {}) {
  return {
    ask_price: Number(unit.ask_price ?? unit.askPrice),
    bid_price: Number(unit.bid_price ?? unit.bidPrice),
    ask_size: Number(unit.ask_size ?? unit.askSize),
    bid_size: Number(unit.bid_size ?? unit.bidSize),
  };
}

function normalizeTapeEntry(entry = {}, index = 0) {
  const market = entry.market || entry.code;
  const orderbookUnits = (entry.orderbook_units || entry.orderbookUnits || []).map(cloneUnit);

  if (!market) {
    throw new Error(`Replay orderbook entry ${index} is missing market`);
  }

  if (orderbookUnits.length === 0) {
    throw new Error(`Replay orderbook entry ${index} has no orderbook units`);
  }

  const exchangeTimestampMs = Number(entry.exchangeTimestampMs ?? entry.timestamp ?? entry.tms ?? entry.at ?? 0);
  const serverReceivedAtMs = Number(entry.serverReceivedAtMs ?? entry.receivedAt ?? exchangeTimestampMs);

  return {
    exchange: entry.exchange || "upbit",
    market,
    timestamp: exchangeTimestampMs,
    exchangeTimestampMs,
    receivedAt: serverReceivedAtMs,
    serverReceivedAtMs,
    streamType: entry.streamType || entry.stream_type || "REPLAY",
    orderbookUnit: Number(entry.orderbookUnit || entry.unit || orderbookUnits.length),
    unit: Number(entry.unit || entry.orderbookUnit || orderbookUnits.length),
    orderbookLevel: entry.orderbookLevel ?? entry.level ?? null,
    orderbook_units: orderbookUnits,
    orderbookUnits,
    traceId: entry.traceId || `replay:${market}:${exchangeTimestampMs}:${index + 1}`,
    tapeIndex: index,
  };
}

function buildOrderbookTape(entries = []) {
  return entries
    .map((entry, index) => normalizeTapeEntry(entry, index))
    .sort((left, right) => (
      left.serverReceivedAtMs - right.serverReceivedAtMs ||
      left.exchangeTimestampMs - right.exchangeTimestampMs ||
      left.tapeIndex - right.tapeIndex
    ));
}

function latestOrderbooksAt(tapeEntries = [], nowMs = Infinity, options = {}) {
  const markets = options.markets ? new Set(options.markets) : null;
  const latest = new Map();

  for (const entry of buildOrderbookTape(tapeEntries)) {
    if (entry.serverReceivedAtMs > nowMs) {
      continue;
    }

    if (markets && !markets.has(entry.market)) {
      continue;
    }

    latest.set(entry.market, entry);
  }

  return latest;
}

module.exports = {
  buildOrderbookTape,
  latestOrderbooksAt,
  normalizeTapeEntry,
};
