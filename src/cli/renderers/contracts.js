const { renderKeyValues, renderTable } = require("./table");

const ANSI = Object.freeze({
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  dim: "\x1b[2m",
});

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function field(row = {}, key) {
  if (row[key] !== undefined && row[key] !== null) return row[key];
  if (row.payload && row.payload[key] !== undefined && row.payload[key] !== null) {
    return row.payload[key];
  }
  return null;
}

function colorize(text, color, options = {}) {
  if (!options.color) return text;
  return `${ANSI[color] || ""}${text}${ANSI.reset}`;
}

function colorBySign(text, value, options = {}) {
  const numeric = numberOrNull(value);
  if (numeric === null || numeric === 0) return colorize(text, "dim", options);
  return colorize(text, numeric > 0 ? "green" : "red", options);
}

function formatNumber(value, digits = 8) {
  const numeric = numberOrNull(value);
  if (numeric === null) return "-";
  if (Math.abs(numeric) >= 1000) return numeric.toFixed(2);
  return numeric.toFixed(digits).replace(/\.?0+$/u, "");
}

function formatSignedNumber(value, digits = 8, options = {}) {
  const numeric = numberOrNull(value);
  if (numeric === null) return "-";
  const sign = numeric > 0 ? "+" : "";
  return colorBySign(`${sign}${formatNumber(numeric, digits)}`, numeric, options);
}

function formatPercent(value, options = {}) {
  const numeric = numberOrNull(value);
  if (numeric === null) return "-";
  const text = `${numeric > 0 ? "+" : ""}${(numeric * 100).toFixed(4)}%`;
  return colorBySign(text, numeric, options);
}

function formatAssetAmount(value, asset = "", options = {}) {
  if (numberOrNull(value) === null) return "-";
  const amount = formatNumber(value, asset === "KRW" ? 2 : 8);
  return asset ? `${amount} ${asset}` : amount;
}

function formatSignedAssetAmount(value, asset = "", options = {}) {
  if (numberOrNull(value) === null) return "-";
  const amount = formatSignedNumber(value, asset === "KRW" ? 2 : 8, options);
  return asset ? `${amount} ${asset}` : amount;
}

function routeFromLegs(legs = []) {
  if (!Array.isArray(legs) || legs.length === 0) return null;
  const first = legs[0] && (legs[0].fromAsset || legs[0].from);
  if (!first) return null;
  const route = [first];

  for (const leg of legs) {
    const next = leg && (leg.toAsset || leg.to);
    if (next) route.push(next);
  }

  return route;
}

function contractLegs(row = {}) {
  const legs = field(row, "legResults") || field(row, "legs") || [];
  return Array.isArray(legs) ? legs : [];
}

function contractRoute(row = {}) {
  const route = field(row, "route");
  if (Array.isArray(route) && route.length > 0) return route;
  const fromLegs = routeFromLegs(contractLegs(row));
  if (fromLegs) return fromLegs;
  return null;
}

function formatRoute(row = {}) {
  const route = contractRoute(row);
  if (route) return route.join(" -> ");
  return field(row, "routeLabel") || field(row, "routeVariantId") || field(row, "cycleId") || "-";
}

function triangleId(row = {}) {
  const explicit = field(row, "triangleId");
  if (explicit) return explicit;
  const cycleId = String(field(row, "cycleId") || "");
  return cycleId.includes(":") ? cycleId.split(":")[0] : cycleId || "-";
}

function directionLabel(row = {}) {
  const explicit = field(row, "directionLabel");
  if (explicit) return explicit;
  const direction = String(field(row, "direction") || "").toLowerCase();
  if (direction === "canonical") return "정방향";
  if (direction === "reverse") return "역방향";
  const cycleId = String(field(row, "cycleId") || "");
  const parsed = cycleId.split(":")[1];
  if (parsed === "canonical") return "정방향";
  if (parsed === "reverse") return "역방향";
  return direction || "-";
}

function bucketTotal(bucket = {}) {
  if (!bucket || typeof bucket !== "object") return null;
  return [
    bucket.availableBalance,
    bucket.reservedBalance,
    bucket.lockedBalance,
    bucket.residualBalance,
  ].reduce((sum, value) => {
    const numeric = numberOrNull(value);
    return numeric === null ? sum : sum + numeric;
  }, 0);
}

