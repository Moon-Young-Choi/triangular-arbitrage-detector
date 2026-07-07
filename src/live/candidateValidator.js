const { simulateCycleWithDepth } = require("../core/depthSimulator");
const {
  DEFAULT_VALIDATION_CONFIG,
  limitingLegFor,
  maxExecutableStartAmount,
  mergeValidationConfig,
} = require("../core/liquidityPolicy");
const { REJECTION_REASONS } = require("../core/rejectionReasons");

function orderbookForMarket(orderbooks, market) {
  if (!orderbooks) return null;
  return orderbooks instanceof Map ? orderbooks.get(market) : orderbooks[market];
}

function numberOrNull(...values) {
  for (const value of values) {
    const parsed = Number(value);

    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function orderbookUnits(orderbook) {
  if (!orderbook) return [];
  if (Array.isArray(orderbook.orderbook_units)) return orderbook.orderbook_units;
  if (Array.isArray(orderbook.orderbookUnits)) return orderbook.orderbookUnits;
  return [];
}

function orderbookTimestampMs(orderbook) {
  return numberOrNull(orderbook && orderbook.exchangeTimestampMs, orderbook && orderbook.timestamp, orderbook && orderbook.tms);
}

function orderbookReceivedAtMs(orderbook) {
  return numberOrNull(orderbook && orderbook.serverReceivedAtMs, orderbook && orderbook.receivedAt);
}

function orderbookComparisonTimeMs(orderbook) {
  return numberOrNull(orderbookReceivedAtMs(orderbook), orderbookTimestampMs(orderbook));
}

function orderbookDeclaredUnit(orderbook) {
  return numberOrNull(
    orderbook && orderbook.orderbookUnit,
    orderbook && orderbook.unit,
    orderbook && orderbookUnits(orderbook).length,
  );
}

function orderbookLevel(orderbook) {
  if (!orderbook) return null;
  return orderbook.orderbookLevel ?? orderbook.level ?? null;
}

function isDefaultOrderbookLevel(value) {
  if (value === null || value === undefined || value === "") {
    return true;
  }

  return Number(value) === 0;
}

function orderbookStreamType(orderbook) {
  return (orderbook && (orderbook.streamType || orderbook.stream_type)) || "UNKNOWN";
}

function configuredNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function rejectWithConsistency(reason, startAmount, consistency, partial = {}) {
  return {
    accepted: false,
    validationStatus: "rejected",
    validationReason: reason,
    rejectionCode: reason,
    executableStartAmount: startAmount,
    maxExecutableStartAmount: null,
    limitingLeg: null,
    limitingMarket: null,
    expectedSlippageBps: null,
    bestLevelTouchRatio: null,
    residualAfterOrder: null,
    depthLegs: [],
    ...marketDataConsistencyFields(consistency),
    ...partial,
  };
}

function marketDataConsistencyFields(consistency = {}) {
  return {
    observationValidationGapMs: consistency.observationValidationGapMs ?? null,
    observationValidationGapMarket: consistency.observationValidationGapMarket ?? null,
    validationLegTimestampSkewMs: consistency.validationLegTimestampSkewMs ?? null,
    oldestValidationReceivedAgeMs: consistency.oldestValidationReceivedAgeMs ?? null,
    validationOrderbookSources: consistency.validationOrderbookSources || {},
    validationOrderbookMetadata: consistency.validationOrderbookMetadata || [],
    expectedValidationOrderbookUnit: consistency.expectedValidationOrderbookUnit ?? null,
  };
}

function collectMarketDataConsistency(cycle, validationOrderbooks, observationOrderbooks, nowMs, config) {
  const expectedUnit = configuredNumber(config.expectedValidationOrderbookUnit);
  const maxGapMs = configuredNumber(config.maxObservationValidationGapMs);
  const maxSkewMs = configuredNumber(config.maxValidationLegTimestampSkewMs);
  const maxReceivedAgeMs = configuredNumber(config.maxOldestValidationReceivedAgeMs);
  const validationTimestamps = [];
  const validationReceivedAges = [];
  const validationOrderbookSources = {};
  const validationOrderbookMetadata = [];
  let observationValidationGapMs = null;
  let observationValidationGapMarket = null;

  for (const step of cycle.steps || []) {
    const validation = orderbookForMarket(validationOrderbooks, step.market);

    if (!validation) {
      continue;
    }

    const units = orderbookUnits(validation);
    const declaredUnit = orderbookDeclaredUnit(validation);
    const level = orderbookLevel(validation);
    const streamType = orderbookStreamType(validation);
    const exchangeTimestampMs = orderbookTimestampMs(validation);
    const serverReceivedAtMs = orderbookReceivedAtMs(validation);

    validationOrderbookSources[step.market] = streamType;
    validationOrderbookMetadata.push({
      market: step.market,
      unit: declaredUnit,
      unitCount: units.length,
      level,
      streamType,
      exchangeTimestampMs,
      serverReceivedAtMs,
      traceId: validation.traceId || null,
      localSequence: validation.localSequence ?? null,
    });

    if (expectedUnit !== null && declaredUnit !== null && declaredUnit !== expectedUnit) {
      return {
        ok: false,
        rejectionCode: REJECTION_REASONS.VALIDATION_DEPTH_UNIT_MISMATCH,
        limitingMarket: step.market,
        validationOrderbookSources,
        validationOrderbookMetadata,
        expectedValidationOrderbookUnit: expectedUnit,
      };
    }

    if (config.requireDefaultOrderbookLevel !== false && !isDefaultOrderbookLevel(level)) {
      return {
        ok: false,
        rejectionCode: REJECTION_REASONS.ORDERBOOK_LEVEL_GROUPING_UNSUPPORTED,
        limitingMarket: step.market,
        validationOrderbookSources,
        validationOrderbookMetadata,
        expectedValidationOrderbookUnit: expectedUnit,
      };
    }

    if (exchangeTimestampMs !== null) {
      validationTimestamps.push(exchangeTimestampMs);
    }

    if (serverReceivedAtMs !== null) {
      validationReceivedAges.push(Math.max(0, nowMs - serverReceivedAtMs));
    }

    if (observationOrderbooks) {
      const observation = orderbookForMarket(observationOrderbooks, step.market);

      if (!observation) {
        return {
          ok: false,
          rejectionCode: REJECTION_REASONS.OBSERVATION_SNAPSHOT_MISSING,
          limitingMarket: step.market,
          validationOrderbookSources,
          validationOrderbookMetadata,
          expectedValidationOrderbookUnit: expectedUnit,
        };
      }

      const observationTime = orderbookComparisonTimeMs(observation);
      const validationTime = orderbookComparisonTimeMs(validation);

      if (observationTime !== null && validationTime !== null) {
        const gapMs = Math.abs(validationTime - observationTime);

        if (observationValidationGapMs === null || gapMs > observationValidationGapMs) {
          observationValidationGapMs = gapMs;
          observationValidationGapMarket = step.market;
        }
      }
    }
  }

  const validationLegTimestampSkewMs = validationTimestamps.length > 1
    ? Math.max(...validationTimestamps) - Math.min(...validationTimestamps)
    : null;
  const oldestValidationReceivedAgeMs = validationReceivedAges.length > 0
    ? Math.max(...validationReceivedAges)
    : null;
  const common = {
    ok: true,
    rejectionCode: null,
    observationValidationGapMs,
    observationValidationGapMarket,
    validationLegTimestampSkewMs,
    oldestValidationReceivedAgeMs,
    validationOrderbookSources,
    validationOrderbookMetadata,
    expectedValidationOrderbookUnit: expectedUnit,
  };

  if (
    maxGapMs !== null &&
    observationValidationGapMs !== null &&
    observationValidationGapMs > maxGapMs
  ) {
    return {
      ...common,
      ok: false,
      rejectionCode: REJECTION_REASONS.OBSERVATION_VALIDATION_SNAPSHOT_GAP,
      limitingMarket: observationValidationGapMarket,
    };
  }

  if (
    maxSkewMs !== null &&
    validationLegTimestampSkewMs !== null &&
    validationLegTimestampSkewMs > maxSkewMs
  ) {
    return {
      ...common,
      ok: false,
      rejectionCode: REJECTION_REASONS.VALIDATION_LEG_TIMESTAMP_SKEW,
    };
  }

  if (
    maxReceivedAgeMs !== null &&
    oldestValidationReceivedAgeMs !== null &&
    oldestValidationReceivedAgeMs > maxReceivedAgeMs
  ) {
    return {
      ...common,
      ok: false,
      rejectionCode: REJECTION_REASONS.VALIDATION_RECEIVE_STALE,
    };
  }

  return common;
}

function summarizeAccepted(startAmount, simulated, config, consistency) {
  const maxTouch = Math.max(...simulated.legs.map((leg) => leg.bestLevelTouchRatio || 0));
  const maxSlippage = Math.max(...simulated.legs.map((leg) => leg.expectedSlippageBps || 0));
  const limiting = limitingLegFor(simulated.legs, config);

  if (limiting) {
    return {
      accepted: false,
      validationStatus: "rejected",
      validationReason: REJECTION_REASONS.BEST_LEVEL_OVERCONSUMPTION,
      rejectionCode: REJECTION_REASONS.BEST_LEVEL_OVERCONSUMPTION,
      executableStartAmount: startAmount,
      maxExecutableStartAmount: maxExecutableStartAmount(startAmount, simulated.legs, config.maxTouchRatioPerBestLevel),
      limitingLeg: limiting.legIndex,
      limitingMarket: limiting.market,
      expectedSlippageBps: maxSlippage,
      bestLevelTouchRatio: maxTouch,
      residualAfterOrder: limiting.residualAfterOrder,
      depthLegs: simulated.legs,
      ...marketDataConsistencyFields(consistency),
    };
  }

  if (!(simulated.profitRate > config.minNetProfitRate)) {
    return {
      accepted: false,
      validationStatus: "rejected",
      validationReason: REJECTION_REASONS.PROFIT_BELOW_THRESHOLD,
      rejectionCode: REJECTION_REASONS.PROFIT_BELOW_THRESHOLD,
      executableStartAmount: startAmount,
      maxExecutableStartAmount: maxExecutableStartAmount(startAmount, simulated.legs, config.maxTouchRatioPerBestLevel),
      limitingLeg: null,
      limitingMarket: null,
      expectedSlippageBps: maxSlippage,
      bestLevelTouchRatio: maxTouch,
      residualAfterOrder: null,
      depthLegs: simulated.legs,
      ...marketDataConsistencyFields(consistency),
    };
  }

  return {
    accepted: true,
    validationStatus: "accepted",
    validationReason: REJECTION_REASONS.ACCEPTED,
    rejectionCode: null,
    executableStartAmount: startAmount,
    maxExecutableStartAmount: maxExecutableStartAmount(startAmount, simulated.legs, config.maxTouchRatioPerBestLevel),
    limitingLeg: null,
    limitingMarket: null,
    expectedSlippageBps: maxSlippage,
    bestLevelTouchRatio: maxTouch,
    residualAfterOrder: null,
    depthLegs: simulated.legs,
    ...marketDataConsistencyFields(consistency),
  };
}

function validateDepthAwareCandidate(cycle, orderbooks, options = {}) {
  const config = mergeValidationConfig(options.config);
  const startAsset = cycle.startAsset || (Array.isArray(cycle.route) ? cycle.route[0] : null);
  const startAmount = Number(options.startAmount || config.startAmountByAsset[startAsset] || 1);
  const minOrderAmount = Number(config.minOrderAmountByAsset[startAsset] || 0);
  const consistency = collectMarketDataConsistency(
    cycle,
    orderbooks,
    options.observationOrderbooks,
    options.nowMs || Date.now(),
    config,
  );

  if (startAmount < minOrderAmount) {
    return {
      accepted: false,
      validationStatus: "rejected",
      validationReason: REJECTION_REASONS.MIN_ORDER_AMOUNT_NOT_MET,
      rejectionCode: REJECTION_REASONS.MIN_ORDER_AMOUNT_NOT_MET,
      executableStartAmount: startAmount,
      maxExecutableStartAmount: null,
      limitingLeg: null,
      limitingMarket: null,
      expectedSlippageBps: null,
      bestLevelTouchRatio: null,
      residualAfterOrder: null,
      depthLegs: [],
      ...marketDataConsistencyFields(consistency),
    };
  }

  if (!consistency.ok) {
    return rejectWithConsistency(consistency.rejectionCode, startAmount, consistency, {
      limitingMarket: consistency.limitingMarket || null,
    });
  }

  const simulated = simulateCycleWithDepth(cycle, orderbooks, startAmount, options.feeRate || 0, {
    nowMs: options.nowMs,
    staleOrderbookMs: options.staleOrderbookMs,
    maxDepthLevels: options.maxDepthLevels,
    validateOrderTotals: options.validateOrderTotals === true,
    feePolicyByMarket: options.feePolicyByMarket,
    marketPolicyByMarket: options.marketPolicyByMarket,
    resolveLegFee: options.resolveLegFee,
    useDefaultFeePolicy: options.useDefaultFeePolicy === true,
    expectedMaker: options.expectedMaker === true,
    orderType: options.orderType || "limit",
    timeInForce: options.timeInForce || "ioc",
  });

  if (!simulated.available) {
    return {
      accepted: false,
      validationStatus: "rejected",
      validationReason: simulated.rejectionCode || REJECTION_REASONS.DEPTH_INSUFFICIENT,
      rejectionCode: simulated.rejectionCode || REJECTION_REASONS.DEPTH_INSUFFICIENT,
      executableStartAmount: startAmount,
      maxExecutableStartAmount: null,
      limitingLeg: simulated.limitingLeg || null,
      limitingMarket: simulated.limitingMarket || null,
      expectedSlippageBps: null,
      bestLevelTouchRatio: null,
      residualAfterOrder: null,
      depthLegs: simulated.legs || [],
      ...marketDataConsistencyFields(consistency),
    };
  }

  return summarizeAccepted(startAmount, simulated, config, consistency);
}

module.exports = {
  DEFAULT_VALIDATION_CONFIG,
  mergeValidationConfig,
  validateDepthAwareCandidate,
};
