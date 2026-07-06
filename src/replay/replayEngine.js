const { calculateCycleMultiplier } = require("../lib/multiplier");
const { DryRunExecutor } = require("../execution/dryRunExecutor");
const { summarizeDryRun } = require("../dashboard/dryRunReport");
const { validateDepthAwareCandidate } = require("../live/candidateValidator");
const { createStrategyRegistry } = require("../strategies/registry");
const { latestOrderbooksAt } = require("./orderbookTape");
const { buildReplayManifest } = require("./replayManifest");

function isoAt(baseMs, offsetMs = 0) {
  return new Date(Number(baseMs ?? Date.now()) + offsetMs).toISOString();
}

function expectedNetProfitFor(row = {}, executionPlan = null) {
  const fromPlan = executionPlan && Number(executionPlan.expectedNetProfit);

  if (Number.isFinite(fromPlan)) return fromPlan;

  const startAmount = Number(row.executableStartAmount);
  const netProfitRate = Number(row.netProfitRate);

  if (Number.isFinite(startAmount) && Number.isFinite(netProfitRate)) {
    return startAmount * netProfitRate;
  }

  return null;
}

function replayDecisionRow(result = {}, options = {}) {
  const row = result.row || {};
  const decision = result.decision || {};
  const timestamp = isoAt(options.baseMs, options.offsetMs);

  return {
    type: "strategy-decision",
    timestamp,
    mode: "DRY_RUN",
    cycleId: row.cycleId || result.cycleId,
    routeVariantId: row.routeVariantId,
    startAsset: row.startAsset,
    direction: row.direction,
    strategyId: decision.strategyId || row.strategyId,
    strategyVersion: decision.strategyVersion || row.strategyVersion,
    accepted: decision.accepted === true,
    reason: decision.reason || row.strategyReason,
    status: row.status,
    marketState: row.marketState || row.status,
    opportunityClass: row.opportunityClass,
    staleReason: row.staleReason,
    unavailableReason: row.unavailableReason,
    validationStatus: row.validationStatus,
    validationReason: row.validationReason,
    grossMultiplier: row.grossMultiplier,
    netMultiplier: row.netMultiplier,
    expectedNetProfit: expectedNetProfitFor(row, result.executionPlan),
    latencyMs: row.latency && row.latency.estimatedEndToDisplayMs,
    executableStartAmount: row.executableStartAmount,
    maxExecutableStartAmount: row.maxExecutableStartAmount,
    limitingLeg: row.limitingLeg,
    limitingMarket: row.limitingMarket,
    expectedSlippageBps: row.expectedSlippageBps,
    bestLevelTouchRatio: row.bestLevelTouchRatio,
    observationValidationGapMs: row.observationValidationGapMs,
    observationValidationGapMarket: row.observationValidationGapMarket,
    validationLegTimestampSkewMs: row.validationLegTimestampSkewMs,
    oldestValidationReceivedAgeMs: row.oldestValidationReceivedAgeMs,
    validationOrderbookSources: row.validationOrderbookSources,
  };
}

function normalizeReplayDryRunEvent(event = {}, options = {}) {
  return {
    ...event,
    timestamp: isoAt(options.baseMs, options.offsetMs),
    mode: "DRY_RUN",
  };
}

function legTimestamps(cycle, orderbooks) {
  return (cycle.steps || [])
    .map((step) => {
      const orderbook = orderbooks.get(step.market);
      return orderbook && Number(orderbook.exchangeTimestampMs ?? orderbook.timestamp);
    })
    .filter(Number.isFinite);
}

function oldestLegAgeMs(timestamps, nowMs) {
  if (!timestamps.length) return null;
  return Math.max(...timestamps.map((timestamp) => Math.max(0, nowMs - timestamp)));
}

