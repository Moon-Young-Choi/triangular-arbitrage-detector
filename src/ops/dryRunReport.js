function normalizeReportType(type = "") {
  if (type.startsWith("market.")) return "market";
  if (type.includes("decision")) return "decision";
  if (type.includes("reject") || type.includes("fail") || type.includes("aborted")) return "rejection";
  if (type.includes("fill")) return "fill";
  if (type.startsWith("order.")) return "order";
  if (type.startsWith("position.")) return "position";
  if (type === "cycle.done") return "cycle";
  if (type.includes("error")) return "error";
  return type || "event";
}

function parseTimeMs(value) {
  if (value === undefined || value === null || value === "") return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function rowTimeMs(row = {}) {
  return parseTimeMs(row.timestamp || row.ts || row.tradeTimestamp || row.orderTimestamp || row.eventTimestamp);
}

function isDryRunCycleDone(row) {
  return row.type === "cycle.simulated_done" ||
    (row.type === "cycle.done" && row.mode === "DRY_RUN");
}

function isDryRunCycleFail(row) {
  return row.type === "cycle.simulated_fail" ||
    (row.type === "cycle.aborted" && row.mode === "DRY_RUN");
}

function percentile(values, p) {
  const finite = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (finite.length === 0) return null;
  const index = Math.ceil((p / 100) * finite.length) - 1;
  return finite[Math.max(0, Math.min(finite.length - 1, index))];
}

function distribution(values) {
  const finite = values.filter(Number.isFinite);

  return {
    count: finite.length,
    p50: percentile(finite, 50),
    p95: percentile(finite, 95),
    p99: percentile(finite, 99),
    min: finite.length > 0 ? Math.min(...finite) : null,
    max: finite.length > 0 ? Math.max(...finite) : null,
  };
}

function rate(count, denominator) {
  return denominator > 0 ? count / denominator : 0;
}

function rejectionReason(row) {
  return row.reason || row.validationReason || row.rejectionReason || "UNKNOWN";
}

function expectedProfitValue(row) {
  const value = Number(row.expectedNetProfit || row.expectedProfit);
  return Number.isFinite(value) ? value : null;
}

function isDepthRejection(reason) {
  return /DEPTH|ORDERBOOK|BEST_LEVEL|LIQUIDITY|STALE/i.test(String(reason || ""));
}

function isLatencyRejection(reason) {
  return /LATENCY|STALE|AGE|SKEW/i.test(String(reason || ""));
}

function createGroupStats(id) {
  return {
    id,
    sortOrder: Number.MAX_SAFE_INTEGER,
    opportunities: 0,
    accepted: 0,
    rejected: 0,
    simulatedCompleteCycles: 0,
    simulatedFailedCycles: 0,
    expectedNetProfit: 0,
    simulatedNetProfit: 0,
  };
}

function marketStateFor(row = {}) {
  return row.marketState ||
    row.status ||
    row.validationStatus ||
    row.opportunityClass ||
    "unknown";
}

function finiteNumber(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === "") continue;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

function latencyValueFor(row = {}) {
  const latency = row.latency || {};
  return finiteNumber(
    row.latencyMs,
    row.decisionLatencyMs,
    row.expectedLatencyMs,
    row.estimatedEndToDisplayMs,
    latency.decisionAgeMs,
    latency.estimatedEndToDisplayMs,
    latency.totalMs,
  );
}

function bestLevelTouchRatioFor(row = {}) {
  const depthValidation = row.depthValidation || {};
  const validation = row.validation || {};
  return finiteNumber(
    row.bestLevelTouchRatio,
    row.maxBestLevelTouchRatio,
    depthValidation.bestLevelTouchRatio,
    depthValidation.maxBestLevelTouchRatio,
    validation.bestLevelTouchRatio,
    validation.maxBestLevelTouchRatio,
  );
}

const LATENCY_BUCKETS = [
  { id: "0-100ms", max: 100 },
  { id: "100-250ms", max: 250 },
  { id: "250-500ms", max: 500 },
  { id: "500-1000ms", max: 1000 },
  { id: "1000ms+", max: Number.POSITIVE_INFINITY },
];

const BEST_TOUCH_RATIO_BUCKETS = [
  { id: "0-10%", max: 0.1 },
  { id: "10-25%", max: 0.25 },
  { id: "25-50%", max: 0.5 },
  { id: "50-75%", max: 0.75 },
  { id: "75-100%", max: 1 },
  { id: "100%+", max: Number.POSITIVE_INFINITY },
];

function bucketForValue(value, buckets) {
  if (!Number.isFinite(value)) {
    return { id: "unknown", sortOrder: buckets.length };
  }

  const index = buckets.findIndex((bucket) => value <= bucket.max);
  if (index === -1) {
    return { id: "unknown", sortOrder: buckets.length };
  }

  return {
    id: buckets[index].id,
    sortOrder: index,
  };
}

function incrementGroup(groups, key, updater, metadata = {}) {
  if (!key) return;
  if (!groups[key]) {
    groups[key] = createGroupStats(key);
  }
  if (Number.isFinite(metadata.sortOrder)) {
    groups[key].sortOrder = metadata.sortOrder;
  }
  updater(groups[key]);
}

function summarizeDryRun(rows, options = {}) {
  const dryRows = rows.filter((row) => row.mode === "DRY_RUN" && row.excludeFromDryRunSummary !== true);
  const decisions = dryRows.filter((row) => normalizeReportType(row.type) === "decision");
  const accepted = decisions.filter((row) => row.accepted === true);
  const strategyRejected = decisions.filter((row) => row.accepted === false);
  const rejected = dryRows.filter((row) => (
    row.accepted === false ||
    normalizeReportType(row.type) === "rejection" ||
    isDryRunCycleFail(row)
  ));
  const rejectedByReason = {};
  const byStartAsset = {};
  const byStrategy = {};
  const byRoute = {};
  const byMarketState = {};
  const byLatencyBand = {};
  const byBestLevelTouchRatio = {};
  const dryRowTimes = dryRows.map(rowTimeMs).filter(Number.isFinite);

  rejected.forEach((row) => {
    const reason = rejectionReason(row);
    rejectedByReason[reason] = (rejectedByReason[reason] || 0) + 1;
  });

  const completedCycles = dryRows.filter(isDryRunCycleDone);
  const failedCycles = dryRows.filter(isDryRunCycleFail);
  const simulatedAttemptCycles = completedCycles.length + failedCycles.length;
  const attemptedRows = [...completedCycles, ...failedCycles];
  const attemptedExpectedValues = attemptedRows.map(expectedProfitValue).filter((value) => value !== null);
  const decisionExpectedValues = decisions.map(expectedProfitValue).filter((value) => value !== null);
  const expectedNetProfit = (attemptedExpectedValues.length > 0 ? attemptedExpectedValues : decisionExpectedValues)
    .reduce((sum, value) => sum + value, 0);
  const simulatedNetProfit = completedCycles.reduce((sum, row) => sum + Number(row.pnl || 0), 0);
  const expectedSimulatedGap = expectedNetProfit - simulatedNetProfit;
  const expectedSimulatedGapRate = expectedNetProfit === 0
    ? (simulatedNetProfit === 0 ? 0 : Number.POSITIVE_INFINITY)
    : Math.abs(expectedSimulatedGap) / Math.abs(expectedNetProfit);
  const expectedProfitValues = decisionExpectedValues;
  const simulatedProfitValues = completedCycles
    .map((row) => Number(row.pnl))
    .filter(Number.isFinite);
  const simulatedProfitRateValues = completedCycles
    .map((row) => Number(row.profitRate || row.simulatedProfitRate))
    .filter(Number.isFinite);
  const touchRatioValues = dryRows
    .map(bestLevelTouchRatioFor)
    .filter(Number.isFinite);
  const latencyValues = dryRows
    .map(latencyValueFor)
    .filter(Number.isFinite);
  const depthRejectCount = rejected.filter((row) => isDepthRejection(rejectionReason(row))).length;
  const latencyRejectCount = rejected.filter((row) => isLatencyRejection(rejectionReason(row))).length;

  decisions.forEach((row) => {
    const expected = Number(row.expectedNetProfit || row.expectedProfit || 0);
    const applyDecision = (group) => {
      group.opportunities += 1;
      group.expectedNetProfit += expected;
      if (row.accepted === true) {
        group.accepted += 1;
      } else if (row.accepted === false) {
        group.rejected += 1;
      }
    };

    incrementGroup(byStartAsset, row.startAsset, applyDecision);
    incrementGroup(byStrategy, row.strategyId, applyDecision);
    incrementGroup(byRoute, row.routeVariantId || row.cycleId, applyDecision);
    incrementGroup(byMarketState, marketStateFor(row), applyDecision);
    const latencyBucket = bucketForValue(latencyValueFor(row), LATENCY_BUCKETS);
    const touchBucket = bucketForValue(bestLevelTouchRatioFor(row), BEST_TOUCH_RATIO_BUCKETS);
    incrementGroup(byLatencyBand, latencyBucket.id, applyDecision, { sortOrder: latencyBucket.sortOrder });
    incrementGroup(byBestLevelTouchRatio, touchBucket.id, applyDecision, { sortOrder: touchBucket.sortOrder });
  });

  [...completedCycles, ...failedCycles].forEach((row) => {
    const pnl = isDryRunCycleDone(row) ? Number(row.pnl || 0) : 0;
    const applyCycle = (group) => {
      if (isDryRunCycleDone(row)) {
        group.simulatedCompleteCycles += 1;
        group.simulatedNetProfit += pnl;
      } else {
        group.simulatedFailedCycles += 1;
      }
    };

    incrementGroup(byStartAsset, row.startAsset, applyCycle);
    incrementGroup(byStrategy, row.strategyId, applyCycle);
    incrementGroup(byRoute, row.routeVariantId || row.cycleId, applyCycle);
    incrementGroup(byMarketState, marketStateFor(row), applyCycle);
    const latencyBucket = bucketForValue(latencyValueFor(row), LATENCY_BUCKETS);
    const touchBucket = bucketForValue(bestLevelTouchRatioFor(row), BEST_TOUCH_RATIO_BUCKETS);
    incrementGroup(byLatencyBand, latencyBucket.id, applyCycle, { sortOrder: latencyBucket.sortOrder });
    incrementGroup(byBestLevelTouchRatio, touchBucket.id, applyCycle, { sortOrder: touchBucket.sortOrder });
  });

  return {
    generatedAt: options.generatedAt ||
      (options.generatedAtMs !== undefined ? new Date(Number(options.generatedAtMs)).toISOString() : new Date().toISOString()),
    period: {
      from: dryRowTimes.length > 0 ? new Date(Math.min(...dryRowTimes)).toISOString() : null,
      to: dryRowTimes.length > 0 ? new Date(Math.max(...dryRowTimes)).toISOString() : null,
      rowCount: dryRows.length,
    },
    totalOpportunities: decisions.length,
    accepted: accepted.length,
    strategyRejected: strategyRejected.length,
    rejected: rejected.length,
    rejectedByReason,
    rejectionRate: rate(rejected.length, decisions.length),
    depthRejectionRate: rate(depthRejectCount, decisions.length),
    latencyRejectionRate: rate(latencyRejectCount, decisions.length),
    simulatedCompleteCycles: completedCycles.length,
    simulatedFailedCycles: failedCycles.length,
    simulatedAttemptCycles,
    simulatedCompleteRate: rate(completedCycles.length, simulatedAttemptCycles),
    simulatedFailureRate: rate(failedCycles.length, simulatedAttemptCycles),
    expectedNetProfit,
    simulatedNetProfit,
    expectedSimulatedGap,
    expectedSimulatedGapRate,
    expectedProfitDistribution: distribution(expectedProfitValues),
    simulatedProfitDistribution: distribution(simulatedProfitValues),
    simulatedProfitRateDistribution: distribution(simulatedProfitRateValues),
    bestLevelTouchRatioDistribution: distribution(touchRatioValues),
    latencyDistribution: {
      count: latencyValues.length,
      p50Ms: percentile(latencyValues, 50),
      p95Ms: percentile(latencyValues, 95),
      p99Ms: percentile(latencyValues, 99),
    },
    byStartAsset,
    byStrategy,
    byRoute,
    byMarketState,
    byLatencyBand,
    byBestLevelTouchRatio,
  };
}

function sortedGroupEntries(groups = {}) {
  const preferred = ["KRW", "BTC", "USDT"];

  return Object.entries(groups).sort(([left], [right]) => {
    const leftSortOrder = groups[left] && groups[left].sortOrder;
    const rightSortOrder = groups[right] && groups[right].sortOrder;
    if (leftSortOrder !== rightSortOrder && Number.isFinite(leftSortOrder) && Number.isFinite(rightSortOrder)) {
      return leftSortOrder - rightSortOrder;
    }
    const leftIndex = preferred.includes(left) ? preferred.indexOf(left) : preferred.length;
    const rightIndex = preferred.includes(right) ? preferred.indexOf(right) : preferred.length;
    return leftIndex === rightIndex ? left.localeCompare(right) : leftIndex - rightIndex;
  });
}

function dryRunGroupCsvRows(groups, prefix) {
  return sortedGroupEntries(groups).flatMap(([id, group]) => {
    const attempts = Number(group.simulatedCompleteCycles || 0) + Number(group.simulatedFailedCycles || 0);
    const completeRate = attempts > 0 ? Number(group.simulatedCompleteCycles || 0) / attempts : 0;

    return [
      [`${prefix}:${id}:opportunities`, group.opportunities],
      [`${prefix}:${id}:accepted`, group.accepted],
      [`${prefix}:${id}:rejected`, group.rejected],
      [`${prefix}:${id}:simulatedCompleteCycles`, group.simulatedCompleteCycles],
      [`${prefix}:${id}:simulatedFailedCycles`, group.simulatedFailedCycles],
      [`${prefix}:${id}:simulatedCompleteRate`, completeRate],
      [`${prefix}:${id}:expectedNetProfit`, group.expectedNetProfit],
      [`${prefix}:${id}:simulatedNetProfit`, group.simulatedNetProfit],
    ];
  });
}

function dryRunReportCsv(summary) {
  const rows = [
    ["metric", "value"],
    ["generatedAt", summary.generatedAt],
    ["periodFrom", summary.period && summary.period.from],
    ["periodTo", summary.period && summary.period.to],
    ["periodRowCount", summary.period && summary.period.rowCount],
    ["totalOpportunities", summary.totalOpportunities],
    ["accepted", summary.accepted],
    ["strategyRejected", summary.strategyRejected],
    ["rejected", summary.rejected],
    ["rejectionRate", summary.rejectionRate],
    ["depthRejectionRate", summary.depthRejectionRate],
    ["latencyRejectionRate", summary.latencyRejectionRate],
    ["simulatedCompleteCycles", summary.simulatedCompleteCycles],
    ["simulatedFailedCycles", summary.simulatedFailedCycles],
    ["simulatedCompleteRate", summary.simulatedCompleteRate],
    ["expectedNetProfit", summary.expectedNetProfit],
    ["simulatedNetProfit", summary.simulatedNetProfit],
    ["expectedSimulatedGap", summary.expectedSimulatedGap],
    ["expectedSimulatedGapRate", summary.expectedSimulatedGapRate],
    ["latencyP50Ms", summary.latencyDistribution.p50Ms],
    ["latencyP95Ms", summary.latencyDistribution.p95Ms],
    ["latencyP99Ms", summary.latencyDistribution.p99Ms],
    ["bestTouchP50", summary.bestLevelTouchRatioDistribution.p50],
    ["bestTouchP95", summary.bestLevelTouchRatioDistribution.p95],
    ["bestTouchP99", summary.bestLevelTouchRatioDistribution.p99],
    ...Object.entries(summary.rejectedByReason).map(([reason, count]) => [`rejected:${reason}`, count]),
    ...dryRunGroupCsvRows(summary.byStartAsset, "startAsset"),
    ...dryRunGroupCsvRows(summary.byStrategy, "strategy"),
    ...dryRunGroupCsvRows(summary.byRoute, "route"),
    ...dryRunGroupCsvRows(summary.byMarketState, "marketState"),
    ...dryRunGroupCsvRows(summary.byLatencyBand, "latencyBand"),
    ...dryRunGroupCsvRows(summary.byBestLevelTouchRatio, "bestLevelTouchRatio"),
  ];

  return `${rows.map((row) => row.map((value) => JSON.stringify(value ?? "")).join(",")).join("\n")}\n`;
}

module.exports = {
  BEST_TOUCH_RATIO_BUCKETS,
  LATENCY_BUCKETS,
  bestLevelTouchRatioFor,
  dryRunReportCsv,
  latencyValueFor,
  normalizeReportType,
  summarizeDryRun,
};
