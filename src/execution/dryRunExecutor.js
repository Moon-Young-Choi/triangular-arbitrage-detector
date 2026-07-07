const { simulateCycleWithDepth } = require("../lib/depthSimulator");
const { mergeValidationConfig } = require("../live/candidateValidator");
const { diffNsToMs, perfNowNs } = require("../core/timingTrace");
const { CapitalAllocator } = require("./capitalAllocator");

function cycleExecutionMeta(cycle = {}) {
  return {
    triangleId: cycle.triangleId,
    direction: cycle.direction,
    directionLabel: cycle.directionLabel,
    route: Array.isArray(cycle.route) ? cycle.route.slice() : null,
    routeLabel: cycle.routeLabel,
    markets: Array.isArray(cycle.markets) ? cycle.markets.slice() : null,
  };
}

class DryRunExecutor {
  constructor(options = {}) {
    this.capitalAllocator = options.capitalAllocator || new CapitalAllocator({
      balances: options.simulatedBalances || {
        KRW: 1000000,
        BTC: 0.05,
        USDT: 1000,
      },
      maxAllocatableByAsset: options.maxAllocatableByAsset,
    });
    this.logStore = options.logStore || null;
    this.logWriteQueue = Promise.resolve();
    this.events = [];
    this.validationConfig = mergeValidationConfig(options.validationConfig);
    this.latencyLimitMs = options.latencyLimitMs || 2000;
    this.activeEngineState = null;
  }

  get balances() {
    return this.capitalAllocator.availableBalances();
  }

  capitalSnapshot() {
    return this.capitalAllocator.snapshot();
  }

  emit(type, payload = {}) {
    const event = {
      type,
      timestamp: new Date().toISOString(),
      mode: "DRY_RUN",
      engineState: payload.engineState ?? this.activeEngineState ?? null,
      ...payload,
    };

    this.events.push(event);

    if (this.logStore) {
      const kind = type.startsWith("order.") ? "orders" : "events";
      this.logWriteQueue = this.logWriteQueue
        .then(async () => {
          await this.logStore.append(kind, event);

          if (type === "order.simulated_fill") {
            await this.logStore.append("fills", event);
          }
        })
        .catch(() => {});
    }

    return event;
  }

  async flushLogs() {
    await this.logWriteQueue;
  }

  emitCycleDone(planMeta, payload = {}) {
    return this.emit("cycle.done", {
      ...planMeta,
      ...payload,
      runType: "DRY_RUN_SIMULATION",
      legacyType: "cycle.simulated_done",
      excludeFromDryRunSummary: true,
    });
  }

  emitCycleAborted(planMeta, payload = {}) {
    return this.emit("cycle.aborted", {
      ...planMeta,
      ...payload,
      runType: "DRY_RUN_SIMULATION",
      legacyType: "cycle.simulated_fail",
      excludeFromDryRunSummary: true,
    });
  }

  guard(plan) {
    const startAsset = plan.startAsset || (plan.cycle && plan.cycle.startAsset);
    const startAmount = Number(plan.startAmount || this.validationConfig.startAmountByAsset[startAsset] || 0);
    const minOrderAmount = Number(this.validationConfig.minOrderAmountByAsset[startAsset] || 0);

    if (plan.engineState && plan.engineState !== "RUNNING") {
      return { ok: false, reason: "EXECUTION_PAUSED" };
    }

    if (startAmount < minOrderAmount) {
      return { ok: false, reason: "MIN_ORDER_AMOUNT_NOT_MET" };
    }

    const allocation = this.capitalAllocator.previewAllocation({
      startAsset,
      requestedAmount: startAmount,
    });

    if (!allocation.ok) {
      return {
        ok: false,
        reason: allocation.rejectionReason,
        capital: allocation.bucket,
      };
    }

    if (Number(plan.latencyMs || 0) > this.latencyLimitMs) {
      return { ok: false, reason: "LATENCY_GUARD" };
    }

    return {
      ok: true,
      startAsset,
      startAmount,
      capital: allocation.bucket,
      maxAllocatableAmount: allocation.maxAllocatableAmount,
    };
  }

