const { balanceView, formatNumber, renderBalanceSection } = require("./balances");
const {
  directionLabel,
  isContractEvent,
  normalizedContract,
  renderContract,
} = require("./contracts");
const { renderKeyValues, renderTable } = require("./table");

const ANSI = Object.freeze({
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
});

function colorize(text, color, options = {}) {
  if (!options.color) return text;
  return `${ANSI[color] || ""}${text}${ANSI.reset}`;
}

function monitorColorEnabled(output = process.stdout, options = {}) {
  const colorOption = String(options.color || "").toLowerCase();
  if (colorOption === "always") return true;
  if (options.noColor === true || colorOption === "never" || process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0") return true;
  return output && output.isTTY === true;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseTimeMs(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function rowTimeMs(row = {}) {
  return parseTimeMs(row.timestamp || row.ts || row.tradeTimestamp || row.orderTimestamp);
}

function runtimeConfig(snapshot = {}) {
  return snapshot.runtimeConfig || {};
}

function engineState(snapshot = {}) {
  return snapshot.engineState || (snapshot.engine && snapshot.engine.state) || "UNKNOWN";
}

function engineRunBaselineMs(snapshot = {}, fallbackMs = null) {
  const processInfo = snapshot.engineProcess || {};
  const candidates = [
    processInfo.startedAtEpochMs,
    processInfo.startedAt,
    snapshot.serverStartedAt,
  ];

  for (const candidate of candidates) {
    const parsed = parseTimeMs(candidate);
    if (parsed !== null) return parsed;
  }

  return Number.isFinite(Number(fallbackMs)) ? Number(fallbackMs) : null;
}

function snapshotAgeMs(snapshot = {}, nowMs = Date.now()) {
  const candidates = [
    snapshot.summary && snapshot.summary.lastUpdateTime,
    snapshot.lastCalculatedAt,
    snapshot.updatedAt,
    snapshot.serverStartedAt,
  ];

  for (const candidate of candidates) {
    const parsed = parseTimeMs(candidate);
    if (parsed !== null) return Math.max(0, nowMs - parsed);
  }

  return null;
}

function contractsSinceRun(rows = [], baselineMs = null) {
  const baseline = Number.isFinite(Number(baselineMs)) ? Number(baselineMs) : null;
  return rows
    .filter(isContractEvent)
    .filter((row) => {
      if (baseline === null) return true;
      const ms = rowTimeMs(row);
      return ms !== null && ms >= baseline;
    })
    .sort((left, right) => {
      const leftMs = rowTimeMs(left) || 0;
      const rightMs = rowTimeMs(right) || 0;
      if (leftMs !== rightMs) return leftMs - rightMs;
      return String(left.eventId || left.planId || "").localeCompare(String(right.eventId || right.planId || ""));
    });
}

function contractKey(row = {}) {
  return [
    row.eventId || "",
    row.timestamp || row.ts || "",
    row.mode || "",
    row.planId || "",
    row.cycleId || "",
  ].join("|");
}

function formatSignedNumber(value, digits = 8, options = {}) {
  const numeric = numberOrNull(value);
  if (numeric === null) return "-";
  const sign = numeric > 0 ? "+" : "";
  const text = `${sign}${formatNumber(numeric, digits)}`;
  if (numeric > 0) return colorize(text, "green", options);
  if (numeric < 0) return colorize(text, "red", options);
  return colorize(text, "dim", options);
}

function formatSignedAsset(value, asset = "", options = {}) {
  const numeric = numberOrNull(value);
  if (numeric === null) return "-";
  const digits = asset === "KRW" ? 2 : 8;
  const amount = formatSignedNumber(numeric, digits, options);
  return asset ? `${amount} ${asset}` : amount;
}

function formatPercent(value, options = {}) {
  const numeric = numberOrNull(value);
  if (numeric === null) return "-";
  const text = `${numeric > 0 ? "+" : ""}${(numeric * 100).toFixed(4)}%`;
  if (numeric > 0) return colorize(text, "green", options);
  if (numeric < 0) return colorize(text, "red", options);
  return colorize(text, "dim", options);
}

function formatMs(value) {
  const numeric = numberOrNull(value);
  if (numeric === null) return "-";
  return `${numeric.toFixed(0)}ms`;
}

function formatMode(mode = "", options = {}) {
  const normalized = String(mode || "-").toUpperCase();
  if (normalized.startsWith("REAL")) return colorize(normalized, "red", options);
  if (normalized === "DRY_RUN") return colorize(normalized, "yellow", options);
  return colorize(normalized, "dim", options);
}

function field(row = {}, key) {
  if (row[key] !== undefined && row[key] !== null) return row[key];
  if (row.payload && row.payload[key] !== undefined && row.payload[key] !== null) {
    return row.payload[key];
  }
  return null;
}

function triangleId(row = {}) {
  const explicit = field(row, "triangleId");
  if (explicit) return explicit;
  const cycleId = String(field(row, "cycleId") || "");
  return cycleId.includes(":") ? cycleId.split(":")[0] : cycleId || "-";
}

function routeLabel(row = {}) {
  const route = field(row, "route");
  if (Array.isArray(route) && route.length > 0) return route.join("->");
  return field(row, "routeLabel") || field(row, "routeVariantId") || field(row, "cycleId") || "-";
}

function shortText(value, max = 34) {
  const text = String(value || "-");
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}...` : text;
}

function timeLabel(row = {}) {
  const ms = rowTimeMs(row);
  if (ms === null) return "-";
  return new Date(ms).toISOString().slice(11, 19);
}

function summarizeContracts(rows = []) {
  const groups = new Map();

  for (const row of rows) {
    const contract = normalizedContract(row);
    const mode = contract.mode || row.mode || "-";
    const asset = contract.startAsset || "-";
    const key = `${mode}|${asset}`;
    const group = groups.get(key) || {
      mode,
      asset,
      contracts: 0,
      wins: 0,
      losses: 0,
      flat: 0,
      pnl: 0,
      startAmount: 0,
    };
    const pnl = numberOrNull(contract.pnl) || 0;
    const startAmount = numberOrNull(contract.startAmount) || 0;

    group.contracts += 1;
    group.pnl += pnl;
    group.startAmount += startAmount;
    if (pnl > 0) group.wins += 1;
    else if (pnl < 0) group.losses += 1;
    else group.flat += 1;
    groups.set(key, group);
  }

  return [...groups.values()].sort((left, right) => {
    if (left.mode !== right.mode) return left.mode.localeCompare(right.mode);
    return left.asset.localeCompare(right.asset);
  });
}

function pnlRows(rows = [], options = {}) {
  return summarizeContracts(rows).map((group) => {
    const returnRate = group.startAmount > 0 ? group.pnl / group.startAmount : null;
    return [
      formatMode(group.mode, options),
      group.asset,
      group.contracts,
      `${group.wins}/${group.losses}/${group.flat}`,
      formatSignedAsset(group.pnl, group.asset, options),
      formatPercent(returnRate, options),
    ];
  });
}

function latestRows(rows = [], options = {}) {
  return rows.map((row) => {
    const contract = normalizedContract(row);
    const timing = contract.cycleExecutionLatency || {};
    return [
      timeLabel(row),
      formatMode(contract.mode, options),
      contract.startAsset || "-",
      formatSignedAsset(contract.pnl, contract.startAsset, options),
      formatPercent(contract.profitRate, options),
      shortText(triangleId(row), 22),
      shortText(routeLabel(row), 34),
      directionLabel(row),
      shortText(contract.strategyId, 22),
      timing.simulated ? `sim ${formatMs(timing.cycleTotalMs || 0)}` : formatMs(timing.cycleTotalMs),
    ];
  });
}

function renderContractsMonitor(snapshot = {}, logs = [], options = {}) {
  const nowMs = options.nowMs || Date.now();
  const config = runtimeConfig(snapshot);
  const execution = snapshot.execution || {};
  const mode = config.runMode || execution.mode || "OBSERVE";
  const liveTradingEnabled = config.liveTradingEnabled === true || execution.liveTradingEnabled === true;
  const baselineMs = engineRunBaselineMs(snapshot, options.baselineMs || options.monitorStartedAtMs || nowMs);
  const contracts = contractsSinceRun(logs, baselineMs);
  const maxRows = Math.max(1, Number.parseInt(options.maxRows || "12", 10));
  const detailCount = Math.max(0, Number.parseInt(options.detailCount || "2", 10));
  const recent = contracts.slice(-maxRows).reverse();
  const details = contracts.slice(-detailCount).reverse();
  const ageMs = snapshotAgeMs(snapshot, nowMs);
  const balance = balanceView(snapshot);
  const title = colorize("q-gagarin contracts", "bold", options);
  const pnl = pnlRows(contracts, options);
  const latest = latestRows(recent, options);

  return [
    `${title} ${colorize(new Date(nowMs).toISOString(), "dim", options)}`,
    "",
    renderKeyValues([
      ["Engine", colorize(engineState(snapshot), engineState(snapshot) === "RUNNING" ? "green" : "yellow", options)],
      ["Mode", formatMode(mode, options)],
      ["Live trading", liveTradingEnabled ? colorize("yes", "red", options) : colorize("no", "dim", options)],
      ["Strategy", config.activeStrategyId || "-"],
      ["Run baseline", baselineMs === null ? "-" : new Date(baselineMs).toISOString()],
      ["Snapshot age", ageMs === null ? "-" : formatMs(ageMs)],
      ["Balance source", balance.label],
      ["Contracts", contracts.length],
    ]),
    "",
    renderBalanceSection(snapshot),
    "",
    "Run PnL since engine start",
    pnl.length > 0
      ? renderTable(["Mode", "Asset", "Contracts", "W/L/Flat", "PnL", "Return"], pnl)
      : "No executed contracts since run baseline.",
    "",
    "Latest Contracts",
    latest.length > 0
      ? renderTable(["Time", "Mode", "Asset", "PnL", "Return", "Triangle", "Route", "Dir", "Strategy", "Cycle"], latest)
      : "No executed contracts since run baseline.",
    details.length > 0 ? "" : null,
    ...details.map((row) => renderContract(row, options)),
  ].filter((line) => line !== null).join("\n");
}

module.exports = {
  contractKey,
  contractsSinceRun,
  engineRunBaselineMs,
  monitorColorEnabled,
  renderContractsMonitor,
  summarizeContracts,
};
