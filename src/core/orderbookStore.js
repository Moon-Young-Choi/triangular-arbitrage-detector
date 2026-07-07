const { summarizeOrderbookFreshness } = require("./freshnessMonitor");
const { normalizeStoreOrderbook } = require("./orderbookSnapshot");

class OrderbookStore {
  constructor(options = {}) {
    this.name = options.name || "orderbook";
    this.orderbookUnit = options.orderbookUnit || 1;
    this.staleOrderbookMs = options.staleOrderbookMs || 3000;
    this.metrics = options.metrics || null;
    this.orderbooks = new Map();
    this.lastUpdatedAt = null;
    this.localSequence = 0;
    this.latencySamples = [];
    this.maxLatencySamples = options.maxLatencySamples || 1000;
  }

  update(orderbook, nowMs = Date.now()) {
    const nextSequence = this.localSequence + 1;
    const previousMarket = orderbook && (orderbook.market || orderbook.code);
    const previous = previousMarket ? this.orderbooks.get(previousMarket) : null;
    const normalized = normalizeStoreOrderbook(orderbook, this.orderbookUnit, nowMs, {
      localSequence: nextSequence,
      storeName: this.name,
    });

    if (!normalized) {
      return null;
    }

    this.localSequence = nextSequence;
    const streamType = String(normalized.streamType || "").toUpperCase();
    const isWsUpdate = streamType !== "REST";
    const receivedAt = normalized.receivedAt || nowMs;
    const firstWsReceivedAt = isWsUpdate
      ? (previous && previous.firstWsReceivedAt || receivedAt)
      : (previous && previous.firstWsReceivedAt || normalized.firstWsReceivedAt || null);
    const lastWsReceivedAt = isWsUpdate
      ? receivedAt
      : (previous && previous.lastWsReceivedAt || normalized.lastWsReceivedAt || null);
    const wsMessageCount = (previous && Number(previous.wsMessageCount) || 0) + (isWsUpdate ? 1 : 0);

    normalized.firstWsReceivedAt = firstWsReceivedAt;
    normalized.lastWsReceivedAt = lastWsReceivedAt;
    normalized.wsMessageCount = wsMessageCount;
    normalized.wsConfirmed = Boolean(firstWsReceivedAt);
    normalized.sourceState = normalized.wsConfirmed ? "ws_confirmed" : "rest_only";
    this.orderbooks.set(normalized.market, normalized);
    this.lastUpdatedAt = new Date(normalized.receivedAt || nowMs).toISOString();

    if (this.metrics && normalized.streamType !== "REST") {
      this.metrics.increment(`${this.name}OrderbookMessages`);
    }

    const latencyMs = Number.isFinite(normalized.timestamp) && Number.isFinite(normalized.receivedAt)
      ? normalized.receivedAt - normalized.timestamp
      : null;

    if (Number.isFinite(latencyMs)) {
      this.latencySamples.push({ t: nowMs, v: latencyMs });

      if (this.latencySamples.length > this.maxLatencySamples) {
        this.latencySamples = this.latencySamples.slice(-this.maxLatencySamples);
      }
    }

    return normalized;
  }

  get(market) {
    return this.orderbooks.get(market);
  }

  entries() {
    return this.orderbooks.entries();
  }

  values() {
    return this.orderbooks.values();
  }

  staleCount(nowMs = Date.now()) {
    return summarizeOrderbookFreshness(this.orderbooks, nowMs, this.staleOrderbookMs).staleCount;
  }

  averageLatency(nowMs = Date.now(), windowMs = 10000) {
    const cutoff = nowMs - windowMs;
    const samples = this.latencySamples
      .filter((sample) => sample.t >= cutoff && Number.isFinite(sample.v))
      .map((sample) => sample.v);

    if (samples.length === 0) {
      return null;
    }

    return samples.reduce((sum, value) => sum + value, 0) / samples.length;
  }

  getStatus(nowMs = Date.now()) {
    const freshness = summarizeOrderbookFreshness(this.orderbooks, nowMs, this.staleOrderbookMs);

    return {
      name: this.name,
      orderbookUnit: this.orderbookUnit,
      marketCount: this.orderbooks.size,
      staleCount: freshness.staleCount,
      restOnlyCount: freshness.restOnlyCount,
      wsConfirmedCount: freshness.wsConfirmedCount,
      quietCount: freshness.quietCount,
      sourceStateCounts: freshness.sourceStateCounts,
      averageLatencyMs: this.averageLatency(nowMs),
      lastUpdatedAt: this.lastUpdatedAt,
      localSequence: this.localSequence,
      oldestAgeMs: freshness.oldestAgeMs,
      newestAgeMs: freshness.newestAgeMs,
    };
  }
}

class ObservationOrderbookStore extends OrderbookStore {
  constructor(options = {}) {
    super({
      ...options,
      name: "observation",
      orderbookUnit: options.orderbookUnit || 5,
    });
  }
}

class ValidationOrderbookStore extends OrderbookStore {
  constructor(options = {}) {
    super({
      ...options,
      name: "validation",
      orderbookUnit: options.orderbookUnit || 30,
    });
  }
}

module.exports = {
  OrderbookStore,
  ObservationOrderbookStore,
  ValidationOrderbookStore,
  normalizeStoreOrderbook,
};