function capitalTrend(row = {}, startAsset = "", options = {}) {
  const before = field(row, "capitalBefore");
  const after = field(row, "capitalAfter") || field(row, "capital");
  const beforeTotal = bucketTotal(before);
  const afterTotal = bucketTotal(after);

  if (beforeTotal === null || afterTotal === null) return "-";

  const change = afterTotal - beforeTotal;
  const availableBefore = numberOrNull(before.availableBalance);
  const availableAfter = numberOrNull(after.availableBalance);
  const available = availableBefore !== null && availableAfter !== null
    ? `, available ${formatAssetAmount(availableBefore, startAsset)} -> ${formatAssetAmount(availableAfter, startAsset)}`
    : "";

  return [
    `${formatAssetAmount(beforeTotal, startAsset)} -> ${formatAssetAmount(afterTotal, startAsset)}`,
    `(${formatSignedAssetAmount(change, startAsset, options)})${available}`,
  ].join(" ");
}

function priceForLeg(leg = {}) {
  return numberOrNull(
    leg.avgPrice ??
    leg.averagePrice ??
    leg.submittedPrice ??
    leg.observedBestPrice ??
    leg.bestPrice ??
    leg.price,
  );
}

function formatFeeRate(value) {
  const feeRate = numberOrNull(value);
  return feeRate === null ? null : `${(feeRate * 100).toFixed(4)}%`;
}

function feeForLeg(leg = {}) {
  const feeAsset = leg.feeAsset || leg.expectedFeeAsset || "";
  const feeRate = formatFeeRate(leg.feeRate);
  const feeAmount = numberOrNull(leg.feeAmount);
  const paidFee = numberOrNull(leg.paidFee);
  const tradeFee = numberOrNull(leg.tradeFee);

  if (feeAmount !== null) {
    const text = formatAssetAmount(feeAmount, feeAsset);
    return feeRate ? `${text} (${feeRate})` : text;
  }

  if (paidFee !== null && tradeFee !== null && paidFee !== tradeFee) {
    const paid = formatAssetAmount(paidFee, feeAsset);
    const trade = formatAssetAmount(tradeFee, feeAsset);
    return feeRate ? `${paid} / ${trade} (${feeRate})` : `${paid} / ${trade}`;
  }
  if (paidFee !== null) {
    const text = formatAssetAmount(paidFee, feeAsset);
    return feeRate ? `${text} (${feeRate})` : text;
  }
  if (tradeFee !== null) {
    const text = formatAssetAmount(tradeFee, feeAsset);
    return feeRate ? `${text} (${feeRate})` : text;
  }
  return feeRate || "-";
}

function legRows(legs = [], options = {}) {
  return legs.map((leg, index) => {
    const inputAsset = leg.fromAsset || leg.from || "";
    const outputAsset = leg.toAsset || leg.to || "";

    return [
      leg.legIndex || index + 1,
      leg.market || leg.marketCode || "-",
      inputAsset && outputAsset ? `${inputAsset}->${outputAsset}` : "-",
      leg.side || leg.feeSide || leg.usedSide || "-",
      formatAssetAmount(leg.inputAmount, inputAsset),
      formatNumber(priceForLeg(leg)),
      formatAssetAmount(leg.outputAmount, outputAsset),
      feeForLeg(leg),
      leg.expectedSlippageBps === undefined || leg.expectedSlippageBps === null
        ? "-"
        : `${formatNumber(leg.expectedSlippageBps, 4)}bps`,
      leg.bestLevelTouchRatio === undefined || leg.bestLevelTouchRatio === null
        ? "-"
        : `${(Number(leg.bestLevelTouchRatio) * 100).toFixed(2)}%`,
    ];
  });
}