  async execute(plan) {
    this.activeEngineState = plan.engineState || "RUNNING";
    const planId = plan.planId || plan.cycleId || (plan.cycle && plan.cycle.cycleId);
    const planMeta = {
      planId,
      cycleId: plan.cycleId || (plan.cycle && plan.cycle.cycleId),
      routeVariantId: plan.routeVariantId || (plan.cycle && plan.cycle.routeVariantId),
      startAsset: plan.startAsset || (plan.cycle && plan.cycle.startAsset),
      strategyId: plan.strategyId,
      engineState: this.activeEngineState,
      marketState: plan.marketState || plan.status,
      opportunityClass: plan.opportunityClass,
      executionMode: plan.executionMode || "LIMIT_IOC_AT_OBSERVED_BEST",
      expectedNetProfit: plan.expectedNetProfit,
      latencyMs: plan.latencyMs,
      bestLevelTouchRatio: plan.bestLevelTouchRatio,
      expectedSlippageBps: plan.expectedSlippageBps,
      ...cycleExecutionMeta(plan.cycle),
    };
    const guarded = this.guard(plan);

    this.emit("order.intent", {
      ...planMeta,
      startAsset: guarded.startAsset || plan.startAsset,
      startAmount: guarded.startAmount || plan.startAmount,
      capital: guarded.capital,
    });

    if (!guarded.ok) {
      this.emit("cycle.simulated_fail", { ...planMeta, reason: guarded.reason });
      this.emitCycleAborted(planMeta, { reason: guarded.reason });
      await this.flushLogs();
      return {
        ok: false,
        mode: "DRY_RUN",
        reason: guarded.reason,
        events: this.events.slice(),
      };
    }

    const allocation = this.capitalAllocator.reserve({
      startAsset: guarded.startAsset,
      amount: guarded.startAmount,
      planId,
      cycleId: planMeta.cycleId,
    });

    if (!allocation.ok) {
      this.emit("cycle.simulated_fail", { ...planMeta, reason: allocation.rejectionReason });
      this.emitCycleAborted(planMeta, { reason: allocation.rejectionReason });
      await this.flushLogs();
      return {
        ok: false,
        mode: "DRY_RUN",
        reason: allocation.rejectionReason,
        events: this.events.slice(),
      };
    }

    this.emit("capital.reserved", {
      ...planMeta,
      allocationId: allocation.allocationId,
      reservedAmount: allocation.reservedAmount,
      capital: allocation.bucket,
    });

    const cycleStartPerfNs = perfNowNs();
    const simulated = simulateCycleWithDepth(
      plan.cycle,
      plan.validationOrderbooks,
      guarded.startAmount,
      plan.feeRate || 0,
      {
        nowMs: plan.nowMs,
        staleOrderbookMs: plan.staleOrderbookMs,
        maxDepthLevels: plan.maxDepthLevels || 1,
        validateOrderTotals: true,
        feePolicyByMarket: plan.feePolicyByMarket,
        marketPolicyByMarket: plan.marketPolicyByMarket,
        resolveLegFee: plan.resolveLegFee,
        useDefaultFeePolicy: plan.useDefaultFeePolicy === true,
        expectedMaker: plan.expectedMaker === true,
        orderType: plan.orderType || "limit",
        timeInForce: plan.timeInForce || "ioc",
      },
    );

    if (!simulated.available) {
      this.capitalAllocator.release(allocation.allocationId);
      this.emit("cycle.simulated_fail", {
        ...planMeta,
        reason: simulated.rejectionCode || "DEPTH_GUARD",
        limitingLeg: simulated.limitingLeg,
        limitingMarket: simulated.limitingMarket,
      });
      this.emitCycleAborted(planMeta, {
        reason: simulated.rejectionCode || "DEPTH_GUARD",
        limitingLeg: simulated.limitingLeg,
        limitingMarket: simulated.limitingMarket,
      });
      await this.flushLogs();
      return {
        ok: false,
        mode: "DRY_RUN",
        reason: simulated.rejectionCode || "DEPTH_GUARD",
        events: this.events.slice(),
      };
    }

    const simulatedLegs = simulated.legs.map((leg) => ({
      ...leg,
      executionLatency: {
        simulated: true,
        legTotalMs: 0,
        source: "dry-run",
      },
    }));

    this.emit("order.accepted", planMeta);

    for (const leg of simulatedLegs) {
      this.emit("order.simulated_fill", {
        ...planMeta,
        legIndex: leg.legIndex,
        market: leg.market,
        side: leg.feeSide,
        fromAsset: leg.fromAsset,
        toAsset: leg.toAsset,
        inputAmount: leg.inputAmount,
        outputAmount: leg.outputAmount,
        action: leg.action,
        usedSide: leg.usedSide,
        feeSide: leg.feeSide,
        feeRate: leg.feeRate,
        feeAmount: leg.feeAmount,
        feeAsset: leg.feeAsset,
        tradeAmount: leg.tradeAmount,
        grossOutputAmount: leg.grossOutputAmount,
        netOutputAmount: leg.netOutputAmount,
        averagePrice: leg.averagePrice,
        bestPrice: leg.bestPrice,
        expectedSlippageBps: leg.expectedSlippageBps,
        bestLevelTouchRatio: leg.bestLevelTouchRatio,
        residualAfterOrder: leg.residualAfterOrder,
      });
    }

    const pnl = simulated.outputAmount - guarded.startAmount;
    const cycleExecutionLatency = {
      simulated: true,
      cycleTotalMs: diffNsToMs(perfNowNs(), cycleStartPerfNs),
      legs: simulatedLegs.map((leg) => ({
        legIndex: leg.legIndex,
        market: leg.market,
        simulated: true,
        legTotalMs: 0,
      })),
    };
    const settled = this.capitalAllocator.settle(allocation.allocationId, simulated.outputAmount);
    this.emit("cycle.simulated_done", {
      ...planMeta,
      startAsset: guarded.startAsset,
      startAmount: guarded.startAmount,
      pnl,
      outputAmount: simulated.outputAmount,
      profitRate: simulated.profitRate,
      simulatedNetProfit: pnl,
      expectedSimulatedGap: Number(plan.expectedNetProfit || 0) - pnl,
      legResults: simulatedLegs,
      cycleExecutionLatency,
      capitalBefore: guarded.capital,
      capitalAfter: settled.bucket,
      capital: settled.bucket,
    });
    this.emitCycleDone(planMeta, {
      startAsset: guarded.startAsset,
      startAmount: guarded.startAmount,
      pnl,
      outputAmount: simulated.outputAmount,
      profitRate: simulated.profitRate,
      simulatedNetProfit: pnl,
      expectedSimulatedGap: Number(plan.expectedNetProfit || 0) - pnl,
      legResults: simulatedLegs,
      cycleExecutionLatency,
      capitalBefore: guarded.capital,
      capitalAfter: settled.bucket,
      capital: settled.bucket,
    });

    await this.flushLogs();
    return {
      ok: true,
      mode: "DRY_RUN",
      pnl,
      startAsset: guarded.startAsset,
      startAmount: guarded.startAmount,
      outputAmount: simulated.outputAmount,
      profitRate: simulated.profitRate,
      legResults: simulatedLegs,
      cycleExecutionLatency,
      capitalBefore: guarded.capital,
      capitalAfter: settled.bucket,
      events: this.events.slice(),
    };
  }
}

module.exports = {
  DryRunExecutor,
};
