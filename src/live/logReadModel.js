const LOG_KINDS = ["events", "decisions", "orders", "fills", "errors"];

function normalizeType(type = "") {
  if (type.includes("decision")) return "decision";
  if (type.includes("reject") || type.includes("fail")) return "rejection";
  if (type.includes("fill")) return "fill";
  if (type.startsWith("order.")) return "order";
  if (type.includes("error")) return "error";
  return type || "event";
}

function matchesFilter(row, filters = {}) {
  if (filters.mode && row.mode !== filters.mode) return false;
  if (filters.type && normalizeType(row.type) !== filters.type) return false;
  if (filters.startAsset && row.startAsset !== filters.startAsset) return false;
  if (filters.strategyId && row.strategyId !== filters.strategyId) return false;
  if (filters.cycleId && !String(row.cycleId || "").includes(filters.cycleId)) return false;
  return true;
}

async function readFilteredLogs(logStore, filters = {}) {
  const kinds = filters.kind && filters.kind !== "all" ? [filters.kind] : LOG_KINDS;
  const limit = filters.limit || 500;
  const rows = [];

  for (const kind of kinds) {
    const items = await logStore.readAll(kind, { limit });
    items.forEach((item) => {
      rows.push({
        ...item,
        logKind: kind,
        normalizedType: normalizeType(item.type),
      });
    });
  }

  return rows
    .filter((row) => matchesFilter(row, filters))
    .sort((left, right) => String(left.timestamp || "").localeCompare(String(right.timestamp || "")))
    .slice(-limit);
}

function percentile(values, p) {
  const finite = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (finite.length === 0) return null;
  const index = Math.ceil((p / 100) * finite.length) - 1;
  return finite[Math.max(0, Math.min(finite.length - 1, index))];
}

function summarizeDryRun(rows) {
  const dryRows = rows.filter((row) => row.mode === "DRY_RUN");
  const decisions = dryRows.filter((row) => normalizeType(row.type) === "decision");
  const accepted = decisions.filter((row) => row.accepted === true);
  const rejected = dryRows.filter((row) => (
    row.accepted === false ||
    normalizeType(row.type) === "rejection" ||
    row.type === "cycle.simulated_fail"
  ));
  const rejectedByReason = {};

  rejected.forEach((row) => {
    const reason = row.reason || row.validationReason || row.rejectionReason || "UNKNOWN";
    rejectedByReason[reason] = (rejectedByReason[reason] || 0) + 1;
  });

  const completedCycles = dryRows.filter((row) => row.type === "cycle.simulated_done");
  const failedCycles = dryRows.filter((row) => row.type === "cycle.simulated_fail");
  const expectedNetProfit = dryRows.reduce((sum, row) => sum + Number(row.expectedNetProfit || row.expectedProfit || 0), 0);
  const simulatedNetProfit = completedCycles.reduce((sum, row) => sum + Number(row.pnl || 0), 0);
  const latencyValues = dryRows
    .map((row) => Number(row.latencyMs || row.estimatedEndToDisplayMs || row.expectedLatencyMs))
    .filter(Number.isFinite);

  return {
    generatedAt: new Date().toISOString(),
    totalOpportunities: decisions.length,
    accepted: accepted.length,
    rejected: rejected.length,
    rejectedByReason,
    simulatedCompleteCycles: completedCycles.length,
    simulatedFailedCycles: failedCycles.length,
    expectedNetProfit,
    simulatedNetProfit,
    latencyDistribution: {
      count: latencyValues.length,
      p50Ms: percentile(latencyValues, 50),
      p95Ms: percentile(latencyValues, 95),
      p99Ms: percentile(latencyValues, 99),
    },
  };
}

function dryRunReportCsv(summary) {
  const rows = [
    ["metric", "value"],
    ["generatedAt", summary.generatedAt],
    ["totalOpportunities", summary.totalOpportunities],
    ["accepted", summary.accepted],
    ["rejected", summary.rejected],
    ["simulatedCompleteCycles", summary.simulatedCompleteCycles],
    ["simulatedFailedCycles", summary.simulatedFailedCycles],
    ["expectedNetProfit", summary.expectedNetProfit],
    ["simulatedNetProfit", summary.simulatedNetProfit],
    ["latencyP50Ms", summary.latencyDistribution.p50Ms],
    ["latencyP95Ms", summary.latencyDistribution.p95Ms],
    ["latencyP99Ms", summary.latencyDistribution.p99Ms],
    ...Object.entries(summary.rejectedByReason).map(([reason, count]) => [`rejected:${reason}`, count]),
  ];

  return `${rows.map((row) => row.map((value) => JSON.stringify(value ?? "")).join(",")).join("\n")}\n`;
}

module.exports = {
  LOG_KINDS,
  normalizeType,
  readFilteredLogs,
  summarizeDryRun,
  dryRunReportCsv,
};
