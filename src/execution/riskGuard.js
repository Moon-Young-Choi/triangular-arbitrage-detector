const { evaluateExecutionLatencyBudget } = require("../core/performanceBudget");

class TokenBucketRateLimiter {
  constructor(options = {}) {
    const limit = Number(options.limitPerSecond);
    this.limitPerSecond = Number.isFinite(limit) ? limit : 8;
    this.timestamps = [];
  }

  allow(nowMs = Date.now()) {
    const cutoff = nowMs - 1000;
    this.timestamps = this.timestamps.filter((item) => item >= cutoff);

    if (this.timestamps.length >= this.limitPerSecond) {
      return false;
    }

    this.timestamps.push(nowMs);
    return true;
  }
}

class RiskGuard {
  constructor(options = {}) {
    this.config = options.config || {};
    this.consecutiveFailures = 0;
    this.cycleTimestamps = [];
    this.openOrderCount = 0;
    this.dailyLossByAsset = {};
    this.rateLimiter = options.rateLimiter || new TokenBucketRateLimiter({
      limitPerSecond: this.config.executionGuards && this.config.executionGuards.orderRateLimitPerSecond,
    });
  }

  reject(reason, details = {}) {
    return {
      ok: false,
      rejectionReason: reason,
      machineReason: reason,
      emergencyStop: false,
      ...details,
    };
  }

  accept(details = {}) {
    return {
      ok: true,
      rejectionReason: null,
      emergencyStop: false,
      ...details,
    };
  }

  recordFailure(reason) {
    this.consecutiveFailures += 1;
    const limit = this.config.realRunLimits && this.config.realRunLimits.maxConsecutiveFailures;

    return {
      emergencyStop: Number.isFinite(Number(limit)) && this.consecutiveFailures >= limit,
      reason,
    };
  }

  recordSuccess() {
    this.consecutiveFailures = 0;
  }

  recordOrderOpened() {
    this.openOrderCount += 1;
  }

  recordOrderClosed() {
    this.openOrderCount = Math.max(0, this.openOrderCount - 1);
  }

  evaluateOrderGuards(context = {}) {
    const execution = this.config.executionGuards || {};
    const nowMs = context.nowMs || Date.now();

    if (context.emergencyStopActive === true) {
      return this.reject("EMERGENCY_STOP_ACTIVE", {
        emergencyStop: true,
        emergencyStopReason: context.emergencyStopReason || null,
      });
    }

    if (context.privateWsConnected !== true) {
      return this.reject("PRIVATE_WS_DISCONNECTED");
    }

    if (context.orderChanceFresh !== true) {
      return this.reject("ORDER_CHANCE_STALE");
    }

    if (context.accountBalanceFresh !== true) {
      return this.reject("ACCOUNT_BALANCE_STALE");
    }

    if (context.validationDepthFresh !== true) {
      return this.reject("VALIDATION_ORDERBOOK_STALE");
    }

    if (!this.rateLimiter.allow(nowMs)) {
      return this.reject("ORDER_RATE_LIMIT", {
        limitPerSecond: execution.orderRateLimitPerSecond,
      });
    }

    return this.accept();
  }

  evaluateExecutionLatency(execution = {}) {
    const result = evaluateExecutionLatencyBudget(execution, this.config.executionGuards || {});

    if (!result.ok) {
      return this.reject(result.rejectionReason, {
        metric: result.metric,
        observedMs: result.observedMs,
        limitMs: result.limitMs,
        emergencyStop: result.emergencyStop,
      });
    }

    return this.accept();
  }

