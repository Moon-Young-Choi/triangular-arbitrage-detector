const { perfNowNs } = require("../core/timingTrace");

function numberFromOrder(order, snakeKey, camelKey) {
  const value = order && (order[snakeKey] ?? order[camelKey]);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function hasExecutionEvidence(order = {}) {
  return numberFromOrder(order, "executed_volume", "executedVolume") > 0 ||
    ["trade", "done"].includes(order.state);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class OrderReconciler {
  constructor(options = {}) {
    this.restClient = options.restClient;
    this.fillTracker = options.fillTracker || null;
    this.logStore = options.logStore || null;
    this.timeoutMs = options.timeoutMs ?? options.reconcileTimeoutMs ?? 3000;
    this.pollMs = options.pollMs ?? options.fillEventPollMs ?? 50;
  }

  append(payload) {
    if (this.logStore) {
      this.logStore.append("orders", payload).catch(() => {});
    }
  }

  findTracked(orderAck = {}, identifier) {
    if (!this.fillTracker || typeof this.fillTracker.findOrder !== "function") {
      return null;
    }

    if (typeof this.fillTracker.findFill === "function") {
      const fill = this.fillTracker.findFill({
        uuid: orderAck.uuid,
        identifier,
      });

      if (fill) {
        return fill;
      }
    }

    const tracked = this.fillTracker.findOrder({
      uuid: orderAck.uuid,
      identifier,
    });

    return tracked && hasExecutionEvidence(tracked) ? tracked : null;
  }

  async waitForTrackedOrder(orderAck = {}, identifier) {
    if (!this.fillTracker || typeof this.fillTracker.findOrder !== "function") {
      return null;
    }

    const deadline = Date.now() + this.timeoutMs;

    while (Date.now() <= deadline) {
      const tracked = this.findTracked(orderAck, identifier);
      if (tracked) return tracked;
      await sleep(this.pollMs);
    }

    return null;
  }

  async queryRestOrder(orderAck = {}, identifier) {
    if (!this.restClient || typeof this.restClient.getOrder !== "function") {
      return null;
    }

    if (!orderAck.uuid && !identifier) {
      return null;
    }

    const order = await this.restClient.getOrder({
      uuid: orderAck.uuid,
      identifier: orderAck.identifier || identifier,
    });

    return {
      ...order,
      uuid: order.uuid || orderAck.uuid || null,
      identifier: order.identifier || orderAck.identifier || identifier || null,
    };
  }

  trackRestOrder(order, metadata = {}) {
    if (!order || !this.fillTracker) {
      return;
    }

    const trackedOrder = {
      ...order,
      ...metadata,
      source: "rest-query",
    };

    if (typeof this.fillTracker.handleMyOrder === "function") {
      this.fillTracker.handleMyOrder(trackedOrder);
      return;
    }

    if (typeof this.fillTracker.upsertOrder === "function") {
      this.fillTracker.upsertOrder(trackedOrder);
    }
  }

  async reconcile(options = {}) {
    const orderAck = options.orderAck || {};
    const identifier = options.identifier || orderAck.identifier || null;
    const metadata = options.metadata || {};
    const startedPerfNs = perfNowNs();
    const tracked = await this.waitForTrackedOrder(orderAck, identifier);

    if (tracked) {
      const donePerfNs = perfNowNs();
      this.append({
        type: "order.reconciled",
        mode: "REAL",
        source: "private-ws",
        uuid: tracked.uuid || orderAck.uuid,
        identifier,
        reconciliationStartedPerfNs: startedPerfNs,
        reconciliationDonePerfNs: donePerfNs,
        privateWsFillReceivePerfNs: donePerfNs,
        ...metadata,
      });
      return {
        order: tracked,
        source: "private-ws",
        timedOut: false,
        restQueried: false,
        reconciliationStartedPerfNs: startedPerfNs,
        reconciliationDonePerfNs: donePerfNs,
        privateWsFillReceivePerfNs: donePerfNs,
      };
    }

    let restOrder = null;
    let restError = null;
    let restQueried = false;
    const canQueryRest = this.restClient && typeof this.restClient.getOrder === "function" &&
      (orderAck.uuid || identifier);

    try {
      if (canQueryRest) {
        restQueried = true;
        restOrder = await this.queryRestOrder(orderAck, identifier);
      }
    } catch (error) {
      restError = error;
    }

    const donePerfNs = perfNowNs();

    if (restOrder) {
      this.trackRestOrder(restOrder, metadata);
      this.append({
        type: "order.reconciled",
        mode: "REAL",
        source: "rest-query",
        uuid: restOrder.uuid,
        identifier: restOrder.identifier || identifier,
        timedOutWaitingPrivateWs: true,
        reconciliationStartedPerfNs: startedPerfNs,
        reconciliationDonePerfNs: donePerfNs,
        orderQueryDonePerfNs: donePerfNs,
        ...metadata,
      });
      return {
        order: restOrder,
        source: "rest-query",
        timedOut: true,
        restQueried,
        reconciliationStartedPerfNs: startedPerfNs,
        reconciliationDonePerfNs: donePerfNs,
        orderQueryDonePerfNs: donePerfNs,
      };
    }

    const fallbackOrder = {
      ...orderAck,
      identifier: orderAck.identifier || identifier,
    };
    this.append({
      type: "order.reconciled",
      mode: "REAL",
      source: "ack-only",
      uuid: fallbackOrder.uuid,
      identifier: fallbackOrder.identifier,
      timedOutWaitingPrivateWs: true,
      restQueried,
      restError: restError && restError.message,
      reconciliationStartedPerfNs: startedPerfNs,
      reconciliationDonePerfNs: donePerfNs,
      ...metadata,
    });

    return {
      order: fallbackOrder,
      source: "ack-only",
      timedOut: true,
      restQueried,
      restError,
      reconciliationStartedPerfNs: startedPerfNs,
      reconciliationDonePerfNs: donePerfNs,
    };
  }
}

module.exports = {
  OrderReconciler,
  hasExecutionEvidence,
};