function replayCycle(cycle, options = {}) {
  const runtimeConfig = options.runtimeConfig || {};
  const feeRate = Number(options.feeRate || 0);
  const nowMs = Number(options.nowMs ?? Date.now());
  const staleOrderbookMs = Number(options.staleOrderbookMs || 3000);
  const validationOrderbooks = latestOrderbooksAt(options.tape || [], nowMs, {
    markets: cycle.markets || (cycle.steps || []).map((step) => step.market),
  });
  const grossResult = calculateCycleMultiplier(cycle, null, validationOrderbooks, 0, { nowMs });
  const netResult = calculateCycleMultiplier(cycle, null, validationOrderbooks, feeRate, { nowMs });
  const grossMultiplier = grossResult.available ? grossResult.multiplier : null;
  const netMultiplier = netResult.available ? netResult.multiplier : null;
  const timestamps = legTimestamps(cycle, validationOrderbooks);
  const marketDataGuards = (runtimeConfig.executionPolicy && runtimeConfig.executionPolicy.marketDataGuards) || {};
  const depthValidation = validateDepthAwareCandidate(cycle, validationOrderbooks, {
    feeRate,
    nowMs,
    staleOrderbookMs,
    config: {
      ...(runtimeConfig.candidateValidation || {}),
      expectedValidationOrderbookUnit: runtimeConfig.validationOrderbookUnit,
      maxValidationLegTimestampSkewMs: marketDataGuards.maxLegTimestampSkewMs,
      maxOldestValidationReceivedAgeMs: marketDataGuards.maxOldestLegAgeMs,
    },
  });
  const status = grossResult.available && netResult.available ? "available" : "unavailable";
  const row = {
    triangleId: cycle.triangleId,
    cycleId: cycle.cycleId,
    routeVariantId: cycle.routeVariantId,
    startAsset: cycle.startAsset,
    endAsset: cycle.endAsset,
    direction: cycle.direction,
    directionLabel: cycle.directionLabel,
    route: cycle.route,
    routeLabel: cycle.routeLabel,
    markets: cycle.markets,
    status,
    unavailableReason: grossResult.unavailableReason || netResult.unavailableReason || null,
    staleReason: null,
    grossMultiplier,
    netMultiplier,
    grossProfitRate: grossMultiplier === null ? null : grossMultiplier - 1,
    netProfitRate: netMultiplier === null ? null : netMultiplier - 1,
    executableStartAmount: depthValidation.executableStartAmount,
    maxExecutableStartAmount: depthValidation.maxExecutableStartAmount,
    limitingLeg: depthValidation.limitingLeg,
    limitingMarket: depthValidation.limitingMarket,
    expectedSlippageBps: depthValidation.expectedSlippageBps,
    bestLevelTouchRatio: depthValidation.bestLevelTouchRatio,
    validationStatus: depthValidation.validationStatus,
    validationReason: depthValidation.validationReason,
    observationValidationGapMs: depthValidation.observationValidationGapMs,
    observationValidationGapMarket: depthValidation.observationValidationGapMarket,
    validationLegTimestampSkewMs: depthValidation.validationLegTimestampSkewMs,
    oldestValidationReceivedAgeMs: depthValidation.oldestValidationReceivedAgeMs,
    validationOrderbookSources: depthValidation.validationOrderbookSources,
    validationOrderbookMetadata: depthValidation.validationOrderbookMetadata,
    legTimestamps: timestamps,
    oldestLegAgeMs: oldestLegAgeMs(timestamps, nowMs),
    calculatedAtEpochMs: nowMs,
    latency: {
      upbitToServerMs: null,
      estimatedEndToDisplayMs: null,
    },
  };
  const registry = options.strategyRegistry || createStrategyRegistry();
  const strategy = registry.get(runtimeConfig.activeStrategyId || "depthAwareLimitIoc");
  const decision = strategy.evaluate({
    cycle,
    row,
    depthValidation,
    config: strategy.defaultConfig,
  });

  row.strategyId = decision.strategyId;
  row.strategyVersion = decision.strategyVersion || strategy.version;
  row.strategyAccepted = decision.accepted;
  row.strategyReason = decision.reason;

  return {
    cycleId: cycle.cycleId,
    row,
    depthValidation,
    decision,
    validationOrderbooks,
    executionPlan: decision.accepted ? strategy.buildExecutionPlan({
      cycle,
      row,
      validationOrderbooks,
      runtimeConfig,
      feeRate,
      staleOrderbookMs,
      engineState: options.engineState || "RUNNING",
      nowMs,
      depthValidation,
      decision,
    }) : null,
  };
}

function replayExecutionPlans(options = {}) {
  const cycles = options.cycles || [];
  const results = cycles.map((cycle) => replayCycle(cycle, options));
  const replayResult = {
    generatedAt: new Date(Number(options.nowMs ?? Date.now())).toISOString(),
    candidateCount: results.length,
    acceptedCount: results.filter((result) => result.decision.accepted).length,
    rejectedCount: results.filter((result) => !result.decision.accepted).length,
    results,
    executionPlans: results.map((result) => result.executionPlan).filter(Boolean),
  };

  replayResult.replayManifest = buildReplayManifest(replayResult, {
    includeCanonical: options.includeCanonicalReplayManifest === true,
  });

  return replayResult;
}

async function replayDryRunReport(options = {}) {
  const replayResult = options.replayResult || replayExecutionPlans(options);
  const baseMs = Number(options.nowMs ?? Date.now());
  const runtimeConfig = options.runtimeConfig || {};
  let offsetMs = 0;
  const dryRunRows = replayResult.results.map((result) => {
    const row = replayDecisionRow(result, { baseMs, offsetMs });

    offsetMs += 1;
    return row;
  });
  const executor = options.dryRunExecutor || new DryRunExecutor({
    simulatedBalances: options.simulatedBalances,
    maxAllocatableByAsset: options.maxAllocatableByAsset,
    validationConfig: {
      ...(runtimeConfig.candidateValidation || {}),
      ...(options.validationConfig || {}),
    },
    latencyLimitMs: options.latencyLimitMs,
  });
  const dryRunExecutions = [];

  for (const plan of replayResult.executionPlans) {
    const beforeEventCount = executor.events.length;
    const execution = await executor.execute({
      ...plan,
      engineState: options.engineState || plan.engineState || "RUNNING",
    });
    const events = executor.events.slice(beforeEventCount).map((event) => {
      const row = normalizeReplayDryRunEvent(event, { baseMs, offsetMs });

      offsetMs += 1;
      return row;
    });

    dryRunRows.push(...events);
    dryRunExecutions.push({
      planId: plan.planId,
      cycleId: plan.cycleId,
      startAsset: plan.startAsset,
      strategyId: plan.strategyId,
      ok: execution.ok,
      reason: execution.reason || null,
      pnl: execution.pnl,
      outputAmount: execution.outputAmount,
      profitRate: execution.profitRate,
      eventCount: events.length,
    });
  }

  const replayResultWithDryRun = {
    ...replayResult,
    dryRunRows,
    dryRunExecutions,
    dryRunReport: summarizeDryRun(dryRunRows, { generatedAtMs: baseMs }),
  };

  replayResultWithDryRun.replayManifest = buildReplayManifest(replayResultWithDryRun, {
    includeCanonical: options.includeCanonicalReplayManifest === true,
  });

  return replayResultWithDryRun;
}

module.exports = {
  replayCycle,
  replayExecutionPlans,
  replayDryRunReport,
};
