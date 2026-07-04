#!/usr/bin/env node

const path = require("node:path");
const { buildGraph, mapToSortedObject } = require("../src/lib/marketGraph");
const {
  findUniqueTriangles,
  buildCanonicalCycles,
  getHubBreakdownCounts,
} = require("../src/lib/triangles");
const { calculateCycleMultiplier } = require("../src/lib/multiplier");
const { fetchUpbitMarkets, fetchOrderbooks } = require("../src/lib/upbitApi");
const { writeReports } = require("../src/lib/report");

function parseOptionalFeeRate(value) {
  if (value === undefined || value === "") {
    return {
      feeRate: 0,
      configured: false,
      label: "not set; netMultiplier equals grossMultiplier",
    };
  }

  const feeRate = Number.parseFloat(value);

  if (!Number.isFinite(feeRate) || feeRate < 0 || feeRate >= 1) {
    throw new Error(`UPBIT_TAKER_FEE_RATE must be a decimal between 0 and 1. Received: ${value}`);
  }

  return {
    feeRate,
    configured: true,
    label: String(feeRate),
  };
}

function parsePositiveIntegerEnv(name, defaultValue) {
  const value = process.env[name];

  if (value === undefined || value === "") {
    return defaultValue;
  }

  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer. Received: ${value}`);
  }

  return parsed;
}

function formatMultiplier(value) {
  if (value === null || value === undefined) {
    return "unavailable";
  }

  return Number(value).toPrecision(12);
}

function printQuoteCounts(quoteCounts) {
  console.log("Market count by quote asset:");

  [...quoteCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .forEach(([quote, count]) => {
      console.log(`  ${quote}: ${count}`);
    });
}

function printHubBreakdown(counts) {
  console.log("Hub-pair breakdown counts:");

  for (const label of ["KRW-BTC-X", "BTC-USDT-X", "KRW-USDT-X", "KRW-BTC-USDT"]) {
    console.log(`  ${label}: ${counts[label]}`);
  }
}

function printRankedCycles(title, rows) {
  console.log(title);

  if (rows.length === 0) {
    console.log("  No available multipliers.");
    return;
  }

  rows.forEach((row, index) => {
    console.log(
      `  ${String(index + 1).padStart(2, " ")}. ${formatMultiplier(row.netMultiplier)} ` +
        `${row.routeLabel} [${row.markets.join(", ")}]`,
    );
  });
}

function buildMultiplierRows(cycles, orderbookMap, feeInfo) {
  return cycles.map((cycle, index) => {
    const grossResult = calculateCycleMultiplier(cycle, null, orderbookMap, 0);
    const netResult = feeInfo.configured
      ? calculateCycleMultiplier(cycle, null, orderbookMap, feeInfo.feeRate)
      : grossResult;
    const available = grossResult.available && netResult.available;
    const netMultiplier = available ? netResult.multiplier : null;

    return {
      index: index + 1,
      id: cycle.id,
      route: cycle.route,
      routeLabel: cycle.routeLabel,
      reverseRoute: cycle.reverseRoute,
      reverseRouteLabel: cycle.reverseRouteLabel,
      markets: cycle.markets,
      steps: cycle.steps,
      available,
      unavailableReason: available
        ? null
        : netResult.unavailableReason || grossResult.unavailableReason || "Unavailable multiplier",
      grossMultiplier: grossResult.available ? grossResult.multiplier : null,
      netMultiplier,
      profitRate: available ? netMultiplier - 1 : null,
      impliedReverseMultiplier: available ? 1 / netMultiplier : null,
      feeRate: feeInfo.feeRate,
      feeRateConfigured: feeInfo.configured,
    };
  });
}

function sortAvailableRows(rows, direction) {
  return rows
    .filter((row) => row.available)
    .sort((left, right) => {
      const multiplierOrder = direction === "desc"
        ? right.netMultiplier - left.netMultiplier
        : left.netMultiplier - right.netMultiplier;

      return multiplierOrder || left.routeLabel.localeCompare(right.routeLabel);
    });
}

async function main() {
  const feeInfo = parseOptionalFeeRate(process.env.UPBIT_TAKER_FEE_RATE);
  const orderbookBatchSize = parsePositiveIntegerEnv("UPBIT_ORDERBOOK_BATCH_SIZE", 50);
  const orderbookDelayMs = parsePositiveIntegerEnv("UPBIT_ORDERBOOK_DELAY_MS", 200);
  const generatedAt = new Date().toISOString();

  console.log("Loading Upbit market universe...");
  const upbitMarkets = await fetchUpbitMarkets();
  const { normalizedMarkets, graph, pairMap, quoteCounts } = buildGraph(upbitMarkets);

  console.log("Finding unique triangular routes...");
  const triangles = findUniqueTriangles(graph, pairMap);
  const canonicalCycles = buildCanonicalCycles(triangles, pairMap);
  const hubBreakdown = getHubBreakdownCounts(triangles);
  const requiredMarkets = [...new Set(canonicalCycles.flatMap((cycle) => cycle.markets))].sort();

  console.log(
    `Fetching orderbooks for ${requiredMarkets.length} markets ` +
      `(batchSize=${orderbookBatchSize}, delayMs=${orderbookDelayMs})...`,
  );
  const orderbookResult = await fetchOrderbooks(requiredMarkets, {
    batchSize: orderbookBatchSize,
    delayMs: orderbookDelayMs,
  });

  const multiplierRows = buildMultiplierRows(canonicalCycles, orderbookResult.orderbookMap, feeInfo);
  const unavailableCount = multiplierRows.filter((row) => !row.available).length;
  const topRows = sortAvailableRows(multiplierRows, "desc").slice(0, 20);
  const bottomRows = sortAvailableRows(multiplierRows, "asc").slice(0, 20);
  const metadata = {
    generatedAt,
    source: "https://api.upbit.com/v1",
    totalMarketsLoaded: normalizedMarkets.length,
    quoteCounts: mapToSortedObject(quoteCounts),
    uniqueTriangleCount: triangles.length,
    canonicalCycleCount: canonicalCycles.length,
    hubBreakdown,
    requestedOrderbookMarketCount: orderbookResult.requestedMarketCount,
    fetchedOrderbookMarketCount: orderbookResult.fetchedMarketCount,
    orderbookErrorCount: orderbookResult.errors.length,
    unavailableMultiplierCount: unavailableCount,
    netFeeRate: feeInfo.feeRate,
    netFeeRateConfigured: feeInfo.configured,
    netFeeRateLabel: feeInfo.label,
  };

  const outDir = path.resolve(process.cwd(), "out");
  const reportPaths = await writeReports(outDir, {
    metadata,
    trianglesJson: {
      ...metadata,
      triangles,
    },
    cyclesJson: {
      ...metadata,
      cycles: multiplierRows,
      orderbookErrors: orderbookResult.errors,
    },
    multiplierRows,
  });

  console.log("");
  console.log(`Total Upbit markets loaded: ${normalizedMarkets.length}`);
  printQuoteCounts(quoteCounts);
  console.log(`uniqueTriangleCount: ${triangles.length}`);
  console.log(`canonicalCycleCount: ${canonicalCycles.length}`);
  printHubBreakdown(hubBreakdown);
  console.log(`Net fee rate: ${feeInfo.label}`);
  console.log(`Orderbooks fetched: ${orderbookResult.fetchedMarketCount}/${orderbookResult.requestedMarketCount}`);
  console.log(`Unavailable cycle multipliers: ${unavailableCount}`);
  console.log("");
  printRankedCycles("Top 20 canonical cycles by netMultiplier:", topRows);
  console.log("");
  printRankedCycles("Bottom 20 canonical cycles by netMultiplier:", bottomRows);
  console.log("");
  console.log("Wrote outputs:");
  console.log(`  ${path.relative(process.cwd(), reportPaths.trianglesPath)}`);
  console.log(`  ${path.relative(process.cwd(), reportPaths.cyclesPath)}`);
  console.log(`  ${path.relative(process.cwd(), reportPaths.csvPath)}`);
  console.log(`  ${path.relative(process.cwd(), reportPaths.htmlPath)}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
