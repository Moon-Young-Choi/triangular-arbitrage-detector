const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const publicDir = path.resolve(__dirname, "..", "public");
const dashboardJs = fs.readFileSync(path.join(publicDir, "live-dashboard.js"), "utf8");
const dashboardHtml = fs.readFileSync(path.join(publicDir, "live-dashboard.html"), "utf8");
const dashboardCss = fs.readFileSync(path.join(publicDir, "live-dashboard.css"), "utf8");
const tabFiles = [
  ["market.js", "market", "Market"],
  ["strategy.js", "strategy", "Strategy"],
  ["arbitrageDesk.js", "arbitrage", "Arbitrage Desk"],
  ["execution.js", "execution", "Execution"],
  ["system.js", "system", "System"],
  ["logs.js", "logs", "Logs"],
  ["settings.js", "settings", "Settings"],
];

test("dashboard exposes the required operational tabs", () => {
  const tabs = [
    ["market", "Market"],
    ["strategy", "Strategy"],
    ["arbitrage", "Arbitrage Desk"],
    ["execution", "Execution"],
    ["system", "System"],
    ["logs", "Logs"],
    ["settings", "Settings"],
  ];

  for (const [target, label] of tabs) {
    assert.match(
      dashboardHtml,
      new RegExp(`<button[^>]+data-tab-target="${target}"[^>]*>${label}<\\/button>`),
    );
    assert.match(
      dashboardHtml,
      new RegExp(`<section[^>]+data-tab-panel="${target}"`),
    );
  }
});

