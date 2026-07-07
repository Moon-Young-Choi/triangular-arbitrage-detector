const { renderTable } = require("./table");

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatNumber(value, digits = 8) {
  const numeric = numberOrNull(value);
  if (numeric === null) return "-";
  if (digits <= 2) return numeric.toFixed(digits);
  if (Math.abs(numeric) >= 1000) return numeric.toFixed(2);
  return numeric.toFixed(digits).replace(/\.?0+$/u, "");
}

function runtimeConfig(snapshot = {}) {
  return snapshot.runtimeConfig || {};
}

function availableDryBalances(execution = {}) {
  const direct = execution.dryRunBalances || {};
  if (Object.keys(direct).length > 0) return direct;

  const buckets = execution.dryRunCapital && execution.dryRunCapital.buckets || {};
  return Object.fromEntries(
    Object.entries(buckets).map(([asset, bucket]) => [asset, bucket.availableBalance]),
  );
}

function availableRealBalances(execution = {}) {
  const real = execution.realBalances || {};
  if (real.availableBalances && Object.keys(real.availableBalances).length > 0) {
    return real.availableBalances;
  }
  if (real.available && Object.keys(real.available).length > 0) {
    return real.available;
  }
  return {};
}

function balanceView(snapshot = {}) {
  const execution = snapshot.execution || {};
  const mode = runtimeConfig(snapshot).runMode || execution.mode || "OBSERVE";

  if (String(mode).startsWith("REAL")) {
    const balances = availableRealBalances(execution);
    const rows = balanceRowsFromObject(balances);
    return {
      label: "Real Upbit available",
      mode,
      rows,
      unavailable: rows.length === 0,
      message: "Real Upbit balance unavailable.",
    };
  }

  const balances = availableDryBalances(execution);
  return {
    label: mode === "DRY_RUN" ? "Dry-run simulated available" : "Configured simulated available",
    mode,
    rows: balanceRowsFromObject(balances),
    unavailable: false,
    message: "No simulated balance snapshot.",
  };
}

function balanceRowsFromObject(balances = {}) {
  return Object.entries(balances)
    .filter(([, value]) => numberOrNull(value) !== null)
    .map(([asset, value]) => [asset, formatNumber(value, asset === "KRW" ? 2 : 8)])
    .slice(0, 12);
}

function renderBalanceSection(snapshot = {}) {
  const view = balanceView(snapshot);
  if (view.rows.length === 0) {
    return [view.label, view.message].join("\n");
  }

  return [
    view.label,
    renderTable(["Asset", "Available"], view.rows),
  ].join("\n");
}

module.exports = {
  balanceView,
  formatNumber,
  renderBalanceSection,
};