  evaluatePlan(plan, context = {}) {
    const limits = this.config.realRunLimits || {};
    const market = this.config.marketDataGuards || {};
    const execution = this.config.executionGuards || {};
    const nowMs = context.nowMs || Date.now();
    const startAsset = plan.startAsset || (plan.cycle && plan.cycle.startAsset);
    const startAmount = Number(plan.startAmount || 0);
    const maxNotional = limits.maxNotionalPerCycleByAsset && Number(limits.maxNotionalPerCycleByAsset[startAsset]);
    const availableBalances = context.availableBalances || {};
    const lockedBalances = context.lockedBalances || {};
    const availableBalance = Number(availableBalances[startAsset]);
    const lockedBalance = Number(lockedBalances[startAsset] || 0);

    if (context.emergencyStopActive === true) {
      return this.reject("EMERGENCY_STOP_ACTIVE", {
        emergencyStop: true,
        emergencyStopReason: context.emergencyStopReason || null,
      });
    }

    if (startAsset && Number.isFinite(availableBalance) && startAmount > availableBalance) {
      return this.reject("BALANCE_INSUFFICIENT", {
        startAsset,
        startAmount,
        availableBalance,
        lockedBalance: Number.isFinite(lockedBalance) ? lockedBalance : null,
      });
    }

    if (Number.isFinite(maxNotional) && startAmount > maxNotional) {
      return this.reject("MAX_NOTIONAL_PER_CYCLE", { startAsset, startAmount, maxNotional });
    }

    if (this.openOrderCount >= Number(limits.maxOpenOrders || Infinity)) {
      return this.reject("MAX_OPEN_ORDERS");
    }

    if (context.skipCycleRateLimit !== true) {
      const cutoff = nowMs - 60000;
      this.cycleTimestamps = this.cycleTimestamps.filter((item) => item >= cutoff);
      if (this.cycleTimestamps.length >= Number(limits.maxCyclesPerMinute || Infinity)) {
        return this.reject("MAX_CYCLES_PER_MINUTE");
      }
    }

    if (Number(plan.oldestLegAgeMs || 0) > Number(market.maxOldestLegAgeMs || Infinity)) {
      return this.reject("MARKET_DATA_STALE");
    }

    if (Number(plan.legTimestampSkewMs || 0) > Number(market.maxLegTimestampSkewMs || Infinity)) {
      return this.reject("LEG_TIMESTAMP_SKEW");
    }

    if (Number(plan.exchangeToServerLatencyMs || 0) > Number(market.maxExchangeToServerLatencyMs || Infinity)) {
      return this.reject("EXCHANGE_TO_SERVER_LATENCY");
    }

    if (Number(plan.decisionAgeMs || 0) > Number(market.maxDecisionAgeMs || Infinity)) {
      return this.reject("DECISION_STALE");
    }

    const dailyLossByAsset = context.dailyLossByAsset || {};
    const dailyLoss = Number(dailyLossByAsset[startAsset] ?? context.dailyLoss ?? 0);
    const maxDailyLoss = Number(limits.maxDailyLossByAsset && limits.maxDailyLossByAsset[startAsset] || Infinity);

    if (dailyLoss > 0 && dailyLoss >= maxDailyLoss) {
      return this.reject("MAX_DAILY_LOSS", {
        startAsset,
        dailyLoss,
        maxDailyLoss,
        emergencyStop: true,
      });
    }

    if (context.skipOrderGuards === true) {
      return this.accept();
    }

    const orderGuard = this.evaluateOrderGuards({ ...context, nowMs });
    if (!orderGuard.ok) {
      return orderGuard;
    }

    return this.accept();
  }

  recordCycleStart(nowMs = Date.now()) {
    this.cycleTimestamps.push(nowMs);
  }

  evaluatePartialFill(event = {}) {
    if (event.partialFillPattern === "unexpected") {
      return {
        ok: false,
        emergencyStop: true,
        rejectionReason: "UNEXPECTED_PARTIAL_FILL_PATTERN",
      };
    }

    return this.accept();
  }

  evaluatePrivateWsDisconnect(activeExecutionCount = 0) {
    if (activeExecutionCount > 0) {
      return {
        ok: false,
        emergencyStop: true,
        rejectionReason: "PRIVATE_WS_DISCONNECT_DURING_ACTIVE_EXECUTION",
      };
    }

    return this.accept();
  }
}

module.exports = {
  TokenBucketRateLimiter,
  RiskGuard,
};
