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
        mode: this.mode || "REAL",
        order,
      }).catch(() => {});
    }

    return order;
  }

  handleMyOrder(event) {
    const order = this.upsertOrder(event);

    if (event.state === "trade" || event.tradeFee !== null || event.paidFee !== null) {
      const fill = {
        type: "fill",
        mode: this.mode || "REAL",
        uuid: event.uuid,
        identifier: event.identifier,
        market: event.market,
        side: event.side,
        price: event.price,
        avgPrice: event.avgPrice,
        volume: event.volume,
        executedVolume: event.executedVolume,
        paidFee: event.paidFee,
        tradeFee: event.tradeFee,
        isMaker: event.isMaker,
        tradeTimestamp: event.tradeTimestamp,
        eventTimestamp: event.eventTimestamp,
      };

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
};
