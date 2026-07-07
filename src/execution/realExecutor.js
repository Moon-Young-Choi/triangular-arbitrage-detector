const { parseMarket } = require("../lib/marketGraph");
const { resolveLegFeeRate } = require("../lib/depthSimulator");
const { DEFAULT_EXECUTION_MODE, BEST_IOC_EXECUTION_MODE } = require("./executionModes");
const {
  DEFAULT_PARTIAL_FILL_POLICY,
  evaluatePartialFillPolicy,
  resolvePartialFillPolicy,
} = require("./partialFillPolicy");
const { residualFromFill } = require("./residualAssetPolicy");
const { RiskGuard } = require("./riskGuards");
const { OrderManager } = require("./orderManager");
const { diffNsToMs } = require("../core/timingTrace");
const { summarizeLatency } = require("../core/performanceBudget");
const {
  loadMarketPolicy,
  normalizeLimitPrice,
  policyForMarket,
  validateOrderTotal,
} = require("../exchanges/upbit/marketPolicy");

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

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") {
    return false;
  }

  return Number.isFinite(Number(value));
}

function orderbookMeta(orderbook) {
  return {
    market: orderbook && orderbook.market,
    traceId: orderbook && orderbook.traceId,
    localSequence: orderbook && orderbook.localSequence,
    exchangeTimestampMs: orderbook && (orderbook.exchangeTimestampMs || orderbook.timestamp),
    serverReceivedAtMs: orderbook && (orderbook.serverReceivedAtMs || orderbook.receivedAt),
    orderbookUnit: orderbook && orderbook.orderbookUnit,
    streamType: orderbook && orderbook.streamType,
  };
}

function marketPolicyMeta(policy) {
  return {
    market: policy && policy.market,
    quoteAsset: policy && policy.quoteAsset,
    baseAsset: policy && policy.baseAsset,
    bidMinTotal: policy && policy.bid && policy.bid.minTotal,
    bidMaxTotal: policy && policy.bid && policy.bid.maxTotal,
    askMinTotal: policy && policy.ask && policy.ask.minTotal,
    askMaxTotal: policy && policy.ask && policy.ask.maxTotal,
    priceUnit: policy && policy.priceUnit,
    source: policy && policy.source,
    state: policy && policy.state,
  };
}

function ratioOrDefault(value, fallback) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(1, parsed));
}

function resolveLiquidityPolicy(runtimeConfig = {}, override = {}) {
  const candidate = runtimeConfig.candidateValidation || {};
  const execution = runtimeConfig.executionPolicy || {};
  const configured = {
    ...(execution.liquidityPolicy || {}),
    ...override,
  };
  const maxTouchRatioPerBestLevel = ratioOrDefault(
    configured.maxTouchRatioPerBestLevel ?? candidate.maxTouchRatioPerBestLevel,
    1,
  );
  const minResidualRatioPerBestLevel = ratioOrDefault(
    configured.minResidualRatioPerBestLevel ?? candidate.minResidualRatioPerBestLevel,
    0,
  );
  const effectiveBestLevelTouchRatio = Math.max(
    0,
    Math.min(maxTouchRatioPerBestLevel, 1 - minResidualRatioPerBestLevel),
  );

  return {
    maxTouchRatioPerBestLevel,
    minResidualRatioPerBestLevel,
    effectiveBestLevelTouchRatio,
    allowCrossingBeyondBest: configured.allowCrossingBeyondBest === true,
    maxSlippageBps: Number(configured.maxSlippageBps ?? 0),
  };
}

function liquidityCap({ requestedInputAmount, requestedVolume, bestLevelSize, price, inputAsset, policy }) {
  const bestSize = Number(bestLevelSize);
  const requestedSize = Number(requestedVolume);
  const numericPrice = Number(price);
  const allowedSize = Math.max(0, bestSize * Number(policy.effectiveBestLevelTouchRatio));
  const submittedVolume = Math.min(requestedSize, allowedSize);
  const submittedInputAmount = inputAsset === "quote"
    ? submittedVolume * numericPrice
    : submittedVolume;
  const unsubmittedInputAmount = Math.max(0, Number(requestedInputAmount) - submittedInputAmount);
  const bestLevelTouchRatio = bestSize > 0 ? submittedVolume / bestSize : 1;

  return {
    submittedVolume,
    submittedInputAmount,
    unsubmittedInputAmount,
    bestLevelTouchRatio,
    bestLevelSize: bestSize,
    maxBestLevelTouchRatio: policy.maxTouchRatioPerBestLevel,
    minBestLevelResidualRatio: policy.minResidualRatioPerBestLevel,
    effectiveBestLevelTouchRatio: policy.effectiveBestLevelTouchRatio,
    liquidityCapped: unsubmittedInputAmount > Math.max(Number(requestedInputAmount) * 1e-12, 1e-12),
  };
}

function feeRateFromContext(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed >= 1) return 0;
  return parsed;
}

function legFeeSide(step) {
  const { quote, base } = parseMarket(step.market);

  if (step.fromAsset === quote && step.toAsset === base) return "bid";
  if (step.fromAsset === base && step.toAsset === quote) return "ask";
  return null;
}

function summarizeFees(legResults = []) {
  return legResults.reduce((summary, leg) => {
    summary.totalPaidFee += Number(leg.paidFee || 0);
    summary.totalTradeFee += Number(leg.tradeFee || 0);
    summary.legs += 1;
    const asset = leg.feeAsset || null;
    const paidFee = Number(leg.paidFee);
    const tradeFee = Number(leg.tradeFee);

    if (asset) {
      if (Number.isFinite(paidFee)) {
        summary.totalPaidFeeByAsset[asset] = (summary.totalPaidFeeByAsset[asset] || 0) + paidFee;
        summary.totalByAsset[asset] = (summary.totalByAsset[asset] || 0) + paidFee;
      }

      if (Number.isFinite(tradeFee)) {
        summary.totalTradeFeeByAsset[asset] = (summary.totalTradeFeeByAsset[asset] || 0) + tradeFee;
      }
    }

    return summary;
  }, {
    totalPaidFee: 0,
    totalTradeFee: 0,
    totalByAsset: {},
    totalPaidFeeByAsset: {},
    totalTradeFeeByAsset: {},
    legs: 0,
  });
}

