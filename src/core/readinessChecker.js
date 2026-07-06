const fs = require("node:fs/promises");
const { summarizeDryRun } = require("../ops/dryRunReport");
const { readFilteredLogs } = require("../live/logReadModel");

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

function readinessScore(items = []) {
  const total = items.length;
  const passed = items.filter((entry) => entry.passed).length;
  const failed = total - passed;

  return {
    passed,
    failed,
    total,
    rate: total > 0 ? passed / total : 0,
  };
}

function enabledStartAssets(config = {}, drySummary = {}) {
  const configured = Array.isArray(config.enabledStartAssets) && config.enabledStartAssets.length > 0
    ? config.enabledStartAssets
    : Object.keys(drySummary.byStartAsset || {});

  return configured.length > 0 ? configured : ["KRW", "BTC", "USDT"];
}

function dryRunAuditEvidence(rows = []) {
  const invalidRows = rows.filter((row) => !row.auditSchema || row.auditSchema.ok !== true);

  return {
    totalRows: rows.length,
    validRows: rows.filter((row) => row.auditSchema && row.auditSchema.ok === true),
    invalidCount: invalidRows.length,
    invalidExamples: invalidRows.slice(0, 10).map((row) => ({
      type: row.type,
      logKind: row.logKind,
      timestamp: row.timestamp || row.ts || null,
      cycleId: row.cycleId || null,
      startAsset: row.startAsset || null,
      missingRequiredFields: row.auditSchema && row.auditSchema.missingRequiredFields || ["auditSchema"],
    })),
  };
}

function perStartAssetReadinessItems({
  startAssets,
  dryRows,
  minimumDryRunSamplesPerStartAsset,
  minimumDryRunCompleteRate,
  maxDryRunDepthRejectionRate,
  maxDryRunLatencyRejectionRate,
  maxDryRunExpectedSimulatedGapRate,
}) {
  const summaries = {};
  const items = [];

  for (const asset of startAssets) {
    const assetSummary = summarizeDryRun(dryRows.filter((row) => row.startAsset === asset));
    summaries[asset] = assetSummary;

    items.push(item(
      `dry-run-start-asset-sample-count-${asset}`,
      `Dry-run ${asset} sample count met`,
      assetSummary.totalOpportunities >= minimumDryRunSamplesPerStartAsset,
      {
        startAsset: asset,
        observed: assetSummary.totalOpportunities,
        required: minimumDryRunSamplesPerStartAsset,
      },
    ));

    items.push(item(
      `dry-run-start-asset-attempts-${asset}`,
      `Dry-run ${asset} simulated attempts exist`,
      assetSummary.simulatedAttemptCycles > 0,
      {
        startAsset: asset,
        simulatedAttemptCycles: assetSummary.simulatedAttemptCycles,
      },
    ));

    items.push(item(
      `dry-run-start-asset-complete-rate-${asset}`,
      `Dry-run ${asset} simulated complete rate acceptable`,
      assetSummary.simulatedAttemptCycles > 0 &&
        assetSummary.simulatedCompleteRate >= minimumDryRunCompleteRate,
      {
        startAsset: asset,
        observed: assetSummary.simulatedCompleteRate,
        required: minimumDryRunCompleteRate,
        simulatedCompleteCycles: assetSummary.simulatedCompleteCycles,
        simulatedAttemptCycles: assetSummary.simulatedAttemptCycles,
      },
    ));

    items.push(item(
      `dry-run-start-asset-depth-rejection-rate-${asset}`,
      `Dry-run ${asset} depth rejection rate acceptable`,
      assetSummary.depthRejectionRate <= maxDryRunDepthRejectionRate,
      {
        startAsset: asset,
        observed: assetSummary.depthRejectionRate,
        maxAllowed: maxDryRunDepthRejectionRate,
      },
    ));

    items.push(item(
      `dry-run-start-asset-latency-rejection-rate-${asset}`,
      `Dry-run ${asset} latency rejection rate acceptable`,
      assetSummary.latencyRejectionRate <= maxDryRunLatencyRejectionRate,
      {
        startAsset: asset,
        observed: assetSummary.latencyRejectionRate,
        maxAllowed: maxDryRunLatencyRejectionRate,
      },
    ));

    items.push(item(
      `dry-run-start-asset-expected-simulated-gap-${asset}`,
      `Dry-run ${asset} expected vs simulated gap acceptable`,
      Number.isFinite(Number(assetSummary.expectedSimulatedGapRate)) &&
        Number(assetSummary.expectedSimulatedGapRate) <= maxDryRunExpectedSimulatedGapRate,
      {
        startAsset: asset,
        observed: assetSummary.expectedSimulatedGapRate,
        maxAllowed: maxDryRunExpectedSimulatedGapRate,
        expectedNetProfit: assetSummary.expectedNetProfit,
        simulatedNetProfit: assetSummary.simulatedNetProfit,
      },
    ));
  }

  return { items, summaries };
}

