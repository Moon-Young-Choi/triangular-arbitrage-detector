const crypto = require("node:crypto");
const { parseMarket } = require("../lib/marketGraph");
const { RiskGuard } = require("./riskGuard");
const { perfNowNs } = require("../core/timingTrace");

function firstUnit(orderbook) {
  const unit = orderbook && Array.isArray(orderbook.orderbook_units) && orderbook.orderbook_units[0];
  if (!unit) throw new Error("Missing validation orderbook best unit");
  return {
    askPrice: Number(unit.ask_price),
    bidPrice: Number(unit.bid_price),
    askSize: Number(unit.ask_size),
    bidSize: Number(unit.bid_size),
  };
}

function getOrderbook(orderbooks, market) {
  return orderbooks instanceof Map ? orderbooks.get(market) : orderbooks[market];
}

function numericString(value, digits = 12) {
  return Number(value).toFixed(digits).replace(/\.?0+$/u, "");
}

class RealExecutor {
  constructor(options = {}) {
    this.restClient = options.restClient;
    this.fillTracker = options.fillTracker || null;
    this.logStore = options.logStore || null;
    this.runtimeConfig = options.runtimeConfig || {};
    this.riskGuard = options.riskGuard || new RiskGuard({
      config: this.runtimeConfig.executionPolicy || {},
    });
    this.liveTradingEnabled = options.liveTradingEnabled === true || this.runtimeConfig.liveTradingEnabled === true;
    this.reconcileTimeoutMs = options.reconcileTimeoutMs || 3000;
    this.fillEventPollMs = options.fillEventPollMs || 50;
  }

  assertEnabled() {
    if (!this.liveTradingEnabled) {
      throw new Error("RealExecutor refused because liveTradingEnabled=false");
    }

    if (!this.restClient) {
      throw new Error("RealExecutor requires restClient");
    }
  }

  emit(kind, payload) {
    const event = {
      timestamp: new Date().toISOString(),
      mode: "REAL",
      executionMode: this.runtimeConfig.executionMode || "LIMIT_IOC_AT_OBSERVED_BEST",
      ...payload,
    };

    if (this.logStore) {
      this.logStore.append(kind, event).catch(() => {});
    }

    return event;
  }

  currentGuardContext(context = {}) {
    if (typeof context.getGuardContext === "function") {
      return {
        ...context,
        ...context.getGuardContext(),
      };
    }

    return context;
  }

  buildOrderForLeg(step, amount, orderbook, identifier) {
    const mode = this.runtimeConfig.executionMode || "LIMIT_IOC_AT_OBSERVED_BEST";
    const { quote, base } = parseMarket(step.market);
    const unit = firstUnit(orderbook);

    if (step.fromAsset === quote && step.toAsset === base) {
      const cappedQuote = Math.min(amount, unit.askPrice * unit.askSize);
      if (mode === "BEST_IOC") {
        return {
          market: step.market,
          side: "bid",
          ord_type: "best",
          price: numericString(cappedQuote),
          time_in_force: "ioc",
          identifier,
          observedBestPrice: unit.askPrice,
          expectedOutputAmount: cappedQuote / unit.askPrice,
        };
      }

      return {
        market: step.market,
        side: "bid",
        ord_type: "limit",
        volume: numericString(cappedQuote / unit.askPrice),
        price: numericString(unit.askPrice),
        time_in_force: "ioc",
        identifier,
        observedBestPrice: unit.askPrice,
        expectedOutputAmount: cappedQuote / unit.askPrice,
      };
    }

    if (step.fromAsset === base && step.toAsset === quote) {
      const cappedBase = Math.min(amount, unit.bidSize);
      return {
        market: step.market,
        side: "ask",
        ord_type: mode === "BEST_IOC" ? "best" : "limit",
        volume: numericString(cappedBase),
        price: mode === "BEST_IOC" ? undefined : numericString(unit.bidPrice),
        time_in_force: "ioc",
        identifier,
        observedBestPrice: unit.bidPrice,
        expectedOutputAmount: cappedBase * unit.bidPrice,
      };
    }

    throw new Error(`Market ${step.market} cannot convert ${step.fromAsset} -> ${step.toAsset}`);
  }