test("dashboard loads tab modules before the main dashboard runtime", () => {
  const mainScriptIndex = dashboardHtml.indexOf('<script src="/live-dashboard.js"></script>');

  assert.notEqual(mainScriptIndex, -1);

  for (const [fileName, id, label] of tabFiles) {
    const script = `<script src="/tabs/${fileName}"></script>`;
    const scriptIndex = dashboardHtml.indexOf(script);
    const tabSource = fs.readFileSync(path.join(publicDir, "tabs", fileName), "utf8");

    assert.notEqual(scriptIndex, -1);
    assert.equal(scriptIndex < mainScriptIndex, true);
    assert.match(tabSource, /window\.QGagarinDashboardTabs/);
    assert.match(tabSource, new RegExp(`id:\\s*"${id}"`));
    assert.match(tabSource, new RegExp(`label:\\s*"${label}"`));
  }

  assert.match(dashboardJs, /window\.QGagarinDashboardTabs/);
  assert.match(dashboardJs, /function validateTabRegistry\(\)/);
  assert.match(dashboardJs, /const tabIds = new Set\(tabDefinitions\.map/);
});

test("arbitrage chart disables hover details and uses click-only route detail", () => {
  assert.doesNotMatch(dashboardJs, /plotly_hover/);
  assert.doesNotMatch(dashboardHtml, /Hover or click/);
  assert.doesNotMatch(dashboardJs, /Hover or click/);

  assert.match(dashboardJs, /hoverinfo:\s*"none"/);
  assert.match(dashboardJs, /hovertemplate:\s*null/);
  assert.match(dashboardJs, /hovermode:\s*false/);

  assert.match(dashboardHtml, /<div id="detailBody" class="detail-body">Click a point\.<\/div>/);
  assert.match(dashboardJs, /chart\.on\("plotly_click",\s*\(event\)\s*=>\s*\{/);
  assert.match(dashboardJs, /setDetail\(chartRows\[event\.points\[0\]\.pointIndex\]\)/);
});

test("profitable points are pink regardless of cycle direction", () => {
  assert.match(dashboardJs, /profit:\s*"#d83f7b"/);
  assert.match(dashboardCss, /--pink:\s*#d83f7b;/);
  assert.match(dashboardHtml, /<i class="legend-dot pink"><\/i>Profitable/);
  assert.match(dashboardHtml, /<i class="legend-dot pink diamond"><\/i>Reverse direction/);
  assert.match(
    dashboardJs,
    /if \(row\.statusClass === "canonical-profit" \|\| row\.statusClass === "reverse-profit"\) return COLORS\.profit;/,
  );
});

test("dashboard commands stay limited to Start Pause Stop command API", () => {
  const commandNames = new Set([...dashboardJs.matchAll(/sendEngineCommand\("([^"]+)"/g)].map((match) => match[1]));

  assert.deepEqual(commandNames, new Set(["Start", "Pause", "Stop"]));
  assert.match(dashboardJs, /fetch\(`\/api\/command\/\$\{encodeURIComponent\(command\.toLowerCase\(\)\)\}`/);
  assert.doesNotMatch(dashboardJs, /\/api\/settings/);
  assert.doesNotMatch(dashboardJs, /\/api\/strategy/);
  assert.doesNotMatch(dashboardJs, /\/api\/capture/);
  assert.doesNotMatch(dashboardJs, /Plotly\.toImage/);
  assert.doesNotMatch(dashboardHtml, /emergencyStopButton/);
  assert.doesNotMatch(dashboardHtml, />\s*Emergency Stop\s*</);
  assert.doesNotMatch(dashboardJs, /emergencyStopButton/);
  assert.doesNotMatch(dashboardJs, /emergency:\s*true/);
  assert.doesNotMatch(dashboardHtml, />\s*Resync\s*</);
  assert.doesNotMatch(dashboardHtml, />\s*Capture\s*</);
});

test("dashboard uses read-only engine telemetry for fee and stale thresholds", () => {
  assert.doesNotMatch(dashboardHtml, /id="feeInput"/);
  assert.doesNotMatch(dashboardHtml, /id="staleInput"/);
  assert.doesNotMatch(dashboardJs, /feeInput/);
  assert.doesNotMatch(dashboardJs, /staleInput/);

  assert.match(dashboardHtml, /<h2>Market Read Model<\/h2>/);
  assert.match(dashboardJs, /function readModelFeeRate\(\)/);
  assert.match(dashboardJs, /function readModelStaleThresholdMs\(\)/);
  assert.match(dashboardJs, /return parseNumber\(stateSummary\(\)\.feeRate, 0\)/);
  assert.match(dashboardJs, /return parseNumber\(stateSummary\(\)\.staleOrderbookMs, 3000\)/);
});

test("settings dashboard exposes real-run readiness score and start-asset evidence", () => {
  assert.match(dashboardJs, /function formatConfigValue\(value\)/);
  assert.match(dashboardJs, /const score = readiness && readiness\.score/);
  assert.match(dashboardJs, /statusRow\("Readiness score", scoreText/);
  assert.match(dashboardJs, /statusRow\("Failed checks", score \? score\.failed : "n\/a"/);
  assert.match(dashboardJs, /readiness\.dryRunStartAssetSummaries \|\| \{\}/);
  assert.match(dashboardJs, /Readiness by start asset/);
  assert.match(dashboardJs, /<th>Start<\/th><th>Gate<\/th><th>Opportunities<\/th><th>Attempts<\/th><th>Complete rate<\/th><th>Depth reject<\/th><th>Latency reject<\/th><th>Expected gap<\/th>/);
});

test("execution dashboard exposes locked balances and residual asset ledger", () => {
  assert.match(dashboardJs, /function formatAssetAmounts\(amounts, options = \{\}\)/);
  assert.match(dashboardJs, /latestState\.execution\.realBalances\.lockedBalances/);
  assert.match(dashboardJs, /latestState\.execution\.realBalances\.residualBalances/);
  assert.match(dashboardJs, /latestState\.realRunLimits\.summaryByStartAsset/);
  assert.match(dashboardJs, /statusRow\("Locked balances", formatAssetAmounts\(realLockedBalances\)\)/);
  assert.match(dashboardJs, /statusRow\("Residual assets", formatAssetAmounts\(residualBalances, \{ positiveOnly: true \}\)\)/);
  assert.match(dashboardJs, /Real-run by start asset/);
  assert.match(dashboardJs, /<th>Start<\/th><th>Cycles<\/th><th>PnL<\/th><th>Daily loss<\/th><th>Realized loss<\/th><th>Paid fee<\/th><th>Trade fee<\/th><th>Last cycle<\/th>/);
  assert.match(dashboardJs, /execution\.realBalances\.residualEvents/);
  assert.match(dashboardJs, /Residual position ledger/);
  assert.match(dashboardJs, /<th>Time<\/th><th>Asset<\/th><th>Amount<\/th><th>Balance<\/th><th>Reason<\/th><th>Cycle\/Plan<\/th>/);
  assert.match(dashboardHtml, /<option value="position">position<\/option>/);
});

test("logs dashboard exposes dry-run performance by start asset", () => {
  assert.match(dashboardHtml, /<div id="dryRunStartAssetTable" class="log-table"><\/div>/);
  assert.match(dashboardJs, /const dryRunStartAssetTable = document\.getElementById\("dryRunStartAssetTable"\)/);
  assert.match(dashboardJs, /summary\.byStartAsset \|\| \{\}/);
  assert.match(dashboardJs, /summary\.byMarketState \|\| \{\}/);
  assert.match(dashboardJs, /summary\.byLatencyBand \|\| \{\}/);
  assert.match(dashboardJs, /summary\.byBestLevelTouchRatio \|\| \{\}/);
  assert.match(dashboardJs, /Review period/);
  assert.match(dashboardJs, /Best touch p95/);
  assert.match(dashboardJs, /Dry-run by start asset/);
  assert.match(dashboardJs, /Dry-run by market state/);
  assert.match(dashboardJs, /Dry-run by latency/);
  assert.match(dashboardJs, /Dry-run by best-level touch/);
  assert.match(dashboardJs, /dryRunGroupTable\("Dry-run by start asset", "Start"/);
  assert.match(dashboardJs, /dryRunGroupTable\("Dry-run by market state", "State"/);
  assert.match(dashboardJs, /dryRunGroupTable\("Dry-run by latency", "Latency"/);
  assert.match(dashboardJs, /dryRunGroupTable\("Dry-run by best-level touch", "Best touch"/);
});
