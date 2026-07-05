const { simulateCycleWithDepth } = require("../lib/depthSimulator");
const { mergeValidationConfig } = require("../live/candidateValidator");

function cloneBalances(balances = {}) {
  return Object.fromEntries(
    Object.entries(balances).map(([asset, value]) => [asset, Number(value)]),
  );
}

class DryRunExecutor {
  constructor(options = {}) {
    this.balances = cloneBalances(options.simulatedBalances || {
      KRW: 1000000,
      BTC: 0.05,
      USDT: 1000,
    });
    this.logStore = options.logStore || null;
    this.events = [];
    this.validationConfig = mergeValidationConfig(options.validationConfig);
    this.latencyLimitMs = options.latencyLimitMs || 2000;
  }

  emit(type, payload = {}) {
    const event = {
      type,
      timestamp: new Date().toISOString(),
      mode: "DRY_RUN",
      ...payload,
    };

    this.events.push(event);

    if (this.logStore) {
      const kind = type.startsWith("order.") ? "orders" : "events";
      this.logStore.append(kind, event).catch(() => {});

      if (type === "order.simulated_fill") {
        this.logStore.append("fills", event).catch(() => {});
      }
    }

    return event;
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

    if ((this.balances[startAsset] || 0) < startAmount) {
      return { ok: false, reason: "BALANCE_INSUFFICIENT" };
    }

    if (Number(plan.latencyMs || 0) > this.latencyLimitMs) {
      return { ok: false, reason: "LATENCY_GUARD" };
    }

    return { ok: true, startAsset, startAmount };
  }

  async execute(plan) {
    const planId = plan.planId || plan.cycleId || (plan.cycle && plan.cycle.cycleId);
    const planMeta = {
      planId,
      cycleId: plan.cycleId || (plan.cycle && plan.cycle.cycleId),
      startAsset: plan.startAsset || (plan.cycle && plan.cycle.startAsset),
      strategyId: plan.strategyId,
      executionMode: plan.executionMode || "LIMIT_IOC_AT_OBSERVED_BEST",
      expectedNetProfit: plan.expectedNetProfit,
      latencyMs: plan.latencyMs,
    };
    const guarded = this.guard(plan);

    this.emit("order.intent", {
      ...planMeta,
      startAsset: guarded.startAsset || plan.startAsset,
      startAmount: guarded.startAmount || plan.startAmount,
    });

    if (!guarded.ok) {
      this.emit("cycle.simulated_fail", { ...planMeta, reason: guarded.reason });
      return {
        ok: false,
        mode: "DRY_RUN",
        reason: guarded.reason,
        events: this.events.slice(),
      };
    }

    const simulated = simulateCycleWithDepth(
      plan.cycle,
      plan.validationOrderbooks,
      guarded.startAmount,
      plan.feeRate || 0,
      {
        nowMs: plan.nowMs,
        staleOrderbookMs: plan.staleOrderbookMs,
      },
    );

    if (!simulated.available) {
      this.emit("cycle.simulated_fail", {
        ...planMeta,
        reason: simulated.rejectionCode || "DEPTH_GUARD",
      });
      return {
        ok: false,
        mode: "DRY_RUN",
        reason: simulated.rejectionCode || "DEPTH_GUARD",
        events: this.events.slice(),
      };
    }

    this.emit("order.accepted", planMeta);

    for (const leg of simulated.legs) {
      this.emit("order.simulated_fill", {
        ...planMeta,
        legIndex: leg.legIndex,
        market: leg.market,
        inputAmount: leg.inputAmount,
        outputAmount: leg.outputAmount,
        expectedSlippageBps: leg.expectedSlippageBps,
      });
    }

    const pnl = simulated.outputAmount - guarded.startAmount;
    this.balances[guarded.startAsset] = (this.balances[guarded.startAsset] || 0) + pnl;
    this.emit("cycle.simulated_done", {
      ...planMeta,
      startAsset: guarded.startAsset,
      pnl,
      outputAmount: simulated.outputAmount,
      profitRate: simulated.profitRate,
    });

    return {
      ok: true,
      mode: "DRY_RUN",
      pnl,
      startAsset: guarded.startAsset,
      outputAmount: simulated.outputAmount,
      profitRate: simulated.profitRate,
      events: this.events.slice(),
    };
  }
}

module.exports = {
  DryRunExecutor,
};
