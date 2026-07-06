const CLOSED_CANCEL_STATES = new Set(["cancel", "cancelled", "canceled"]);
const FILL_STATES = new Set(["trade", "done"]);
const META_KEYS = [
  "planId",
  "cycleId",
  "routeVariantId",
  "startAsset",
  "strategyId",
  "engineState",
  "executionMode",
  "legIndex",
];

function valueFrom(source = {}, snakeKey, camelKey) {
  if (source[camelKey] !== undefined) return source[camelKey];
  return source[snakeKey];
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function hasValue(value) {
  return value !== null && value !== undefined;
}

function normalizedState(order = {}) {
  return String(order.state || "").toLowerCase();
}

function extractMetadata(order = {}) {
  return Object.fromEntries(
    META_KEYS
      .filter((key) => order[key] !== undefined)
      .map((key) => [key, order[key]]),
  );
}

function hasFillEvidence(order = {}) {
  const executedVolume = numberOrNull(valueFrom(order, "executed_volume", "executedVolume"));
  const paidFee = numberOrNull(valueFrom(order, "paid_fee", "paidFee"));
  const tradeFee = numberOrNull(valueFrom(order, "trade_fee", "tradeFee"));

  return FILL_STATES.has(normalizedState(order)) ||
    Number(executedVolume || 0) > 0 ||
    hasValue(paidFee) ||
    hasValue(tradeFee);
}

function buildFillEvent(order = {}, mode = "REAL") {
  const executedVolume = numberOrNull(valueFrom(order, "executed_volume", "executedVolume"));
  const requestedVolume = numberOrNull(order.volume);
  const remainingVolume = numberOrNull(valueFrom(order, "remaining_volume", "remainingVolume"));
  const paidFee = numberOrNull(valueFrom(order, "paid_fee", "paidFee"));
  const tradeFee = numberOrNull(valueFrom(order, "trade_fee", "tradeFee"));
  const avgPrice = numberOrNull(valueFrom(order, "avg_price", "avgPrice"));
  const price = numberOrNull(order.price);
  const isPartial = Number(remainingVolume || 0) > 0 ||
    (Number(requestedVolume || 0) > 0 &&
      Number(executedVolume || 0) > 0 &&
      Number(executedVolume) < Number(requestedVolume));

  return {
    type: isPartial ? "order.partial" : "order.fill",
    mode: order.mode || mode || "REAL",
    exchange: order.exchange || "upbit",
    ...extractMetadata(order),
    uuid: order.uuid,
    identifier: order.identifier,
    market: order.market,
    side: order.side,
    state: order.state,
    source: order.source || "private-ws",
    price,
    avgPrice,
    volume: requestedVolume,
    requestedVolume,
    executedVolume,
    remainingVolume,
    paidFee,
    tradeFee,
    isMaker: order.isMaker ?? order.is_maker ?? null,
    isPartial,
    tradeTimestamp: valueFrom(order, "trade_timestamp", "tradeTimestamp"),
    orderTimestamp: valueFrom(order, "order_timestamp", "orderTimestamp"),
    eventTimestamp: valueFrom(order, "event_timestamp", "eventTimestamp"),
  };
}

class FillTracker {
  constructor(options = {}) {
    this.ordersByUuid = new Map();
    this.ordersByIdentifier = new Map();
    this.fills = [];
    this.logStore = options.logStore || null;
    this.maxFills = options.maxFills || 200;
    this.mode = options.mode || "REAL";
  }

  upsertOrder(event) {
    const key = event.uuid || event.identifier;
    const current = key ? this.ordersByUuid.get(event.uuid) || this.ordersByIdentifier.get(event.identifier) || {} : {};
    const order = {
      ...current,
      ...event,
      mode: event.mode || this.mode || "REAL",
      updatedAt: new Date().toISOString(),
    };

    if (event.uuid) {
      this.ordersByUuid.set(event.uuid, order);
    }

    if (event.identifier) {
      this.ordersByIdentifier.set(event.identifier, order);
    }

    if (this.logStore) {
      this.logStore.append("orders", {
        type: "order.update",
        mode: order.mode || this.mode || "REAL",
        exchange: order.exchange || "upbit",
        ...extractMetadata(order),
        uuid: order.uuid,
        identifier: order.identifier,
        market: order.market,
        state: order.state,
        order,
      }).catch(() => {});

      if (CLOSED_CANCEL_STATES.has(normalizedState(order))) {
        this.logStore.append("orders", {
          type: "order.cancelled",
          mode: order.mode || this.mode || "REAL",
          exchange: order.exchange || "upbit",
          ...extractMetadata(order),
          uuid: order.uuid,
          identifier: order.identifier,
          market: order.market,
          state: order.state,
          reason: order.reason || order.cancelReason || null,
        }).catch(() => {});
      }
    }

    return order;
  }

  handleMyOrder(event) {
    const order = this.upsertOrder(event);

    if (hasFillEvidence(order)) {
      const fill = buildFillEvent(order, this.mode);

      this.fills.push(fill);

      if (this.fills.length > this.maxFills) {
        this.fills = this.fills.slice(-this.maxFills);
      }

      if (this.logStore) {
        this.logStore.append("fills", fill).catch(() => {});
      }
    }

    return order;
  }

  openOrders() {
    return [...this.ordersByUuid.values()].filter((order) => (
      ["wait", "watch", "pending"].includes(order.state)
    ));
  }

  handleStopPolicy(policy = "CANCEL_OPEN_ORDERS") {
    const openOrders = this.openOrders();
    const events = openOrders.map((order) => ({
      type: policy === "TRACK_UNTIL_RESOLVED" ? "order.track_until_resolved" : "order.cancel_intent",
      mode: this.mode || "REAL",
      uuid: order.uuid,
      identifier: order.identifier,
      market: order.market,
      state: order.state,
      stopPolicy: policy,
    }));

    for (const event of events) {
      if (this.logStore) {
        this.logStore.append("orders", event).catch(() => {});
      }
    }

    return events;
  }

  findOrder(params = {}) {
    if (params.uuid && this.ordersByUuid.has(params.uuid)) {
      return this.ordersByUuid.get(params.uuid);
    }

    if (params.identifier && this.ordersByIdentifier.has(params.identifier)) {
      return this.ordersByIdentifier.get(params.identifier);
    }

    return null;
  }

  findFill(params = {}) {
    return this.fills.find((fill) => (
      (params.uuid && fill.uuid === params.uuid) ||
      (params.identifier && fill.identifier === params.identifier)
    )) || null;
  }

  snapshot() {
    return {
      orders: [...this.ordersByUuid.values()].slice(-100),
      fills: this.fills.slice(-100),
    };
  }
}

module.exports = {
  FillTracker,
  buildFillEvent,
  hasFillEvidence,
};
