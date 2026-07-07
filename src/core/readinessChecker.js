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

async function checkRealRunReadiness(options = {}) {
  const {
    runtimeConfig,
    engineSnapshot = {},
    restPermissions = null,
  } = options;
  const config = runtimeConfig || {};
  const feedStatus = engineSnapshot.feedStatus || {};
  const stores = engineSnapshot.orderbookStores || {};
  const privateWsStatus = engineSnapshot.privateWsStatus || {};
  const validationStore = stores.validation || {};
  const validationStoreUsable = Object.hasOwn(validationStore, "wsConfirmedCount")
    ? Number(validationStore.wsConfirmedCount || 0) > 0
    : validationStore.staleCount === 0;
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
    item("validation-store-usable", "Validation depth=30 store usable", validationStoreUsable, {
      wsConfirmedCount: validationStore.wsConfirmedCount ?? null,
      staleCount: validationStore.staleCount ?? null,
      restOnlyCount: validationStore.restOnlyCount ?? null,
      quietCount: validationStore.quietCount ?? null,
    }),
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
  };
}

module.exports = {
  checkRealRunReadiness,
  dryRunAuditEvidence,
};
