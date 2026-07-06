function orderbookReceivedAtMs(orderbook) {
  const receivedAt = Number(orderbook && (orderbook.serverReceivedAtMs ?? orderbook.receivedAt ?? orderbook.timestamp));
  return Number.isFinite(receivedAt) ? receivedAt : null;
}

function orderbookFreshness(orderbook, nowMs = Date.now(), staleOrderbookMs = 3000) {
  const receivedAt = orderbookReceivedAtMs(orderbook);
  const ageMs = receivedAt === null ? null : Math.max(0, nowMs - receivedAt);
  const fresh = ageMs !== null && ageMs <= staleOrderbookMs;

  return {
    fresh,
    stale: !fresh,
    ageMs,
    receivedAt,
    staleOrderbookMs,
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

  return {
    marketCount: rows.length,
    staleCount: rows.filter((row) => row.stale).length,
    freshCount: rows.filter((row) => row.fresh).length,
    oldestAgeMs: ages.length > 0 ? Math.max(...ages) : null,
    newestAgeMs: ages.length > 0 ? Math.min(...ages) : null,
    rows,
  };
}

module.exports = {
  orderbookFreshness,
  orderbookReceivedAtMs,
  summarizeOrderbookFreshness,
};
