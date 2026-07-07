const path = require("node:path");
const { renderBalanceSection } = require("./balances");
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

function dashboardColorEnabled(output = process.stdout) {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0") return true;
  return output && output.isTTY === true;
}

function formatMs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "-";
  return `${numeric.toFixed(0)}ms`;
}

function formatPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "-";
  return `${(numeric * 100).toFixed(1)}%`;
}

function formatWholePercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "-";
  return `${numeric.toFixed(0)}%`;
}

function yesNo(value) {
  return value === true ? "yes" : "no";
}

function runtimeConfig(snapshot = {}) {
  return snapshot.runtimeConfig || {};
}

function summary(snapshot = {}) {
  return snapshot.summary || {};
}

function engineState(snapshot = {}) {
  return snapshot.engineState || (snapshot.engine && snapshot.engine.state) || "UNKNOWN";
}

function timestampMs(value) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function snapshotAgeMs(snapshot = {}, nowMs = Date.now()) {
  const candidates = [
    summary(snapshot).lastUpdateTime,
    snapshot.lastCalculatedAt,
    snapshot.updatedAt,
    snapshot.serverStartedAt,
  ];

  for (const candidate of candidates) {
    const parsed = timestampMs(candidate);
    if (parsed !== null) return Math.max(0, nowMs - parsed);
  }

  return null;
}

function colorByEngineState(value, options = {}) {
  const state = String(value || "").toUpperCase();
  if (state === "RUNNING") return colorize(value, "green", options);
  if (state === "FAILED" || state === "ERROR") return colorize(value, "red", options);
  if (state === "STOPPED") return colorize(value, "dim", options);
  return colorize(value, "yellow", options);
}

function colorByMode(value, liveTradingEnabled, options = {}) {
  const mode = String(value || "").toUpperCase();
  if (liveTradingEnabled || mode.startsWith("REAL")) return colorize(value, "red", options);
  if (mode === "DRY_RUN") return colorize(value, "yellow", options);
  return colorize(value, "dim", options);
}

function colorByHealth(value, ok, options = {}) {
  return colorize(value, ok ? "green" : "red", options);
}

function formatFeedStatus(status, options = {}) {
  const normalized = String(status || "-").toLowerCase();
  if (["open", "connected", "running", "ready"].includes(normalized)) {
    return colorize(status, "green", options);
  }
  if (["closed", "failed", "error"].includes(normalized)) {
    return colorize(status, "red", options);
  }
  return colorize(status || "-", "yellow", options);
}

function readinessSummary(snapshot = {}, options = {}) {
  const readiness = snapshot.readiness || {};
  const score = readiness.score || {};
  const passed = readiness.passed === true || score.passed === true;
  const total = score.total || (Array.isArray(readiness.items) ? readiness.items.length : 0);
  const passedCount = score.passed || (Array.isArray(readiness.items)
    ? readiness.items.filter((item) => item.passed === true || item.ok === true).length
    : 0);

  if (!total) return "-";
  return colorByHealth(`${passedCount}/${total}`, passed, options);
}

function renderPreparationSection(snapshot = {}, options = {}) {
  const preparation = snapshot.preparation || {};
  if (!preparation.phase || preparation.phase === "idle") return null;
  const progress = preparation.progress || {};
  const blockers = Array.isArray(preparation.blockers) ? preparation.blockers : [];
  const phase = blockers.length > 0 && preparation.phase !== "ready"
    ? colorize(preparation.phase, "yellow", options)
    : colorize(preparation.phase, preparation.phase === "ready" ? "green" : "cyan", options);

  return [
    "Preparation",
    renderKeyValues([
      ["Phase", phase],
      ["Required markets", progress.requiredMarketCount ?? 0],
      [
        "REST warm-up",
        `${progress.restOrderbookFetched ?? 0}/${progress.restOrderbookRequested ?? 0} (${formatWholePercent(progress.restOrderbookPercent ?? 0)})`,
      ],
      [
        "Observation",
        [
          `${progress.observationMarketCount ?? 0} markets`,
          `${formatPercent(progress.observationCoverageRatio)} coverage`,
          `${progress.observationWsConfirmedCount ?? 0} WS-confirmed`,
          `${progress.observationRestOnlyCount ?? 0} REST-only`,
          `${progress.observationQuietCount ?? 0} quiet`,
        ].join(", "),
      ],
      [
        "Validation",
        [
          `${progress.validationMarketCount ?? 0} markets`,
          `${formatPercent(progress.validationCoverageRatio)} coverage`,
          `${progress.validationWsConfirmedCount ?? 0} WS-confirmed`,
          `${progress.validationRestOnlyCount ?? 0} REST-only`,
          `${progress.validationQuietCount ?? 0} quiet`,
        ].join(", "),
      ],
      ["WS open", `${progress.wsOpenConnections ?? 0}/${progress.wsConnectionCount ?? 0}`],
      ["Blockers", blockers.length > 0 ? colorize(blockers.join(", "), "yellow", options) : colorize("none", "green", options)],
    ]),
  ].join("\n");
}