function normalizedContract(row = {}) {
  const startAsset = field(row, "startAsset") || "";
  const startAmount = numberOrNull(field(row, "startAmount"));
  const outputAmount = numberOrNull(field(row, "outputAmount"));
  const explicitPnl = numberOrNull(field(row, "pnl") ?? field(row, "simulatedNetProfit"));
  const pnl = explicitPnl !== null
    ? explicitPnl
    : startAmount !== null && outputAmount !== null
      ? outputAmount - startAmount
      : null;
  const explicitProfitRate = numberOrNull(field(row, "profitRate"));
  const profitRate = explicitProfitRate !== null
    ? explicitProfitRate
    : startAmount !== null && startAmount !== 0 && pnl !== null
      ? pnl / startAmount
      : null;

  return {
    timestamp: field(row, "timestamp") || field(row, "ts") || "-",
    mode: field(row, "mode") || "-",
    planId: field(row, "planId") || "-",
    cycleId: field(row, "cycleId") || "-",
    routeVariantId: field(row, "routeVariantId") || "-",
    strategyId: field(row, "strategyId") || "-",
    startAsset,
    startAmount,
    outputAmount,
    pnl,
    profitRate,
    expectedNetProfit: numberOrNull(field(row, "expectedNetProfit")),
    expectedSimulatedGap: numberOrNull(field(row, "expectedSimulatedGap")),
    feeSummary: field(row, "feeSummary"),
    legs: contractLegs(row),
  };
}

function formatFeeSummary(feeSummary = {}) {
  if (feeSummary && feeSummary.totalByAsset && typeof feeSummary.totalByAsset === "object") {
    const entries = Object.entries(feeSummary.totalByAsset)
      .filter(([, value]) => numberOrNull(value) !== null)
      .map(([asset, value]) => formatAssetAmount(value, asset));

    if (entries.length > 0) return entries.join(", ");
  }

  if (feeSummary.totalPaidFee !== undefined || feeSummary.totalTradeFee !== undefined) {
    return `paid ${formatNumber(feeSummary.totalPaidFee)} / trade ${formatNumber(feeSummary.totalTradeFee)}`;
  }

  return "-";
}

function renderContract(row = {}, options = {}) {
  const contract = normalizedContract(row);
  const pnlText = formatSignedAssetAmount(contract.pnl, contract.startAsset, options);
  const profitRateText = formatPercent(contract.profitRate, options);
  const assetTrend = contract.startAmount !== null && contract.outputAmount !== null
    ? [
        `${formatAssetAmount(contract.startAmount, contract.startAsset)} -> ${formatAssetAmount(contract.outputAmount, contract.startAsset)}`,
        `(${pnlText}, ${profitRateText})`,
      ].join(" ")
    : "-";
  const feeSummary = contract.feeSummary || {};
  const fees = formatFeeSummary(feeSummary);
  const rows = legRows(contract.legs, options);

  return [
    `${contract.mode} Contract ${contract.timestamp}`,
    renderKeyValues([
      ["Triangle", triangleId(row)],
      ["Route", formatRoute(row)],
      ["Direction", directionLabel(row)],
      ["Contract size", formatAssetAmount(contract.startAmount, contract.startAsset)],
      ["Asset trend", assetTrend],
      ["Capital trend", capitalTrend(row, contract.startAsset, options)],
      ["Expected profit", formatSignedAssetAmount(contract.expectedNetProfit, contract.startAsset, options)],
      ["Expected gap", formatSignedAssetAmount(contract.expectedSimulatedGap, contract.startAsset, options)],
      ["Fees", fees],
      ["Strategy", contract.strategyId],
      ["Cycle", contract.cycleId],
    ]),
    rows.length > 0
      ? renderTable(["#", "Market", "Route", "Side", "Input", "Avg price", "Output", "Fee", "Slip", "Touch"], rows)
      : "No leg detail.",
  ].join("\n");
}

function isContractEvent(row = {}) {
  return field(row, "type") === "cycle.done";
}

function renderContracts(rows = [], options = {}) {
  const contracts = rows.filter(isContractEvent);

  if (contracts.length === 0) {
    return "No executed contracts matched.";
  }

  return [
    "Contracts",
    ...contracts.map((row) => renderContract(row, options)),
  ].join("\n\n");
}

module.exports = {
  directionLabel,
  isContractEvent,
  normalizedContract,
  renderContract,
  renderContracts,
};
