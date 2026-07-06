const crypto = require("node:crypto");

function stableValue(value) {
  if (value instanceof Map) {
    return stableValue(Object.fromEntries([...value.entries()].sort(([left], [right]) => String(left).localeCompare(String(right)))));
  }

  if (value instanceof Set) {
    return [...value].map(stableValue).sort();
  }

  if (Array.isArray(value)) {
    return value.map(stableValue);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined && typeof item !== "function")
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  return value;
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function replayFingerprint(value) {
  return crypto
    .createHash("sha256")
    .update(stableStringify(value))
    .digest("hex");
}

function canonicalOrderbook(orderbook = {}) {
  return {
    market: orderbook.market,
    exchangeTimestampMs: orderbook.exchangeTimestampMs ?? orderbook.timestamp,
    serverReceivedAtMs: orderbook.serverReceivedAtMs ?? orderbook.receivedAt,
    orderbookUnit: orderbook.orderbookUnit ?? orderbook.unit,
    orderbookLevel: orderbook.orderbookLevel ?? null,
    traceId: orderbook.traceId || null,
    orderbook_units: (orderbook.orderbook_units || orderbook.orderbookUnits || []).map((unit) => ({
      ask_price: Number(unit.ask_price ?? unit.askPrice),
      bid_price: Number(unit.bid_price ?? unit.bidPrice),
      ask_size: Number(unit.ask_size ?? unit.askSize),
      bid_size: Number(unit.bid_size ?? unit.bidSize),
    })),
  };
}

function canonicalValidationOrderbooks(validationOrderbooks) {
  if (!validationOrderbooks) return {};
  const entries = validationOrderbooks instanceof Map
    ? [...validationOrderbooks.entries()]
    : Object.entries(validationOrderbooks);

  return Object.fromEntries(
    entries
      .sort(([left], [right]) => String(left).localeCompare(String(right)))
      .map(([market, orderbook]) => [market, canonicalOrderbook(orderbook)]),
  );
}

function pick(source = {}, fields = []) {
  return Object.fromEntries(
    fields.map((field) => [field, source[field]]),
  );
}

function canonicalReplayCandidate(result = {}) {
  const row = result.row || {};

  return {
    cycleId: result.cycleId || row.cycleId,
    row: pick(row, [
      "cycleId",
      "routeVariantId",
      "startAsset",
      "direction",
      "status",
      "marketState",
      "unavailableReason",
      "grossMultiplier",
      "netMultiplier",
      "netProfitRate",
      "executableStartAmount",
      "maxExecutableStartAmount",
      "validationStatus",
      "validationReason",
      "strategyId",
      "strategyVersion",
      "strategyAccepted",
      "strategyReason",
      "expectedSlippageBps",
      "bestLevelTouchRatio",
      "oldestValidationReceivedAgeMs",
      "validationLegTimestampSkewMs",
    ]),
    depthValidation: pick(result.depthValidation || {}, [
      "validationStatus",
      "validationReason",
      "executableStartAmount",
      "maxExecutableStartAmount",
      "limitingLeg",
      "limitingMarket",
      "expectedSlippageBps",
      "bestLevelTouchRatio",
      "observationValidationGapMs",
      "validationLegTimestampSkewMs",
      "oldestValidationReceivedAgeMs",
      "expectedValidationOrderbookUnit",
    ]),
    decision: pick(result.decision || {}, [
      "accepted",
      "reason",
      "strategyId",
      "strategyVersion",
    ]),
  };
}

function canonicalExecutionPlan(plan = {}) {
  return {
    planId: plan.planId,
    mode: plan.mode,
    executionMode: plan.executionMode,
    strategyId: plan.strategyId,
    strategyVersion: plan.strategyVersion,
    cycleId: plan.cycleId,
    routeVariantId: plan.routeVariantId,
    startAsset: plan.startAsset,
    status: plan.status,
    marketState: plan.marketState,
    opportunityClass: plan.opportunityClass,
    startAmount: plan.startAmount,
    expectedOutputAmount: plan.expectedOutputAmount,
    expectedNetProfit: plan.expectedNetProfit,
    feeRate: plan.feeRate,
    staleOrderbookMs: plan.staleOrderbookMs,
    engineState: plan.engineState,
    nowMs: plan.nowMs,
    oldestLegAgeMs: plan.oldestLegAgeMs,
    legTimestampSkewMs: plan.legTimestampSkewMs,
    exchangeToServerLatencyMs: plan.exchangeToServerLatencyMs,
    decisionAgeMs: plan.decisionAgeMs,
    executableStartAmount: plan.executableStartAmount,
    maxExecutableStartAmount: plan.maxExecutableStartAmount,
    limitingLeg: plan.limitingLeg,
    limitingMarket: plan.limitingMarket,
    expectedSlippageBps: plan.expectedSlippageBps,
    bestLevelTouchRatio: plan.bestLevelTouchRatio,
    validationStatus: plan.validationStatus,
    validationReason: plan.validationReason,
    validationOrderbooks: canonicalValidationOrderbooks(plan.validationOrderbooks),
  };
}

function canonicalReplayPayload(replayResult = {}) {
  return {
    generatedAt: replayResult.generatedAt,
    candidateCount: replayResult.candidateCount,
    acceptedCount: replayResult.acceptedCount,
    rejectedCount: replayResult.rejectedCount,
    candidates: (replayResult.results || []).map(canonicalReplayCandidate),
    executionPlans: (replayResult.executionPlans || []).map(canonicalExecutionPlan),
    dryRunReport: replayResult.dryRunReport || null,
    dryRunExecutions: replayResult.dryRunExecutions || [],
  };
}

function buildReplayManifest(replayResult = {}, options = {}) {
  const payload = canonicalReplayPayload(replayResult);
  const candidates = payload.candidates;
  const executionPlans = payload.executionPlans;
  const dryRunReport = payload.dryRunReport;
  const dryRunExecutions = payload.dryRunExecutions;

  return {
    generatedAt: replayResult.generatedAt,
    candidateCount: replayResult.candidateCount || 0,
    acceptedCount: replayResult.acceptedCount || 0,
    rejectedCount: replayResult.rejectedCount || 0,
    executionPlanCount: executionPlans.length,
    dryRunExecutionCount: dryRunExecutions.length,
    fingerprints: {
      candidates: replayFingerprint(candidates),
      executionPlans: replayFingerprint(executionPlans),
      dryRunReport: dryRunReport ? replayFingerprint(dryRunReport) : null,
      dryRunExecutions: dryRunExecutions.length > 0 ? replayFingerprint(dryRunExecutions) : null,
      overall: replayFingerprint(payload),
    },
    canonical: options.includeCanonical === true ? payload : undefined,
  };
}

module.exports = {
  buildReplayManifest,
  canonicalExecutionPlan,
  canonicalReplayCandidate,
  canonicalReplayPayload,
  replayFingerprint,
  stableStringify,
  stableValue,
};
