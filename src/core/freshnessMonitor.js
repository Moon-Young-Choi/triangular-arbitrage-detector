function orderbookReceivedAtMs(orderbook) {
  const receivedAt = Number(orderbook && (orderbook.serverReceivedAtMs ?? orderbook.receivedAt ?? orderbook.timestamp));
  return Number.isFinite(receivedAt) ? receivedAt : null;
}

function orderbookWsConfirmed(orderbook) {
  if (!orderbook) return false;
  if (orderbook.wsConfirmed === true) return true;
  if (orderbook.firstWsReceivedAt || orderbook.lastWsReceivedAt) return true;

  const streamType = String(orderbook.streamType || orderbook.stream_type || "").toUpperCase();
  return streamType !== "" && streamType !== "REST" && streamType !== "UNKNOWN";
}

function orderbookDataState(orderbook, stale) {
  if (!orderbook) return "missing";
  const sourceState = orderbook.sourceState;

  if (sourceState === "rest_only") return "rest_only";
  if (sourceState === "missing") return "missing";
  if (sourceState === "stale") return "stale";
  if (orderbookWsConfirmed(orderbook)) return stale ? "quiet" : "ws_confirmed";

  const streamType = String(orderbook.streamType || orderbook.stream_type || "").toUpperCase();
  if (streamType === "REST") return "rest_only";
  return stale ? "stale" : "ws_confirmed";
}

function orderbookFreshness(orderbook, nowMs = Date.now(), staleOrderbookMs = 3000) {
  const receivedAt = orderbookReceivedAtMs(orderbook);
  const ageMs = receivedAt === null ? null : Math.max(0, nowMs - receivedAt);
  const fresh = ageMs !== null && ageMs <= staleOrderbookMs;
  const stale = !fresh;
  const wsConfirmed = orderbookWsConfirmed(orderbook);
  const dataState = orderbookDataState(orderbook, stale);

  return {
    fresh,
    stale,
    ageMs,
    receivedAt,
    staleOrderbookMs,
    streamType: orderbook && (orderbook.streamType || orderbook.stream_type) || null,
    sourceState: orderbook && orderbook.sourceState || dataState,
    dataState,
    wsConfirmed,
    quiet: dataState === "quiet",
    restOnly: dataState === "rest_only",
    firstWsReceivedAt: orderbook && orderbook.firstWsReceivedAt || null,
    lastWsReceivedAt: orderbook && orderbook.lastWsReceivedAt || null,
  };
}

function iterableOrderbooks(orderbooks) {
  if (!orderbooks) return [];
  if (orderbooks instanceof Map) return [...orderbooks.values()];
  if (Array.isArray(orderbooks)) return orderbooks;
  if (typeof orderbooks.values === "function") return [...orderbooks.values()];
  return Object.values(orderbooks);
}

function summarizeOrderbookFreshness(orderbooks, nowMs = Date.now(), staleOrderbookMs = 3000) {
  const rows = iterableOrderbooks(orderbooks)
    .map((orderbook) => ({
      market: orderbook && orderbook.market,
      ...orderbookFreshness(orderbook, nowMs, staleOrderbookMs),
    }));
  const ages = rows.map((row) => row.ageMs).filter(Number.isFinite);
  const sourceStateCounts = rows.reduce((counts, row) => {
    const key = row.dataState || row.sourceState || "unknown";
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});

  return {
    marketCount: rows.length,
    staleCount: rows.filter((row) => row.stale).length,
    freshCount: rows.filter((row) => row.fresh).length,
    restOnlyCount: rows.filter((row) => row.restOnly).length,
    wsConfirmedCount: rows.filter((row) => row.wsConfirmed).length,
    quietCount: rows.filter((row) => row.quiet).length,
    sourceStateCounts,
    oldestAgeMs: ages.length > 0 ? Math.max(...ages) : null,
    newestAgeMs: ages.length > 0 ? Math.min(...ages) : null,
    rows,
  };
}

module.exports = {
  orderbookFreshness,
  orderbookReceivedAtMs,
  orderbookWsConfirmed,
  summarizeOrderbookFreshness,
};
