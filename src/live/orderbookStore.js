function cloneUnit(unit) {
  return {
    ask_price: Number(unit.ask_price ?? unit.askPrice),
    bid_price: Number(unit.bid_price ?? unit.bidPrice),
    ask_size: Number(unit.ask_size ?? unit.askSize),
    bid_size: Number(unit.bid_size ?? unit.bidSize),
  };
}

function normalizeStoreOrderbook(orderbook, orderbookUnit, receivedAt = Date.now()) {
  const units = orderbook && Array.isArray(orderbook.orderbook_units)
    ? orderbook.orderbook_units.slice(0, orderbookUnit).map(cloneUnit)
    : [];
  const best = units[0];

  if (!orderbook || !orderbook.market || !best) {
    return null;
  }

  return {
    market: orderbook.market,
    askPrice: Number(best.ask_price),
    bidPrice: Number(best.bid_price),
    askSize: Number(best.ask_size),
    bidSize: Number(best.bid_size),
    timestamp: Number(orderbook.timestamp || orderbook.tms),
    streamType: orderbook.streamType || orderbook.stream_type || "UNKNOWN",
    receivedAt: orderbook.receivedAt || receivedAt,
    orderbookUnit,
    orderbook_units: units,
    timings: orderbook.timings || {},
  };
}

class OrderbookStore {
  constructor(options = {}) {
    this.name = options.name || "orderbook";
    this.orderbookUnit = options.orderbookUnit || 1;
    this.staleOrderbookMs = options.staleOrderbookMs || 3000;
    this.metrics = options.metrics || null;
    this.orderbooks = new Map();
    this.lastUpdatedAt = null;
    this.latencySamples = [];
    this.maxLatencySamples = options.maxLatencySamples || 1000;
  }

  update(orderbook, nowMs = Date.now()) {
    const normalized = normalizeStoreOrderbook(orderbook, this.orderbookUnit, nowMs);

    if (!normalized) {
      return null;
    }

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
    let count = 0;

    for (const orderbook of this.orderbooks.values()) {
      const receivedAt = orderbook.receivedAt || orderbook.timestamp;

      if (!receivedAt || nowMs - receivedAt > this.staleOrderbookMs) {
        count += 1;
      }
    }

    return count;
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
    return {
      name: this.name,
      orderbookUnit: this.orderbookUnit,
      marketCount: this.orderbooks.size,
      staleCount: this.staleCount(nowMs),
      averageLatencyMs: this.averageLatency(nowMs),
      lastUpdatedAt: this.lastUpdatedAt,
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
