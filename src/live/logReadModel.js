const {
  dryRunReportCsv,
  summarizeDryRun,
} = require("../ops/dryRunReport");

const LOG_KINDS = ["events", "decisions", "market", "orders", "fills", "errors"];

function normalizeType(type = "") {
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

function matchesPeriod(row, filters = {}) {
  const rowMs = rowTimeMs(row);
  const nowMs = parseTimeMs(filters.nowMs) || Date.now();
  const sinceMs = Number(filters.sinceMs);
  const fromMs = Number.isFinite(sinceMs) && sinceMs > 0
    ? nowMs - sinceMs
    : parseTimeMs(filters.from || filters.fromTimestamp);
  const toMs = parseTimeMs(filters.to || filters.toTimestamp);

  if ((fromMs !== null || toMs !== null) && rowMs === null) return false;
  if (fromMs !== null && rowMs < fromMs) return false;
  if (toMs !== null && rowMs > toMs) return false;
  return true;
}

function matchesFilter(row, filters = {}) {
  if (filters.mode && row.mode !== filters.mode) return false;
  if (filters.type && normalizeType(row.type) !== filters.type) return false;
  if (filters.startAsset && row.startAsset !== filters.startAsset) return false;
  if (filters.strategyId && row.strategyId !== filters.strategyId) return false;
  if (filters.cycleId && !String(row.cycleId || "").includes(filters.cycleId)) return false;
  if (!matchesPeriod(row, filters)) return false;
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

module.exports = {
  LOG_KINDS,
  dryRunReportCsv,
  normalizeType,
  parseTimeMs,
  readFilteredLogs,
  rowTimeMs,
  summarizeDryRun,
};