  async reconcileOrder(orderAck, identifier) {
    if (orderAck && (orderAck.uuid || orderAck.identifier)) {
      try {
        return await this.restClient.getOrder({
          uuid: orderAck.uuid,
          identifier: orderAck.identifier || identifier,
        });
      } catch (_error) {
        return orderAck;
      }
    }

    return orderAck;
  }

  async waitForTrackedOrder(orderAck, identifier) {
    if (!this.fillTracker || typeof this.fillTracker.findOrder !== "function") {
      return null;
    }

    const deadline = Date.now() + this.reconcileTimeoutMs;

    while (Date.now() <= deadline) {
      if (typeof this.fillTracker.findFill === "function") {
        const fill = this.fillTracker.findFill({
          uuid: orderAck && orderAck.uuid,
          identifier,
        });

        if (fill) {
          return fill;
        }
      }

      const tracked = this.fillTracker.findOrder({
        uuid: orderAck && orderAck.uuid,
        identifier,
      });

      if (tracked && (
        Number(tracked.executed_volume ?? tracked.executedVolume ?? 0) > 0 ||
        ["trade", "done"].includes(tracked.state)
      )) {
        return tracked;
      }

      await new Promise((resolve) => setTimeout(resolve, this.fillEventPollMs));
    }

    return null;
  }

  amountAfterFill(step, order) {
    const executedVolume = Number(order.executed_volume ?? order.executedVolume ?? order.volume ?? 0);
    const avgPrice = Number(order.avg_price ?? order.avgPrice ?? order.price ?? 0);
    const paidFee = Number(order.paid_fee ?? order.paidFee ?? 0);
    const { quote, base } = parseMarket(step.market);

    if (!(executedVolume > 0)) {
      return {
        ok: false,
        reason: "ZERO_FILL",
      };
    }

    if (step.fromAsset === quote && step.toAsset === base) {
      return {
        ok: true,
        amount: Math.max(0, executedVolume - paidFee),
        executedVolume,
        avgPrice,
        paidFee,
      };
    }

    return {
      ok: true,
      amount: Math.max(0, executedVolume * avgPrice - paidFee),
      executedVolume,
      avgPrice,
      paidFee,
    };
  }

