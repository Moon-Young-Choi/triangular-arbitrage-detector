const crypto = require("node:crypto");
const { perfNowNs } = require("../core/timingTrace");
const { OrderReconciler } = require("./orderReconciler");
const { TokenBucketRateLimiter } = require("./riskGuards");

function cleanSegment(value, fallback = "x") {
  const cleaned = String(value || fallback)
    .replace(/[^a-zA-Z0-9_-]/gu, "")
    .slice(0, 12);
  return cleaned || fallback;
}

class OrderManager {
  constructor(options = {}) {
    this.restClient = options.restClient;
    this.fillTracker = options.fillTracker || null;
    this.logStore = options.logStore || null;
    this.identifierPrefix = cleanSegment(options.identifierPrefix || "qg", "qg").slice(0, 8);
    this.usedIdentifiers = new Set(options.usedIdentifiers || []);
    this.orderRateLimitPerSecond = Number.isFinite(Number(options.orderRateLimitPerSecond))
      ? Number(options.orderRateLimitPerSecond)
      : 8;
    this.rateLimiter = options.rateLimiter || new TokenBucketRateLimiter({
      limitPerSecond: this.orderRateLimitPerSecond,
    });
    this.orderReconciler = options.orderReconciler || new OrderReconciler({
      restClient: this.restClient,
      fillTracker: this.fillTracker,
      logStore: this.logStore,
      timeoutMs: options.reconcileTimeoutMs,
      pollMs: options.fillEventPollMs,
    });
  }

  append(payload) {
    if (this.logStore) {
      this.logStore.append("orders", payload).catch(() => {});
    }
  }

  summarizeSubmitError(error) {
    const response = error && error.response;
    const data = response && response.data;
    const upbitError = data && data.error;

    return {
      message: upbitError && upbitError.message || error && error.message || "Order submit failed",
      code: upbitError && upbitError.name || error && error.code || "ORDER_SUBMIT_FAILED",
      status: response && response.status || null,
    };
  }

  createIdentifier(metadata = {}) {
    const timestamp = Date.now().toString(36);
    const leg = cleanSegment(metadata.legIndex || "l", "l");
    const plan = cleanSegment(metadata.planId || metadata.cycleId || "p", "p");

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const random = crypto.randomBytes(6).toString("hex");
      const identifier = `${this.identifierPrefix}-${timestamp}-${leg}-${plan}-${random}`.slice(0, 64);
      if (!this.usedIdentifiers.has(identifier)) {
        return identifier;
      }
    }