function renderRateLimitSection(snapshot = {}, options = {}) {
  const rateLimit = snapshot.rateLimit || {};
  const groups = rateLimit.groups || {};
  const orderCapacity = snapshot.orderCapacity || rateLimit.orderCapacity || {};
  const interestingGroups = [
    "market",
    "orderbook",
    "exchange.default",
    "order",
    "websocket-connect",
  ].filter((group) => groups[group]);

  if (interestingGroups.length === 0 && !orderCapacity.limitPerSecond) return null;

  const rows = interestingGroups.map((groupName) => {
    const group = groups[groupName] || {};
    return [
      groupName,
      group.queued ?? 0,
      group.inFlight ?? 0,
      group.remainingSec ?? "-",
      group.cooldownMs ? formatMs(group.cooldownMs) : "-",
    ];
  });

  return [
    "Upbit queues",
    renderTable(["Group", "Queued", "In flight", "Remain", "Cooldown"], rows),
    "",
    renderKeyValues([
      ["Order slots", `${orderCapacity.available ?? "-"} available, ${orderCapacity.reserved ?? 0} reserved, ${orderCapacity.queued ?? 0} queued`],
      ["Recent throttles", Array.isArray(rateLimit.recentThrottles) ? rateLimit.recentThrottles.length : 0],
    ]),
  ].join("\n");
}

function renderEngineDashboard(snapshot = {}, options = {}) {
  const nowMs = options.nowMs || Date.now();
  const config = runtimeConfig(snapshot);
  const stateSummary = summary(snapshot);
  const execution = snapshot.execution || {};
  const processInfo = snapshot.engineProcess || {};
  const scheduler = stateSummary.cycleScheduler || snapshot.cycleScheduler || {};
  const guard = snapshot.guardStatus || {};
  const emergency = snapshot.emergencyStop || {};
  const privateWs = snapshot.privateWsStatus || {};
  const wsStatus = snapshot.wsStatus || {};
  const validationWsStatus = snapshot.validationWsStatus || (snapshot.feedStatus && snapshot.feedStatus.validation) || {};
  const preparationSection = renderPreparationSection(snapshot, options);
  const rateLimitSection = renderRateLimitSection(snapshot, options);
  const mode = config.runMode || execution.mode || "OBSERVE";
  const liveTradingEnabled = config.liveTradingEnabled === true || execution.liveTradingEnabled === true;
  const ageMs = snapshotAgeMs(snapshot, nowMs);
  const processPath = processInfo.snapshotPath || options.snapshotPath || path.join("out", "runtime", "latest-snapshot.json");
  const title = colorize("q-gagarin engine", "bold", options);
  const state = colorByEngineState(engineState(snapshot), options);
  const modeText = colorByMode(mode, liveTradingEnabled, options);
  const emergencyText = colorByHealth(yesNo(emergency.active === true), emergency.active !== true, options);
  const guardText = colorByHealth(yesNo(guard.healthy !== false), guard.healthy !== false, options);
  const warmup = scheduler.totalCycleCount
    ? `${scheduler.completedCycleCount || 0}/${scheduler.totalCycleCount}`
    : "-";

  return [
    `${title} ${colorize(new Date(nowMs).toISOString(), "dim", options)}`,
    "",
    renderKeyValues([
      ["Engine", state],
      ["Mode", modeText],
      ["Live trading", liveTradingEnabled ? colorize("yes", "red", options) : colorize("no", "dim", options)],
      ["Strategy", config.activeStrategyId || "-"],
      ["Exchange", config.exchange || "upbit"],
      ["PID", processInfo.pid || process.pid],
    ]),
    "",
    renderKeyValues([
      ["Markets loaded", stateSummary.marketsLoaded || 0],
      ["Triangles", stateSummary.uniqueTriangleCount || stateSummary.uniqueTriangles || 0],
      ["Plotted cycles", stateSummary.plottedCycleCount || 0],
      ["Available multipliers", stateSummary.availableLiveMultipliers || 0],
      ["Warm-up", warmup],
      ["Pending cycles", scheduler.pendingCycleCount ?? stateSummary.pendingCycleCount ?? 0],
    ]),
    "",
    renderTable(["Feed", "Status", "Open", "Unit"], [
      [
        "observation",
        formatFeedStatus(wsStatus.status || "unknown", options),
        wsStatus.openConnectionCount ?? "-",
        config.observationOrderbookUnit || 5,
      ],
      [
        "validation",
        formatFeedStatus(validationWsStatus.status || "unknown", options),
        validationWsStatus.openConnectionCount ?? "-",
        config.validationOrderbookUnit || 30,
      ],
      [
        "private",
        formatFeedStatus(privateWs.status || "not_configured", options),
        privateWs.openConnectionCount ?? "-",
        "-",
      ],
    ]),
    "",
    renderKeyValues([
      ["Readiness", readinessSummary(snapshot, options)],
      ["Guard healthy", guardText],
      ["Emergency stop", emergencyText],
      ["Open orders", guard.openOrderCount ?? execution.openOrderCount ?? 0],
      ["Active real executions", guard.activeRealExecutionCount ?? execution.activeRealExecutionCount ?? 0],
      ["Snapshot age", ageMs === null ? "-" : formatMs(ageMs)],
      ["Last update", stateSummary.lastUpdateTime || snapshot.lastCalculatedAt || "-"],
    ]),
    "",
    renderBalanceSection(snapshot),
    ...(preparationSection ? ["", preparationSection] : []),
    ...(rateLimitSection ? ["", rateLimitSection] : []),
    "",
    colorize(`Snapshot: ${processPath}`, "dim", options),
    colorize("Press Ctrl+C to stop.", "dim", options),
  ].join("\n");
}

module.exports = {
  dashboardColorEnabled,
  renderEngineDashboard,
};