  async execute(plan, context = {}) {
    this.assertEnabled();

    const guard = this.riskGuard.evaluatePlan(plan, {
      ...this.currentGuardContext(context),
      skipOrderGuards: true,
    });
    if (!guard.ok) {
      this.emit("orders", {
        type: "order.rejected",
        planId: plan.planId,
        cycleId: plan.cycle && plan.cycle.cycleId,
        startAsset: plan.startAsset || (plan.cycle && plan.cycle.startAsset),
        strategyId: plan.strategyId,
        rejectionReason: guard.rejectionReason,
      });
      return {
        ok: false,
        reason: guard.rejectionReason,
        emergencyStop: guard.emergencyStop,
      };
    }

    let amount = Number(plan.startAmount);
    this.riskGuard.recordCycleStart(context.nowMs || Date.now());

    for (const step of plan.cycle.steps) {
      const orderGuard = this.riskGuard.evaluateOrderGuards(this.currentGuardContext(context));
      if (!orderGuard.ok) {
        const failure = this.riskGuard.recordFailure(orderGuard.rejectionReason);
        this.emit("orders", {
          type: "order.rejected",
          planId: plan.planId,
          cycleId: plan.cycle.cycleId,
          startAsset: plan.startAsset || plan.cycle.startAsset,
          strategyId: plan.strategyId,
          legIndex: step.index + 1,
          rejectionReason: orderGuard.rejectionReason,
          emergencyStop: failure.emergencyStop,
        });
        return {
          ok: false,
          reason: orderGuard.rejectionReason,
          emergencyStop: failure.emergencyStop,
        };
      }

      const orderbook = getOrderbook(plan.validationOrderbooks, step.market);
      const identifier = `qg-${Date.now()}-${crypto.randomUUID()}`;
      const order = this.buildOrderForLeg(step, amount, orderbook, identifier);
      const orderSubmitStartPerfNs = perfNowNs();

      this.emit("orders", {
        type: "order.intent",
        planId: plan.planId,
        cycleId: plan.cycle.cycleId,
        startAsset: plan.startAsset || plan.cycle.startAsset,
        strategyId: plan.strategyId,
        legIndex: step.index + 1,
        order,
      });

      this.riskGuard.recordOrderOpened();
      let ack;
      try {
        ack = await this.restClient.createOrder(order);
      } finally {
        this.riskGuard.recordOrderClosed();
      }
      const orderAckPerfNs = perfNowNs();
      this.emit("orders", {
        type: "order.ack",
        planId: plan.planId,
        cycleId: plan.cycle.cycleId,
        startAsset: plan.startAsset || plan.cycle.startAsset,
        strategyId: plan.strategyId,
        legIndex: step.index + 1,
        uuid: ack.uuid,
        identifier,
        orderSubmitStartPerfNs,
        orderAckPerfNs,
      });

      const tracked = await this.waitForTrackedOrder(ack, identifier);
      const reconciled = tracked || await this.reconcileOrder(ack, identifier);
      const fill = this.amountAfterFill(step, reconciled);

      if (!fill.ok) {
        const failure = this.riskGuard.recordFailure(fill.reason);
        this.emit("orders", {
          type: "cycle.real_fail",
          planId: plan.planId,
          cycleId: plan.cycle.cycleId,
          startAsset: plan.startAsset || plan.cycle.startAsset,
          strategyId: plan.strategyId,
          reason: fill.reason,
          residualAsset: step.fromAsset,
          emergencyStop: failure.emergencyStop,
        });
        return {
          ok: false,
          reason: fill.reason,
          emergencyStop: failure.emergencyStop,
        };
      }

      amount = fill.amount;
      this.emit("fills", {
        type: "fill",
        planId: plan.planId,
        cycleId: plan.cycle.cycleId,
        startAsset: plan.startAsset || plan.cycle.startAsset,
        strategyId: plan.strategyId,
        legIndex: step.index + 1,
        market: step.market,
        uuid: reconciled && reconciled.uuid,
        identifier,
        executedVolume: fill.executedVolume,
        avgPrice: fill.avgPrice,
        paidFee: fill.paidFee,
        outputAmount: amount,
        source: tracked ? "private-ws" : "rest-reconcile",
        privateWsFillReceivePerfNs: tracked ? perfNowNs() : null,
      });
      const minOrderAmount = Number(this.runtimeConfig.candidateValidation &&
        this.runtimeConfig.candidateValidation.minOrderAmountByAsset &&
        this.runtimeConfig.candidateValidation.minOrderAmountByAsset[step.toAsset] || 0);

      if (amount < minOrderAmount && step.index < plan.cycle.steps.length - 1) {
        this.emit("orders", {
          type: "cycle.real_fail",
          planId: plan.planId,
          cycleId: plan.cycle.cycleId,
          startAsset: plan.startAsset || plan.cycle.startAsset,
          strategyId: plan.strategyId,
          reason: "PARTIAL_FILL_BELOW_MIN_THRESHOLD",
          residualAsset: step.toAsset,
          actualAmount: amount,
        });
        return {
          ok: false,
          reason: "PARTIAL_FILL_BELOW_MIN_THRESHOLD",
          residualAsset: step.toAsset,
          actualAmount: amount,
        };
      }
    }

    this.riskGuard.recordSuccess();
    this.emit("orders", {
      type: "cycle.real_done",
      planId: plan.planId,
      cycleId: plan.cycle.cycleId,
      startAsset: plan.startAsset || plan.cycle.startAsset,
      strategyId: plan.strategyId,
      outputAmount: amount,
      pnl: amount - Number(plan.startAmount),
    });

    return {
      ok: true,
      mode: "REAL",
      outputAmount: amount,
      pnl: amount - Number(plan.startAmount),
    };
  }
}

module.exports = {
  RealExecutor,
  firstUnit,
};