    throw new Error("ORDER_IDENTIFIER_GENERATION_FAILED");
  }

  reserveIdentifier(identifier) {
    const value = String(identifier || "").trim();

    if (!value) {
      throw new Error("ORDER_IDENTIFIER_REQUIRED");
    }

    if (value.length > 64) {
      throw new Error("ORDER_IDENTIFIER_TOO_LONG");
    }

    if (this.usedIdentifiers.has(value)) {
      throw new Error("DUPLICATE_ORDER_IDENTIFIER");
    }

    this.usedIdentifiers.add(value);
    return value;
  }

  async submitOrder(order, metadata = {}) {
    if (!this.restClient || typeof this.restClient.createOrder !== "function") {
      throw new Error("OrderManager requires restClient.createOrder");
    }

    const nowMs = metadata.nowMs || Date.now();
    if (this.rateLimiter && !this.rateLimiter.allow(nowMs)) {
      const error = new Error("ORDER_RATE_LIMIT");
      error.code = "ORDER_RATE_LIMIT";
      error.limitPerSecond = this.orderRateLimitPerSecond;
      this.append({
        type: "order.rejected",
        mode: "REAL",
        rejectionReason: "ORDER_RATE_LIMIT",
        limitPerSecond: this.orderRateLimitPerSecond,
        order,
        ...metadata,
      });
      throw error;
    }

    const identifier = this.reserveIdentifier(order.identifier || this.createIdentifier(metadata));
    const submittedOrder = {
      ...order,
      identifier,
    };
    if (metadata.orderCapacityReservation && typeof metadata.orderCapacityReservation.commit === "function") {
      metadata.orderCapacityReservation.commit(1);
      this.append({
        type: "order.capacity_committed",
        mode: "REAL",
        reservationId: metadata.orderCapacityReservation.id,
        reservationRemaining: metadata.orderCapacityReservation.remaining,
        order: submittedOrder,
        ...metadata,
        orderCapacityReservation: undefined,
      });
    }
    const orderSubmitStartPerfNs = perfNowNs();
    this.append({
      type: "order.submitted",
      mode: "REAL",
      order: submittedOrder,
      orderSubmitStartPerfNs,
      ...metadata,
    });
    let ack;
    try {
      ack = await this.restClient.createOrder(submittedOrder);
    } catch (error) {
      this.append({
        type: "order.submit_failed",
        mode: "REAL",
        order: submittedOrder,
        identifier,
        rejectionReason: error && error.code === "ORDER_RATE_LIMIT" ? "ORDER_RATE_LIMIT" : "ORDER_SUBMIT_FAILED",
        error: this.summarizeSubmitError(error),
        ...metadata,
      });
      throw error;
    }
    const orderAckPerfNs = perfNowNs();
    const ackWithIds = {
      ...ack,
      uuid: ack && ack.uuid,
      identifier: ack && ack.identifier || identifier,
    };

    if (this.fillTracker && typeof this.fillTracker.upsertOrder === "function") {
      this.fillTracker.upsertOrder({
        ...ackWithIds,
        ...metadata,
      });
    }

    return {
      identifier,
      order: submittedOrder,
      ack: ackWithIds,
      orderSubmitStartPerfNs,
      orderAckPerfNs,
    };
  }

  async reconcileSubmittedOrder(options = {}) {
    return this.orderReconciler.reconcile(options);
  }

  async cancelOpenOrders(openOrders = [], metadata = {}) {
    if (!this.restClient || typeof this.restClient.cancelOrder !== "function") {
      throw new Error("OrderManager requires restClient.cancelOrder");
    }

    const results = [];

    for (const order of openOrders) {
      if (!order.uuid && !order.identifier) {
        const error = new Error("ORDER_CANCEL_IDENTIFIER_REQUIRED");
        this.append({
          type: "order.cancel_failed",
          mode: "REAL",
          exchange: order.exchange || "upbit",
          ...metadata,
          planId: order.planId || metadata.planId,
          cycleId: order.cycleId || metadata.cycleId,
          routeVariantId: order.routeVariantId || metadata.routeVariantId,
          startAsset: order.startAsset || metadata.startAsset,
          strategyId: order.strategyId || metadata.strategyId,
          legIndex: order.legIndex || metadata.legIndex,
          market: order.market,
          state: order.state,
          error: {
            message: error.message,
            code: "ORDER_CANCEL_IDENTIFIER_REQUIRED",
            status: null,
          },
        });
        results.push({
          ok: false,
          order,
          params: null,
          error,
        });
        continue;
      }

      const params = order.uuid ? { uuid: order.uuid } : { identifier: order.identifier };
      const cancelMeta = {
        mode: "REAL",
        exchange: order.exchange || "upbit",
        ...metadata,
        planId: order.planId || metadata.planId,
        cycleId: order.cycleId || metadata.cycleId,
        routeVariantId: order.routeVariantId || metadata.routeVariantId,
        startAsset: order.startAsset || metadata.startAsset,
        strategyId: order.strategyId || metadata.strategyId,
        legIndex: order.legIndex || metadata.legIndex,
        uuid: order.uuid,
        identifier: order.identifier,
        market: order.market,
      };

      this.append({
        type: "order.cancel_requested",
        params,
        state: order.state,
        ...cancelMeta,
      });

      try {
        const ack = await this.restClient.cancelOrder(params);
        const tracked = {
          ...ack,
          uuid: ack && ack.uuid || order.uuid,
          identifier: ack && ack.identifier || order.identifier,
          market: ack && ack.market || order.market,
          state: ack && ack.state || "cancel",
          ...cancelMeta,
        };

        if (this.fillTracker && typeof this.fillTracker.upsertOrder === "function") {
          this.fillTracker.upsertOrder(tracked);
        }

        this.append({
          type: "order.cancel_ack",
          ack: tracked,
          state: tracked.state,
          ...cancelMeta,
        });
        results.push({
          ok: true,
          order,
          params,
          ack: tracked,
        });
      } catch (error) {
        this.append({
          type: "order.cancel_failed",
          params,
          error: {
            message: error.message,
            code: error.code || null,
            status: error.response && error.response.status || null,
          },
          state: order.state,
          ...cancelMeta,
        });
        results.push({
          ok: false,
          order,
          params,
          error,
        });
      }
    }

    return results;
  }
}

module.exports = {
  OrderManager,
};