async function checkRealRunReadiness(options = {}) {
  const {
    runtimeConfig,
    engineSnapshot = {},
    restPermissions = null,
    logStore,
    dryRunReportPath,
    minimumDryRunSamples = 10,
    minimumDryRunSamplesPerStartAsset = 1,
    maxDryRunRejectionRate = 0.8,
    minimumDryRunCompleteRate = 0.5,
    maxDryRunDepthRejectionRate = 0.8,
    maxDryRunLatencyRejectionRate = 0.2,
    maxDryRunExpectedSimulatedGapRate = 1,
  } = options;
  const config = runtimeConfig || {};
  const feedStatus = engineSnapshot.feedStatus || {};
  const stores = engineSnapshot.orderbookStores || {};
  const privateWsStatus = engineSnapshot.privateWsStatus || {};
  const dryRows = logStore ? await readFilteredLogs(logStore, { kind: "all", mode: "DRY_RUN", limit: 5000 }) : [];
  const dryRunAudit = dryRunAuditEvidence(dryRows);
  const drySummary = summarizeDryRun(dryRunAudit.validRows);
  const dryRunReportExists = dryRunReportPath ? await fileExists(dryRunReportPath) : dryRows.length > 0;
  const rejectionRate = drySummary.totalOpportunities > 0 ? drySummary.rejected / drySummary.totalOpportunities : 1;
  const startAssets = enabledStartAssets(config, drySummary);
  const startAssetReadiness = perStartAssetReadinessItems({
    startAssets,
    dryRows: dryRunAudit.validRows,
    minimumDryRunSamplesPerStartAsset,
    minimumDryRunCompleteRate,
    maxDryRunDepthRejectionRate,
    maxDryRunLatencyRejectionRate,
    maxDryRunExpectedSimulatedGapRate,
  });
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
    item("dry-run-audit-schema-complete", "Dry-run audit evidence schema complete", dryRunAudit.invalidCount === 0, {
      totalRows: dryRunAudit.totalRows,
      invalidCount: dryRunAudit.invalidCount,
      invalidExamples: dryRunAudit.invalidExamples,
    }),
    item("dry-run-sample-count", "Dry-run minimum sample count met", drySummary.totalOpportunities >= minimumDryRunSamples, {
      observed: drySummary.totalOpportunities,
      required: minimumDryRunSamples,
    }),
    item("dry-run-rejection-profile", "Dry-run rejection profile acceptable", rejectionRate <= maxDryRunRejectionRate, {
      rejectionRate,
      maxAllowed: maxDryRunRejectionRate,
    }),
    item(
      "dry-run-complete-rate",
      "Dry-run simulated complete rate acceptable",
      drySummary.simulatedCompleteRate >= minimumDryRunCompleteRate,
      {
        observed: drySummary.simulatedCompleteRate,
        required: minimumDryRunCompleteRate,
        simulatedCompleteCycles: drySummary.simulatedCompleteCycles,
        simulatedAttemptCycles: drySummary.simulatedAttemptCycles,
      },
    ),
    item(
      "dry-run-depth-rejection-rate",
      "Dry-run depth rejection rate acceptable",
      drySummary.depthRejectionRate <= maxDryRunDepthRejectionRate,
      {
        observed: drySummary.depthRejectionRate,
        maxAllowed: maxDryRunDepthRejectionRate,
      },
    ),
    item(
      "dry-run-latency-rejection-rate",
      "Dry-run latency rejection rate acceptable",
      drySummary.latencyRejectionRate <= maxDryRunLatencyRejectionRate,
      {
        observed: drySummary.latencyRejectionRate,
        maxAllowed: maxDryRunLatencyRejectionRate,
      },
    ),
    item(
      "dry-run-expected-simulated-gap",
      "Dry-run expected vs simulated gap acceptable",
      Number.isFinite(Number(drySummary.expectedSimulatedGapRate)) &&
        Number(drySummary.expectedSimulatedGapRate) <= maxDryRunExpectedSimulatedGapRate,
      {
        observed: drySummary.expectedSimulatedGapRate,
        maxAllowed: maxDryRunExpectedSimulatedGapRate,
        expectedNetProfit: drySummary.expectedNetProfit,
        simulatedNetProfit: drySummary.simulatedNetProfit,
      },
    ),
    ...startAssetReadiness.items,
    item("live-trading-enabled", "liveTradingEnabled explicitly true", config.liveTradingEnabled === true),
    item("real-auto-disabled", "REAL_AUTO disabled unless config says otherwise", config.runMode !== "REAL_AUTO"),
  ];
  const passed = items.every((entry) => entry.passed);
  const score = readinessScore(items);

  return {
    checkedAt: new Date().toISOString(),
    passed,
    score,
    items,
    dryRunAudit,
    dryRunSummary: drySummary,
    dryRunStartAssetSummaries: startAssetReadiness.summaries,
  };
}

module.exports = {
  checkRealRunReadiness,
  dryRunAuditEvidence,
};