function cycleExecutionMeta(cycle = {}) {
  return {
    routeVariantId: cycle.routeVariantId,
    triangleId: cycle.triangleId,
    direction: cycle.direction,
    directionLabel: cycle.directionLabel,
    route: Array.isArray(cycle.route) ? cycle.route.slice() : null,
    routeLabel: cycle.routeLabel,
    markets: Array.isArray(cycle.markets) ? cycle.markets.slice() : null,
  };
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
    this.orderManager = options.orderManager || new OrderManager({
      restClient: this.restClient,
      fillTracker: this.fillTracker,
      logStore: this.logStore,
      reconcileTimeoutMs: this.reconcileTimeoutMs,
      fillEventPollMs: this.fillEventPollMs,
      orderRateLimitPerSecond: this.runtimeConfig.executionPolicy &&
        this.runtimeConfig.executionPolicy.executionGuards &&
        this.runtimeConfig.executionPolicy.executionGuards.orderRateLimitPerSecond,
    });
    this.partialFillPolicy = resolvePartialFillPolicy({
      partialFillPolicy: options.partialFillPolicy,
      runtimeConfig: this.runtimeConfig,
    });
    this.marketPolicyProvider = options.marketPolicyProvider || null;
    this.feePolicyProvider = options.feePolicyProvider || null;
    this.activeEngineState = null;
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
      executionMode: this.runtimeConfig.executionMode || DEFAULT_EXECUTION_MODE,
      engineState: payload.engineState ?? this.activeEngineState ?? this.runtimeConfig.engineState ?? null,
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

  planWithCurrentAges(plan, nowMs = Date.now()) {
    const planNowMs = Number(plan.nowMs);
    const elapsedMs = Number.isFinite(planNowMs) ? Math.max(0, nowMs - planNowMs) : 0;
    const agedPlan = {
      ...plan,
      nowMs,
    };

    if (finiteNumber(plan.oldestLegAgeMs)) {
      agedPlan.oldestLegAgeMs = Number(plan.oldestLegAgeMs) + elapsedMs;
    }

    if (finiteNumber(plan.decisionAgeMs)) {
      agedPlan.decisionAgeMs = Number(plan.decisionAgeMs) + elapsedMs;
    }

    return agedPlan;
  }

  emitState(plan, state, payload = {}) {
    return this.emit("orders", {
      type: "execution.state_changed",
      planId: plan.planId,
      cycleId: plan.cycle && plan.cycle.cycleId,
      startAsset: plan.startAsset || (plan.cycle && plan.cycle.startAsset),
      strategyId: plan.strategyId,
      executionState: state,
      ...payload,
    });
  }

  cycleEventMeta(plan) {
    return {
      planId: plan.planId,
      cycleId: plan.cycle && plan.cycle.cycleId,
      routeVariantId: plan.routeVariantId || (plan.cycle && plan.cycle.routeVariantId),
      startAsset: plan.startAsset || (plan.cycle && plan.cycle.startAsset),
      strategyId: plan.strategyId,
      engineState: plan.engineState || this.activeEngineState || this.runtimeConfig.engineState || null,
      marketState: plan.marketState || plan.status,
      opportunityClass: plan.opportunityClass,
      ...cycleExecutionMeta(plan.cycle),
    };
  }

  emitCycleDone(plan, payload = {}) {
    const event = {
      ...this.cycleEventMeta(plan),
      ...payload,
      runType: "REAL_EXECUTION",
    };

    this.emit("orders", {
      type: "cycle.done",
      legacyType: "cycle.real_done",
      ...event,
    });
    return this.emit("orders", {
      type: "cycle.real_done",
      canonicalType: "cycle.done",
      ...event,
    });
  }

  emitCycleAborted(plan, payload = {}, options = {}) {
    const event = {
      ...this.cycleEventMeta(plan),
      ...payload,
      runType: "REAL_EXECUTION",
    };

    this.emit("orders", {
      type: "cycle.aborted",
      legacyType: options.legacyType || null,
      ...event,
    });

    if (options.legacyType) {
      return this.emit("orders", {
        type: options.legacyType,
        canonicalType: "cycle.aborted",
        ...event,
      });
    }

    return event;
  }

  async validationOrderbooksForLeg(plan, context = {}) {
    if (typeof context.getValidationOrderbooks === "function") {
      return context.getValidationOrderbooks();
    }

    return plan.validationOrderbooks;
  }

  async marketPolicyForLeg(step, context = {}) {
    if (typeof context.getMarketPolicy === "function") {
      return policyForMarket(step.market, await context.getMarketPolicy(step.market));
    }

    if (typeof this.marketPolicyProvider === "function") {
      return policyForMarket(step.market, await this.marketPolicyProvider(step.market));
    }

    return loadMarketPolicy(this.restClient, step.market);
  }

  async feePolicyForLeg(step, context = {}) {
    if (typeof context.getFeePolicy === "function") {
      return context.getFeePolicy(step.market);
    }

    if (typeof this.feePolicyProvider === "function") {
      return this.feePolicyProvider(step.market);
    }

    return null;
  }

  resolveFeeRateForLeg(step, plan = {}, feePolicy = null) {
    const side = legFeeSide(step);
    const feePolicyByMarket = feePolicy
      ? new Map([[step.market, feePolicy]])
      : plan.feePolicyByMarket;

    return resolveLegFeeRate(step, side, plan.feeRate || 0, {
      feePolicyByMarket,
      useDefaultFeePolicy: plan.useDefaultFeePolicy === true,
      expectedMaker: plan.expectedMaker === true,
      orderType: plan.orderType || "limit",
      timeInForce: plan.timeInForce || "ioc",
    });
  }

  buildOrderForLeg(step, amount, orderbook, identifier, marketPolicy = null, liquidityPolicyOverride = null, feeContext = {}) {
    const mode = this.runtimeConfig.executionMode || DEFAULT_EXECUTION_MODE;
    const { quote, base } = parseMarket(step.market);
    const unit = firstUnit(orderbook);
    const liquidityPolicy = resolveLiquidityPolicy(this.runtimeConfig, liquidityPolicyOverride || {});
    const feeRate = feeRateFromContext(feeContext.feeRate);

    if (step.fromAsset === quote && step.toAsset === base) {
      const tradeBudget = feeRate > 0 ? Number(amount) / (1 + feeRate) : Number(amount);

      if (mode === BEST_IOC_EXECUTION_MODE) {
        const cap = liquidityCap({
          requestedInputAmount: tradeBudget,
          requestedVolume: tradeBudget / unit.askPrice,
          bestLevelSize: unit.askSize,
          price: unit.askPrice,
          inputAsset: "quote",
          policy: liquidityPolicy,
        });
        const cappedQuote = cap.submittedInputAmount;
        const expectedFeeAmount = cappedQuote * feeRate;
        const submittedAllInInputAmount = cappedQuote + expectedFeeAmount;
        const unsubmittedInputAmount = Math.max(0, Number(amount) - submittedAllInInputAmount);
        return {
          market: step.market,
          side: "bid",
          ord_type: "best",
          price: numericString(cappedQuote),
          time_in_force: "ioc",
          identifier,
          observedBestPrice: unit.askPrice,
          expectedOutputAmount: cappedQuote / unit.askPrice,
          requestedInputAmount: amount,
          requestedTradeInputAmount: tradeBudget,
          submittedInputAmount: cap.submittedInputAmount,
          submittedAllInInputAmount,
          unsubmittedInputAmount,
          feeRate,
          expectedFeeAmount,
          expectedFeeAsset: quote,
          feeAsset: quote,
          bestLevelSize: cap.bestLevelSize,
          bestLevelTouchRatio: cap.bestLevelTouchRatio,
          maxBestLevelTouchRatio: cap.maxBestLevelTouchRatio,
          minBestLevelResidualRatio: cap.minBestLevelResidualRatio,
          effectiveBestLevelTouchRatio: cap.effectiveBestLevelTouchRatio,
          liquidityCapped: unsubmittedInputAmount > Math.max(Number(amount) * 1e-12, 1e-12),
        };
      }
      const normalized = normalizeLimitPrice({
        market: step.market,
        price: unit.askPrice,
        side: "bid",
        priceUnit: marketPolicy && marketPolicy.priceUnit,
      });
      const cap = liquidityCap({
        requestedInputAmount: tradeBudget,
        requestedVolume: tradeBudget / normalized.numericPrice,
        bestLevelSize: unit.askSize,
        price: normalized.numericPrice,
        inputAsset: "quote",
        policy: liquidityPolicy,
      });
      const cappedBase = cap.submittedVolume;
      const expectedFeeAmount = cap.submittedInputAmount * feeRate;
      const submittedAllInInputAmount = cap.submittedInputAmount + expectedFeeAmount;
      const unsubmittedInputAmount = Math.max(0, Number(amount) - submittedAllInInputAmount);

      return {
        market: step.market,
        side: "bid",
        ord_type: "limit",
        volume: numericString(cappedBase),
        price: normalized.price,
        time_in_force: "ioc",
        identifier,
        observedBestPrice: unit.askPrice,
        priceUnit: normalized.priceUnit,
        priceWasRounded: normalized.priceWasRounded,
        expectedOutputAmount: cappedBase,
        requestedInputAmount: amount,
        requestedTradeInputAmount: tradeBudget,
        submittedInputAmount: cap.submittedInputAmount,
        submittedAllInInputAmount,
        unsubmittedInputAmount,
        feeRate,
        expectedFeeAmount,
        expectedFeeAsset: quote,
        feeAsset: quote,
        bestLevelSize: cap.bestLevelSize,
        bestLevelTouchRatio: cap.bestLevelTouchRatio,
        maxBestLevelTouchRatio: cap.maxBestLevelTouchRatio,
        minBestLevelResidualRatio: cap.minBestLevelResidualRatio,
        effectiveBestLevelTouchRatio: cap.effectiveBestLevelTouchRatio,
        liquidityCapped: unsubmittedInputAmount > Math.max(Number(amount) * 1e-12, 1e-12),
      };
    }

    if (step.fromAsset === base && step.toAsset === quote) {
      const normalized = mode === BEST_IOC_EXECUTION_MODE ? null : normalizeLimitPrice({
        market: step.market,
        price: unit.bidPrice,
        side: "ask",
        priceUnit: marketPolicy && marketPolicy.priceUnit,
      });
      const executionPrice = normalized ? normalized.numericPrice : unit.bidPrice;
      const cap = liquidityCap({
        requestedInputAmount: amount,
        requestedVolume: amount,
        bestLevelSize: unit.bidSize,
        price: executionPrice,
        inputAsset: "base",
        policy: liquidityPolicy,
      });
      const cappedBase = cap.submittedVolume;
      const expectedGrossOutputAmount = cappedBase * executionPrice;
      const expectedFeeAmount = expectedGrossOutputAmount * feeRate;

      return {
        market: step.market,
        side: "ask",
        ord_type: mode === BEST_IOC_EXECUTION_MODE ? "best" : "limit",
        volume: numericString(cappedBase),
        price: mode === BEST_IOC_EXECUTION_MODE ? undefined : normalized.price,
        time_in_force: "ioc",
        identifier,
        observedBestPrice: unit.bidPrice,
        priceUnit: normalized && normalized.priceUnit,
        priceWasRounded: normalized ? normalized.priceWasRounded : false,
        expectedOutputAmount: expectedGrossOutputAmount - expectedFeeAmount,
        expectedGrossOutputAmount,
        requestedInputAmount: amount,
        submittedInputAmount: cap.submittedInputAmount,
        unsubmittedInputAmount: cap.unsubmittedInputAmount,
        feeRate,
        expectedFeeAmount,
        expectedFeeAsset: quote,
        feeAsset: quote,
        bestLevelSize: cap.bestLevelSize,
        bestLevelTouchRatio: cap.bestLevelTouchRatio,
        maxBestLevelTouchRatio: cap.maxBestLevelTouchRatio,
        minBestLevelResidualRatio: cap.minBestLevelResidualRatio,
        effectiveBestLevelTouchRatio: cap.effectiveBestLevelTouchRatio,
        liquidityCapped: cap.liquidityCapped,
      };
    }

    throw new Error(`Market ${step.market} cannot convert ${step.fromAsset} -> ${step.toAsset}`);
  }

  async reconcileOrder(orderAck, identifier) {
    const result = await this.orderManager.reconcileSubmittedOrder({
      orderAck,
      identifier,
    });
    return result.order;
  }

  async waitForTrackedOrder(orderAck, identifier) {
    return this.orderManager.orderReconciler.waitForTrackedOrder(orderAck, identifier);
  }

  orderSubmitFailureReason(error) {
    if (error && error.code === "ORDER_RATE_LIMIT") return "ORDER_RATE_LIMIT";
    return "ORDER_SUBMIT_FAILED";
  }

  orderSubmitFailureDetails(error) {
    const responseError = error && error.response && error.response.data && error.response.data.error;
    return {
      message: responseError && responseError.message || error && error.message || "Order submit failed",
      exchangeErrorCode: responseError && responseError.name || null,
      code: error && error.code || null,
      status: error && error.response && error.response.status || null,
    };
  }

  amountAfterFill(step, order, submittedOrder = {}) {
    const executedVolume = Number(order.executed_volume ?? order.executedVolume ?? order.volume ?? 0);
    const avgPrice = Number(order.avg_price ?? order.avgPrice ?? order.price ?? 0);
    const paidFee = Number(order.paid_fee ?? order.paidFee ?? 0);
    const tradeFee = Number(order.trade_fee ?? order.tradeFee ?? paidFee);
    const requestedVolume = Number(submittedOrder.volume ?? order.volume ?? 0);
    const remainingVolume = Number(order.remaining_volume ?? order.remainingVolume ?? 0);
    const unsubmittedInputAmount = Math.max(0, Number(submittedOrder.unsubmittedInputAmount || 0));
    const { quote, base } = parseMarket(step.market);

    if (!(executedVolume > 0)) {
      return {
        ok: false,
        reason: "ZERO_FILL",
        executedVolume,
        requestedVolume,
        remainingVolume,
        paidFee,
        tradeFee,
        feeAsset: quote,
        unsubmittedInputAmount,
      };
    }

    const residual = residualFromFill({
      step,
      submittedOrder,
      executedVolume,
      requestedVolume,
      remainingVolume,
      avgPrice,
    });

    if (step.fromAsset === quote && step.toAsset === base) {
      return {
        ok: true,
        amount: executedVolume,
        executedVolume,
        requestedVolume,
        remainingVolume,
        avgPrice,
        paidFee,
        tradeFee,
        feeAsset: quote,
        feeAmount: paidFee,
        grossOutputAmount: executedVolume,
        netOutputAmount: executedVolume,
        tradeAmount: executedVolume * avgPrice,
        ...residual,
      };
    }

    const grossOutputAmount = executedVolume * avgPrice;
    const netOutputAmount = Math.max(0, grossOutputAmount - paidFee);

    return {
      ok: true,
      amount: netOutputAmount,
      executedVolume,
      requestedVolume,
      remainingVolume,
      avgPrice,
      paidFee,
      tradeFee,
      feeAsset: quote,
      feeAmount: paidFee,
      grossOutputAmount,
      netOutputAmount,
      tradeAmount: grossOutputAmount,
      ...residual,
    };
  }

  async execute(plan, context = {}) {
    this.assertEnabled();
    this.activeEngineState = plan.engineState || context.engineState || this.runtimeConfig.engineState || null;

    const initialGuardContext = this.currentGuardContext(context);
    const guard = this.riskGuard.evaluatePlan(this.planWithCurrentAges(plan, initialGuardContext.nowMs), {
      ...initialGuardContext,
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
      this.emitCycleAborted(plan, {
        reason: guard.rejectionReason,
        rejectionReason: guard.rejectionReason,
        emergencyStop: guard.emergencyStop,
      });
      return {
        ok: false,
        reason: guard.rejectionReason,
        emergencyStop: guard.emergencyStop,
      };
    }

    let amount = Number(plan.startAmount);
    const legResults = [];
    this.riskGuard.recordCycleStart(context.nowMs || Date.now());
    this.emitState(plan, "CANDIDATE_ACCEPTED", {
      startAmount: amount,
      executionMode: this.runtimeConfig.executionMode || DEFAULT_EXECUTION_MODE,
    });

    for (const step of plan.cycle.steps) {
      const legIndex = step.index + 1;
      const legInputAmount = amount;
      this.emitState(plan, `LEG_${legIndex}_PLANNED`, {
        legIndex,
        market: step.market,
        inputAmount: legInputAmount,
      });

      if (step.index > 0) {
        this.emitState(plan, `REPRICE_BEFORE_LEG_${legIndex}`, {
          legIndex,
          market: step.market,
          inputAmount: legInputAmount,
        });
      }

      const guardContext = this.currentGuardContext(context);
      const orderGuard = this.riskGuard.evaluatePlan(this.planWithCurrentAges(plan, guardContext.nowMs), {
        ...guardContext,
        skipCycleRateLimit: true,
      });
      if (!orderGuard.ok) {
        const failure = this.riskGuard.recordFailure(orderGuard.rejectionReason);
        const residual = step.index > 0 ? {
          residualAsset: step.fromAsset,
          actualAmount: amount,
        } : {};
        this.emitState(plan, `LEG_${legIndex}_FAILED`, {
          legIndex,
          market: step.market,
          reason: orderGuard.rejectionReason,
        });
        this.emitState(plan, step.index > 0 ? "CYCLE_RESIDUAL" : "CYCLE_ABORTED", {
          legIndex,
          reason: orderGuard.rejectionReason,
          ...residual,
          emergencyStop: failure.emergencyStop,
        });
        this.emit("orders", {
          type: "order.rejected",
          planId: plan.planId,
          cycleId: plan.cycle.cycleId,
          startAsset: plan.startAsset || plan.cycle.startAsset,
          strategyId: plan.strategyId,
          legIndex,
          rejectionReason: orderGuard.rejectionReason,
          emergencyStop: failure.emergencyStop,
        });
        this.emitCycleAborted(plan, {
          legIndex,
          market: step.market,
          reason: orderGuard.rejectionReason,
          rejectionReason: orderGuard.rejectionReason,
          ...residual,
          emergencyStop: failure.emergencyStop,
        });
        return {
          ok: false,
          reason: orderGuard.rejectionReason,
          ...residual,
          legResults,
          feeSummary: summarizeFees(legResults),
          emergencyStop: failure.emergencyStop,
        };
      }

      const validationOrderbooks = await this.validationOrderbooksForLeg(plan, context);
      const orderbook = getOrderbook(validationOrderbooks, step.market);
      this.emit("orders", {
        type: "execution.reprice",
        planId: plan.planId,
        cycleId: plan.cycle.cycleId,
        startAsset: plan.startAsset || plan.cycle.startAsset,
        strategyId: plan.strategyId,
        legIndex,
        market: step.market,
        inputAmount: legInputAmount,
        orderbook: orderbookMeta(orderbook),
      });
      const identifier = this.orderManager.createIdentifier({
        planId: plan.planId,
        cycleId: plan.cycle.cycleId,
        legIndex,
      });
      let marketPolicy;
      try {
        marketPolicy = await this.marketPolicyForLeg(step, context);
      } catch (error) {
        const failure = this.riskGuard.recordFailure("MARKET_POLICY_UNAVAILABLE");
        this.emitState(plan, `LEG_${legIndex}_FAILED`, {
          legIndex,
          market: step.market,
          reason: "MARKET_POLICY_UNAVAILABLE",
          message: error.message,
        });
        this.emitState(plan, step.index > 0 ? "CYCLE_RESIDUAL" : "CYCLE_ABORTED", {
          legIndex,
          reason: "MARKET_POLICY_UNAVAILABLE",
          residualAsset: step.fromAsset,
          actualAmount: amount,
          emergencyStop: failure.emergencyStop,
        });
        this.emit("orders", {
          type: "order.rejected",
          planId: plan.planId,
          cycleId: plan.cycle.cycleId,
          startAsset: plan.startAsset || plan.cycle.startAsset,
          strategyId: plan.strategyId,
          legIndex,
          market: step.market,
          rejectionReason: "MARKET_POLICY_UNAVAILABLE",
          message: error.message,
          emergencyStop: failure.emergencyStop,
        });
        this.emitCycleAborted(plan, {
          legIndex,
          market: step.market,
          reason: "MARKET_POLICY_UNAVAILABLE",
          rejectionReason: "MARKET_POLICY_UNAVAILABLE",
          residualAsset: step.fromAsset,
          actualAmount: amount,
          message: error.message,
          emergencyStop: failure.emergencyStop,
        });
        return {
          ok: false,
          reason: "MARKET_POLICY_UNAVAILABLE",
          residualAsset: step.fromAsset,
          actualAmount: amount,
          legResults,
          feeSummary: summarizeFees(legResults),
          emergencyStop: failure.emergencyStop,
        };
      }
      const feePolicy = await this.feePolicyForLeg(step, context);
      const feeRate = this.resolveFeeRateForLeg(step, plan, feePolicy);
      const order = this.buildOrderForLeg(step, amount, orderbook, identifier, marketPolicy, null, {
        feeRate,
      });
      const orderTotalCheck = validateOrderTotal(order, marketPolicy);

      if (!orderTotalCheck.ok) {
        const failure = this.riskGuard.recordFailure(orderTotalCheck.rejectionReason);
        this.emitState(plan, `LEG_${legIndex}_FAILED`, {
          legIndex,
          market: step.market,
          reason: orderTotalCheck.rejectionReason,
          orderTotal: orderTotalCheck.total,
          minTotal: orderTotalCheck.minTotal,
          maxTotal: orderTotalCheck.maxTotal,
        });
        this.emitState(plan, step.index > 0 ? "CYCLE_RESIDUAL" : "CYCLE_ABORTED", {
          legIndex,
          reason: orderTotalCheck.rejectionReason,
          residualAsset: step.fromAsset,
          actualAmount: amount,
          orderTotal: orderTotalCheck.total,
          minTotal: orderTotalCheck.minTotal,
          maxTotal: orderTotalCheck.maxTotal,
          emergencyStop: failure.emergencyStop,
        });
        this.emit("orders", {
          type: "order.rejected",
          planId: plan.planId,
          cycleId: plan.cycle.cycleId,
          startAsset: plan.startAsset || plan.cycle.startAsset,
          strategyId: plan.strategyId,
          legIndex,
          market: step.market,
          rejectionReason: orderTotalCheck.rejectionReason,
          orderTotal: orderTotalCheck.total,
          minTotal: orderTotalCheck.minTotal,
          maxTotal: orderTotalCheck.maxTotal,
          order,
          marketPolicy: marketPolicyMeta(marketPolicy),
          feePolicy,
          emergencyStop: failure.emergencyStop,
        });
        this.emitCycleAborted(plan, {
          legIndex,
          market: step.market,
          reason: orderTotalCheck.rejectionReason,
          rejectionReason: orderTotalCheck.rejectionReason,
          residualAsset: step.fromAsset,
          actualAmount: amount,
          orderTotal: orderTotalCheck.total,
          minTotal: orderTotalCheck.minTotal,
          maxTotal: orderTotalCheck.maxTotal,
          emergencyStop: failure.emergencyStop,
        });
        return {
          ok: false,
          reason: orderTotalCheck.rejectionReason,
          residualAsset: step.fromAsset,
          actualAmount: amount,
          orderTotal: orderTotalCheck.total,
          minTotal: orderTotalCheck.minTotal,
          maxTotal: orderTotalCheck.maxTotal,
          legResults,
          feeSummary: summarizeFees(legResults),
          emergencyStop: failure.emergencyStop,
        };
      }

      if (order.liquidityCapped) {
        this.emit("orders", {
          type: "execution.liquidity_capped",
          planId: plan.planId,
          cycleId: plan.cycle.cycleId,
          startAsset: plan.startAsset || plan.cycle.startAsset,
          strategyId: plan.strategyId,
          legIndex,
          market: step.market,
          requestedInputAmount: order.requestedInputAmount,
          submittedInputAmount: order.submittedInputAmount,
          unsubmittedInputAmount: order.unsubmittedInputAmount,
          bestLevelSize: order.bestLevelSize,
          bestLevelTouchRatio: order.bestLevelTouchRatio,
          maxBestLevelTouchRatio: order.maxBestLevelTouchRatio,
          minBestLevelResidualRatio: order.minBestLevelResidualRatio,
        });
      }

      this.emit("orders", {
        type: "order.intent",
        planId: plan.planId,
        cycleId: plan.cycle.cycleId,
        startAsset: plan.startAsset || plan.cycle.startAsset,
        strategyId: plan.strategyId,
        legIndex,
        order,
        marketPolicy: marketPolicyMeta(marketPolicy),
        feePolicy,
      });

      this.riskGuard.recordOrderOpened();
      let submission;
      try {
        submission = await this.orderManager.submitOrder(order, {
          planId: plan.planId,
          cycleId: plan.cycle.cycleId,
          startAsset: plan.startAsset || plan.cycle.startAsset,
          strategyId: plan.strategyId,
          engineState: this.activeEngineState,
          legIndex,
          market: step.market,
        });
      } catch (error) {
        const reason = this.orderSubmitFailureReason(error);
        const errorDetails = this.orderSubmitFailureDetails(error);
        const failure = this.riskGuard.recordFailure(reason);
        this.emitState(plan, `LEG_${legIndex}_FAILED`, {
          legIndex,
          market: step.market,
          reason,
          error: errorDetails,
        });
        this.emitState(plan, step.index > 0 ? "CYCLE_RESIDUAL" : "CYCLE_ABORTED", {
          legIndex,
          reason,
          residualAsset: step.fromAsset,
          actualAmount: amount,
          emergencyStop: failure.emergencyStop,
        });
        this.emit("orders", {
          type: "order.rejected",
          planId: plan.planId,
          cycleId: plan.cycle.cycleId,
          startAsset: plan.startAsset || plan.cycle.startAsset,
          strategyId: plan.strategyId,
          legIndex,
          market: step.market,
          rejectionReason: reason,
          error: errorDetails,
          order,
          emergencyStop: failure.emergencyStop,
        });
        this.emitCycleAborted(plan, {
          legIndex,
          market: step.market,
          reason,
          rejectionReason: reason,
          residualAsset: step.fromAsset,
          actualAmount: amount,
          error: errorDetails,
          emergencyStop: failure.emergencyStop,
        }, { legacyType: "cycle.real_fail" });
        return {
          ok: false,
          reason,
          residualAsset: step.fromAsset,
          actualAmount: amount,
          legResults,
          feeSummary: summarizeFees(legResults),
          emergencyStop: failure.emergencyStop,
        };
      } finally {
        this.riskGuard.recordOrderClosed();
      }
      const ack = submission.ack;
      this.emit("orders", {
        type: "order.ack",
        planId: plan.planId,
        cycleId: plan.cycle.cycleId,
        startAsset: plan.startAsset || plan.cycle.startAsset,
        strategyId: plan.strategyId,
        legIndex,
        uuid: ack.uuid,
        identifier: submission.identifier,
        orderSubmitStartPerfNs: submission.orderSubmitStartPerfNs,
        orderAckPerfNs: submission.orderAckPerfNs,
      });
      this.emitState(plan, `LEG_${legIndex}_SUBMITTED`, {
        legIndex,
        market: step.market,
        uuid: ack.uuid,
        identifier: submission.identifier,
      });

      const reconciliation = await this.orderManager.reconcileSubmittedOrder({
        orderAck: ack,
        identifier: submission.identifier,
        submittedOrder: submission.order,
        metadata: {
          planId: plan.planId,
          cycleId: plan.cycle.cycleId,
          startAsset: plan.startAsset || plan.cycle.startAsset,
          strategyId: plan.strategyId,
          engineState: this.activeEngineState,
          legIndex,
          market: step.market,
        },
      });
      const reconciled = reconciliation.order;
      const fill = this.amountAfterFill(step, reconciled, order);
      const executionLatency = {
        orderAckMs: diffNsToMs(submission.orderAckPerfNs, submission.orderSubmitStartPerfNs),
        reconciliationMs: diffNsToMs(
          reconciliation.reconciliationDonePerfNs,
          reconciliation.reconciliationStartedPerfNs,
        ),
        orderQueryMs: diffNsToMs(
          reconciliation.orderQueryDonePerfNs,
          reconciliation.reconciliationStartedPerfNs,
        ),
        privateWsFillMs: diffNsToMs(
          reconciliation.privateWsFillReceivePerfNs,
          submission.orderSubmitStartPerfNs,
        ),
        source: reconciliation.source,
      };
      const latencySummary = summarizeLatency({
        execution: executionLatency,
      });

      if (!fill.ok) {
        const failure = this.riskGuard.recordFailure(fill.reason);
        this.emitState(plan, `LEG_${legIndex}_FAILED`, {
          legIndex,
          market: step.market,
          reason: fill.reason,
          residualAsset: step.fromAsset,
          actualAmount: amount,
        });
        this.emitState(plan, "CYCLE_ABORTED", {
          legIndex,
          reason: fill.reason,
          residualAsset: step.fromAsset,
          actualAmount: amount,
        });
        this.emitCycleAborted(plan, {
          legIndex,
          market: step.market,
          reason: fill.reason,
          residualAsset: step.fromAsset,
          actualAmount: amount,
          emergencyStop: failure.emergencyStop,
        }, { legacyType: "cycle.real_fail" });
        return {
          ok: false,
          reason: fill.reason,
          residualAsset: step.fromAsset,
          actualAmount: amount,
          legResults,
          feeSummary: summarizeFees(legResults),
          emergencyStop: failure.emergencyStop,
        };
      }

      amount = fill.amount;
      const legResult = {
        legIndex,
        market: step.market,
        side: order.side,
        fromAsset: step.fromAsset,
        toAsset: step.toAsset,
        inputAmount: legInputAmount,
        outputAmount: amount,
        executedVolume: fill.executedVolume,
        requestedVolume: fill.requestedVolume,
        remainingVolume: fill.remainingVolume,
        avgPrice: fill.avgPrice,
        submittedPrice: order.price,
        observedBestPrice: order.observedBestPrice,
        paidFee: fill.paidFee,
        tradeFee: fill.tradeFee,
        feeRate: order.feeRate,
        feeAmount: fill.feeAmount,
        feeAsset: fill.feeAsset,
        tradeAmount: fill.tradeAmount,
        grossOutputAmount: fill.grossOutputAmount,
        netOutputAmount: fill.netOutputAmount,
        isPartial: fill.isPartial,
        isLiquidityCapped: fill.isLiquidityCapped,
        hasResidual: fill.hasResidual,
        residualAsset: fill.residualAsset,
        residualAmount: fill.residualAmount,
        orderResidualAmount: fill.orderResidualAmount,
        unsubmittedInputAmount: fill.unsubmittedInputAmount,
        bestLevelTouchRatio: order.bestLevelTouchRatio,
        maxBestLevelTouchRatio: order.maxBestLevelTouchRatio,
        minBestLevelResidualRatio: order.minBestLevelResidualRatio,
        uuid: reconciled && reconciled.uuid,
        identifier: submission.identifier,
        source: reconciliation.source,
      };
      legResults.push(legResult);
      if (fill.isPartial) {
        this.emitState(plan, `LEG_${legIndex}_PARTIAL`, {
          legIndex,
          market: step.market,
          residualAsset: fill.residualAsset,
          residualAmount: fill.residualAmount,
          partialFillPolicy: this.partialFillPolicy,
        });
        this.emit("orders", {
          type: "order.partial",
          planId: plan.planId,
          cycleId: plan.cycle.cycleId,
          startAsset: plan.startAsset || plan.cycle.startAsset,
          strategyId: plan.strategyId,
          legIndex,
          market: step.market,
          residualAsset: fill.residualAsset,
          residualAmount: fill.residualAmount,
          executedVolume: fill.executedVolume,
          requestedVolume: fill.requestedVolume,
          remainingVolume: fill.remainingVolume,
          partialFillPolicy: this.partialFillPolicy,
        });
      } else {
        this.emitState(plan, `LEG_${legIndex}_FILLED`, {
          legIndex,
          market: step.market,
          outputAmount: amount,
        });
      }
      this.emit("fills", {
        type: fill.isPartial ? "order.partial" : "order.fill",
        planId: plan.planId,
        cycleId: plan.cycle.cycleId,
        startAsset: plan.startAsset || plan.cycle.startAsset,
        strategyId: plan.strategyId,
        legIndex,
        market: step.market,
        uuid: reconciled && reconciled.uuid,
        identifier: submission.identifier,
        executedVolume: fill.executedVolume,
        requestedVolume: fill.requestedVolume,
        remainingVolume: fill.remainingVolume,
        avgPrice: fill.avgPrice,
        paidFee: fill.paidFee,
        tradeFee: fill.tradeFee,
        feeRate: order.feeRate,
        feeAmount: fill.feeAmount,
        feeAsset: fill.feeAsset,
        tradeAmount: fill.tradeAmount,
        grossOutputAmount: fill.grossOutputAmount,
        netOutputAmount: fill.netOutputAmount,
        outputAmount: amount,
        isPartial: fill.isPartial,
        isLiquidityCapped: fill.isLiquidityCapped,
        hasResidual: fill.hasResidual,
        residualAsset: fill.residualAsset,
        residualAmount: fill.residualAmount,
        orderResidualAmount: fill.orderResidualAmount,
        unsubmittedInputAmount: fill.unsubmittedInputAmount,
        bestLevelTouchRatio: order.bestLevelTouchRatio,
        maxBestLevelTouchRatio: order.maxBestLevelTouchRatio,
        minBestLevelResidualRatio: order.minBestLevelResidualRatio,
        source: reconciliation.source,
        privateWsFillReceivePerfNs: reconciliation.privateWsFillReceivePerfNs || null,
        orderQueryDonePerfNs: reconciliation.orderQueryDonePerfNs || null,
        reconciliationStartedPerfNs: reconciliation.reconciliationStartedPerfNs,
        reconciliationDonePerfNs: reconciliation.reconciliationDonePerfNs,
        executionLatency,
        latencySummary,
      });

      const latencyGuard = this.riskGuard.evaluateExecutionLatency(executionLatency);
      if (!latencyGuard.ok && step.index < plan.cycle.steps.length - 1) {
        const failure = this.riskGuard.recordFailure(latencyGuard.rejectionReason);
        this.emitState(plan, "CYCLE_RESIDUAL", {
          legIndex,
          reason: latencyGuard.rejectionReason,
          residualAsset: step.toAsset,
          actualAmount: amount,
          observedMs: latencyGuard.observedMs,
          limitMs: latencyGuard.limitMs,
          emergencyStop: failure.emergencyStop,
        });
        this.emit("orders", {
          type: "risk.rejected",
          planId: plan.planId,
          cycleId: plan.cycle.cycleId,
          startAsset: plan.startAsset || plan.cycle.startAsset,
          strategyId: plan.strategyId,
          legIndex,
          reason: latencyGuard.rejectionReason,
          metric: latencyGuard.metric,
          observedMs: latencyGuard.observedMs,
          limitMs: latencyGuard.limitMs,
          residualAsset: step.toAsset,
          actualAmount: amount,
          executionLatency,
          emergencyStop: failure.emergencyStop,
        });
        this.emitCycleAborted(plan, {
          legIndex,
          market: step.market,
          reason: latencyGuard.rejectionReason,
          residualAsset: step.toAsset,
          actualAmount: amount,
          observedMs: latencyGuard.observedMs,
          limitMs: latencyGuard.limitMs,
          executionLatency,
          emergencyStop: failure.emergencyStop,
        });
        return {
          ok: false,
          reason: latencyGuard.rejectionReason,
          residualAsset: step.toAsset,
          actualAmount: amount,
          observedMs: latencyGuard.observedMs,
          limitMs: latencyGuard.limitMs,
          legResults,
          feeSummary: summarizeFees(legResults),
          emergencyStop: failure.emergencyStop,
        };
      }

      const isLastLeg = step.index >= plan.cycle.steps.length - 1;
      const minOrderAmount = Number(this.runtimeConfig.candidateValidation &&
        this.runtimeConfig.candidateValidation.minOrderAmountByAsset &&
        this.runtimeConfig.candidateValidation.minOrderAmountByAsset[step.toAsset] || 0);
      const partialFillDecision = evaluatePartialFillPolicy({
        policy: this.partialFillPolicy || DEFAULT_PARTIAL_FILL_POLICY,
        fill,
        actualAmount: amount,
        nextAsset: step.toAsset,
        minNextOrderAmount: minOrderAmount,
        isLastLeg,
      });

      if (!partialFillDecision.ok) {
        const failure = this.riskGuard.recordFailure(partialFillDecision.rejectionReason);
        this.emitState(plan, "CYCLE_RESIDUAL", {
          legIndex,
          reason: partialFillDecision.rejectionReason,
          residualAsset: partialFillDecision.residualAsset,
          residualAmount: partialFillDecision.residualAmount,
          actualAmount: amount,
          emergencyStop: failure.emergencyStop,
        });
        this.emitCycleAborted(plan, {
          legIndex,
          market: step.market,
          reason: partialFillDecision.rejectionReason,
          residualAsset: partialFillDecision.residualAsset,
          residualAmount: partialFillDecision.residualAmount,
          actualAmount: amount,
          emergencyStop: failure.emergencyStop,
        }, { legacyType: "cycle.real_fail" });
        return {
          ok: false,
          reason: partialFillDecision.rejectionReason,
          residualAsset: partialFillDecision.residualAsset,
          residualAmount: partialFillDecision.residualAmount,
          actualAmount: amount,
          legResults,
          feeSummary: summarizeFees(legResults),
          emergencyStop: failure.emergencyStop,
        };
      }
    }

    this.riskGuard.recordSuccess();
    const feeSummary = summarizeFees(legResults);
    const pnl = amount - Number(plan.startAmount);
    this.emitState(plan, "CYCLE_DONE", {
      outputAmount: amount,
      pnl,
      feeSummary,
    });
    this.emitCycleDone(plan, {
      startAmount: Number(plan.startAmount),
      outputAmount: amount,
      pnl,
      feeSummary,
      legResults,
    });

    return {
      ok: true,
      mode: "REAL",
      planId: plan.planId,
      cycleId: plan.cycle && plan.cycle.cycleId,
      startAsset: plan.startAsset || (plan.cycle && plan.cycle.startAsset),
      startAmount: Number(plan.startAmount),
      outputAmount: amount,
      pnl,
      feeSummary,
      legResults,
    };
  }
}

module.exports = {
  RealExecutor,
  firstUnit,
  summarizeFees,
};
