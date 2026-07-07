const test = require("node:test");
const assert = require("node:assert/strict");
const {
  computeFeeMetrics,
  classifyOpportunity,
  assignCycleGroup,
  buildStableCycleLayout,
  formatLocalTimestampForFilename,
  getCycleFreshness,
  rollingStats,
  calculateLatencyBreakdown,
  clampRange,
} = require("../src/live/liveUtils");
const {
  readCurrentCpuMHz,
  calculateProcessCpuPercent,
} = require("../src/live/metrics");

function cycle(id, assets, routeLabel = `${id} route`, startAsset = assets[0]) {
  return {
    id,
    triangleAssets: assets,
    startAsset,
    endAsset: startAsset,
    cycleId: `${id}:${startAsset}`,
    routeLabel,
    route: [startAsset, ...assets.filter((asset) => asset !== startAsset), startAsset],
    markets: assets.map((asset, index) => `${asset}-${assets[(index + 1) % assets.length]}`),
  };
}

test("break-even formulas handle zero fee", () => {
  const metrics = computeFeeMetrics(0);

  assert.equal(metrics.feeFactor, 1);
  assert.equal(metrics.executableBreakEvenGross, 1);
  assert.equal(Object.hasOwn(metrics, ["lower", "Break", "Even"].join("")), false);
});

test("break-even formulas handle 0.0005 fee", () => {
  const metrics = computeFeeMetrics(0.0005);
  const expectedFeeFactor = (1 - 0.0005) ** 3;

  assert.equal(metrics.feeFactor, expectedFeeFactor);
  assert.equal(metrics.executableBreakEvenGross, 1 / expectedFeeFactor);
  assert.equal(Object.hasOwn(metrics, ["lower", "Break", "Even"].join("")), false);
});

test("point classification uses only the actual direction multiplier", () => {
  const { executableBreakEvenGross } = computeFeeMetrics(0.0005);

  assert.equal(classifyOpportunity(executableBreakEvenGross + 0.000001, 0.0005), "canonical-profit");
  assert.equal(
    classifyOpportunity(executableBreakEvenGross + 0.000001, 0.0005, "available", "reverse"),
    "reverse-profit",
  );
  assert.equal(classifyOpportunity(0.5, 0.0005, "available", "canonical"), "neutral");
  assert.equal(classifyOpportunity(0.5, 0.0005, "available", "reverse"), "neutral");
  assert.equal(classifyOpportunity(1, 0.0005), "neutral");
  assert.equal(classifyOpportunity(1.2, 0.0005, "stale"), "unavailable");
});

test("group assignment follows executable start assets", () => {
  assert.deepEqual(assignCycleGroup(cycle("a", ["KRW", "BTC", "ETH"], "a route", "KRW")).group, "KRW_START");
  assert.deepEqual(assignCycleGroup(cycle("b", ["BTC", "USDT", "ETH"], "b route", "BTC")).group, "BTC_START");
  assert.deepEqual(assignCycleGroup(cycle("c", ["KRW", "USDT", "ETH"], "c route", "USDT")).group, "USDT_START");

  const allHub = assignCycleGroup(cycle("d", ["KRW", "BTC", "USDT"], "d route", "KRW"));
  assert.equal(allHub.group, "KRW_START");
  assert.equal(allHub.allHub, true);

  assert.equal(assignCycleGroup(cycle("e", ["ETH", "XRP", "SOL"], "e route", "ETH")).group, "ALL");
});

test("stable x-position generation is deterministic and ignores multipliers", () => {
  const cycles = [
    { ...cycle("eth:canonical:KRW", ["KRW", "BTC", "ETH"], "eth KRW canonical", "KRW"), triangleId: "eth", direction: "canonical", grossMultiplier: 1.1 },
    { ...cycle("eth:reverse:KRW", ["KRW", "BTC", "ETH"], "eth KRW reverse", "KRW"), triangleId: "eth", direction: "reverse", grossMultiplier: 0.8 },
    { ...cycle("eth:canonical:BTC", ["KRW", "BTC", "ETH"], "eth BTC canonical", "BTC"), triangleId: "eth", direction: "canonical", grossMultiplier: 1.1 },
    { ...cycle("eth:reverse:BTC", ["KRW", "BTC", "ETH"], "eth BTC reverse", "BTC"), triangleId: "eth", direction: "reverse", grossMultiplier: 0.8 },
    { ...cycle("hub:canonical:USDT", ["KRW", "BTC", "USDT"], "hub USDT canonical", "USDT"), triangleId: "hub", direction: "canonical", grossMultiplier: 1 },
    { ...cycle("hub:reverse:USDT", ["KRW", "BTC", "USDT"], "hub USDT reverse", "USDT"), triangleId: "hub", direction: "reverse", grossMultiplier: 1 },
  ];
  const firstLayout = buildStableCycleLayout(cycles);
  const first = firstLayout.cycles.map(({ id, baseX, x }) => ({ id, baseX, x }));
  const second = buildStableCycleLayout(
    cycles.map((item) => ({ ...item, grossMultiplier: item.grossMultiplier * 2 })),
  ).cycles.map(({ id, baseX, x }) => ({ id, baseX, x }));

  assert.deepEqual(first, second);
  assert.deepEqual(first, [
    { id: "eth:canonical:KRW", baseX: 1, x: 0.85 },
    { id: "eth:reverse:KRW", baseX: 1, x: 1.15 },
    { id: "eth:canonical:BTC", baseX: 2, x: 1.85 },
    { id: "eth:reverse:BTC", baseX: 2, x: 2.15 },
    { id: "hub:canonical:USDT", baseX: 3, x: 2.85 },
    { id: "hub:reverse:USDT", baseX: 3, x: 3.15 },
  ]);
  assert.deepEqual(firstLayout.xRange, { min: 0.25, max: 3.75 });
  assert.equal(firstLayout.groups.find((group) => group.group === "KRW_START").count, 1);
  assert.equal(firstLayout.groups.find((group) => group.group === "BTC_START").count, 1);
  assert.equal(firstLayout.groups.find((group) => group.group === "USDT_START").count, 1);
  assert.equal(firstLayout.groups.find((group) => group.group === "ALL").pointCount, 6);
});

