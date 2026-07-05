const fs = require("node:fs/promises");
const { readFilteredLogs, summarizeDryRun } = require("../live/logReadModel");

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (_error) {
    return false;
  }
}

function item(id, label, passed, details = {}) {
  return {
    id,
    label,
    passed,
    ...details,
  };
}

async function checkRealRunReadiness(options = {}) {
  const {
    runtimeConfig,
    engineSnapshot = {},
    restPermissions = null,
    logStore,
    dryRunReportPath,
    minimumDryRunSamples = 10,
  } = options;
  const config = runtimeConfig || {};
  const feedStatus = engineSnapshot.feedStatus || {};
  const stores = engineSnapshot.orderbookStores || {};
  const privateWsStatus = engineSnapshot.privateWsStatus || {};
  const dryRows = logStore ? await readFilteredLogs(logStore, { kind: "all", mode: "DRY_RUN", limit: 5000 }) : [];
  const drySummary = summarizeDryRun(dryRows);
  const dryRunReportExists = dryRunReportPath ? await fileExists(dryRunReportPath) : dryRows.length > 0;
  const rejectionRate = drySummary.totalOpportunities > 0 ? drySummary.rejected / drySummary.totalOpportunities : 1;
  const items = [
    item("api-key-present", "API key present", Boolean(process.env.UPBIT_ACCESS_KEY && process.env.UPBIT_SECRET_KEY)),
    item(
      "permissions",
      "API permissions verified or documented",
      restPermissions ? restPermissions.errors.length === 0 : false,
      { details: restPermissions || null },
    ),
    item("private-ws-connected", "Private MyOrder WS connected", privateWsStatus.status === "open"),
    item("order-chance-cache-fresh", "Order chance cache fresh", engineSnapshot.orderChanceFresh === true),
    item("account-balance-fresh", "Account balance fresh", engineSnapshot.accountBalanceFresh === true),
    item("observation-feed-healthy", "Observation feed healthy", (feedStatus.observation || {}).openConnectionCount > 0),
    item("validation-feed-healthy", "Validation feed healthy", (feedStatus.validation || {}).openConnectionCount > 0),
    item("validation-store-fresh", "Validation depth=30 store fresh", (stores.validation || {}).staleCount === 0),
    item("dry-run-report-exists", "Dry-run report exists", dryRunReportExists),
    item("dry-run-sample-count", "Dry-run minimum sample count met", drySummary.totalOpportunities >= minimumDryRunSamples, {
      observed: drySummary.totalOpportunities,
      required: minimumDryRunSamples,
    }),
    item("dry-run-rejection-profile", "Dry-run rejection profile acceptable", rejectionRate <= 0.8, {
      rejectionRate,
    }),
    item("live-trading-enabled", "liveTradingEnabled explicitly true", config.liveTradingEnabled === true),
    item("real-auto-disabled", "REAL_AUTO disabled unless config says otherwise", config.runMode !== "REAL_AUTO"),
  ];
  const passed = items.every((entry) => entry.passed);

  return {
    checkedAt: new Date().toISOString(),
    passed,
    items,
    dryRunSummary: drySummary,
  };
}

module.exports = {
  checkRealRunReadiness,
};