test("capture timestamp filename format includes YYYYMMDD-HHmmss", () => {
  const timestamp = formatLocalTimestampForFilename(new Date(2026, 6, 4, 16, 33, 55));

  assert.equal(timestamp, "20260704-163355");
});

test("stale detection identifies missing, old, and fresh orderbooks", () => {
  const targetCycle = {
    markets: ["KRW-BTC", "BTC-ETH", "KRW-ETH"],
  };
  const now = 10000;

  assert.equal(
    getCycleFreshness(targetCycle, new Map(), 5000, now).status,
    "unavailable",
  );

  const oldOrderbooks = new Map(
    targetCycle.markets.map((market) => [market, { market, timestamp: 1000, receivedAt: 1000 }]),
  );
  assert.equal(getCycleFreshness(targetCycle, oldOrderbooks, 5000, now).status, "stale");

  const freshOrderbooks = new Map(
    targetCycle.markets.map((market) => [market, { market, timestamp: 9000, receivedAt: 9000 }]),
  );
  assert.equal(getCycleFreshness(targetCycle, freshOrderbooks, 5000, now).status, "available");
});

test("cycle freshness allows quiet WS-confirmed markets but excludes REST-only markets", () => {
  const targetCycle = {
    markets: ["KRW-BTC", "BTC-ETH", "KRW-ETH"],
  };
  const now = 10000;
  const quietOrderbooks = new Map(
    targetCycle.markets.map((market) => [market, {
      market,
      timestamp: 1000,
      receivedAt: 1000,
      sourceState: "ws_confirmed",
      wsConfirmed: true,
      firstWsReceivedAt: 1000,
      lastWsReceivedAt: 1000,
    }]),
  );
  const quiet = getCycleFreshness(targetCycle, quietOrderbooks, 5000, now);

  assert.equal(quiet.status, "available");
  assert.deepEqual(quiet.quietMarkets, targetCycle.markets);

  const restOnlyOrderbooks = new Map(
    targetCycle.markets.map((market) => [market, {
      market,
      timestamp: 9000,
      receivedAt: 9000,
      streamType: "REST",
      sourceState: "rest_only",
    }]),
  );
  const restOnly = getCycleFreshness(targetCycle, restOnlyOrderbooks, 5000, now);

  assert.equal(restOnly.status, "unavailable");
  assert.match(restOnly.unavailableReason, /REST-only orderbook/);
});

test("x-axis clamp keeps ranges inside the plotted cycle domain", () => {
  assert.deepEqual(clampRange([-10, 10], 0.25, 3.75), [0.25, 3.75]);
  assert.deepEqual(clampRange([-1, 1], 0.25, 3.75), [0.25, 2.25]);
  assert.deepEqual(clampRange([3, 5], 0.25, 3.75), [1.75, 3.75]);
});

test("latency breakdown and rolling percentiles are computed from samples", () => {
  const latency = calculateLatencyBreakdown({
    upbitTimestampMs: 1000,
    serverReceiveEpochMs: 1012,
    serverReceivePerfMs: 10,
    parseDonePerfMs: 11.5,
    calculationStartPerfMs: 12,
    calculationEndPerfMs: 13.25,
    serverBroadcastQueuedPerfMs: 14,
    serverBroadcastSentPerfMs: 15,
  });

  assert.equal(latency.upbitToServerMs, 12);
  assert.equal(latency.serverParseMs, 1.5);
  assert.equal(latency.serverCalcMs, 1.25);
  assert.equal(latency.serverQueueMs, 1);

  assert.deepEqual(rollingStats([
    { t: 1, v: 10 },
    { t: 2, v: 20 },
    { t: 3, v: 30 },
    { t: 4, v: 40 },
  ], 4, 10, 2000), {
    count: 4,
    p50: 20,
    p95: 40,
    p99: 40,
  });
});

test("CPU metric helpers support os.cpus fallback and process CPU percent", () => {
  const missingFs = {
    readdirSync() {
      throw new Error("missing");
    },
    readFileSync() {
      throw new Error("missing");
    },
  };
  const fakeOs = {
    cpus() {
      return [{ speed: 2400 }, { speed: 2600 }];
    },
  };

  assert.deepEqual(readCurrentCpuMHz({ fs: missingFs, os: fakeOs }), {
    mhz: 2500,
    source: "os.cpus",
    fallback: true,
  });
  assert.equal(calculateProcessCpuPercent({ user: 1000, system: 1000 }, 100000, 2), 1);
});
