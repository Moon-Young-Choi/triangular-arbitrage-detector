const test = require("node:test");
const assert = require("node:assert/strict");
const {
  computeFeeMetrics,
  classifyOpportunity,
  assignCycleGroup,
  buildStableCycleLayout,
  formatLocalTimestampForFilename,
  getCycleFreshness,
} = require("../src/live/liveUtils");

function cycle(id, assets, routeLabel = `${id} route`) {
  return {
    id,
    triangleAssets: assets,
    routeLabel,
    markets: assets.map((asset, index) => `${asset}-${assets[(index + 1) % assets.length]}`),
  };
}

test("break-even formulas handle zero fee", () => {
  const metrics = computeFeeMetrics(0);

  assert.equal(metrics.feeFactor, 1);
  assert.equal(metrics.upperBreakEven, 1);
  assert.equal(metrics.lowerBreakEven, 1);
});

test("break-even formulas handle 0.0005 fee", () => {
  const metrics = computeFeeMetrics(0.0005);
  const expectedFeeFactor = (1 - 0.0005) ** 3;

  assert.equal(metrics.feeFactor, expectedFeeFactor);
  assert.equal(metrics.upperBreakEven, 1 / expectedFeeFactor);
  assert.equal(metrics.lowerBreakEven, expectedFeeFactor);
});

test("point classification respects fee break-even bands", () => {
  const { upperBreakEven, lowerBreakEven } = computeFeeMetrics(0.0005);

  assert.equal(classifyOpportunity(upperBreakEven + 0.000001, 0.0005), "canonical-profit");
  assert.equal(classifyOpportunity(lowerBreakEven - 0.000001, 0.0005), "implied-reverse-profit");
  assert.equal(classifyOpportunity(1, 0.0005), "neutral");
  assert.equal(classifyOpportunity(1.2, 0.0005, "stale"), "unavailable");
});

test("group assignment follows canonical hub edges", () => {
  assert.deepEqual(assignCycleGroup(cycle("a", ["KRW", "BTC", "ETH"])).group, "KRW_BTC");
  assert.deepEqual(assignCycleGroup(cycle("b", ["BTC", "USDT", "ETH"])).group, "BTC_USDT");
  assert.deepEqual(assignCycleGroup(cycle("c", ["KRW", "USDT", "ETH"])).group, "USDT_KRW");

  const allHub = assignCycleGroup(cycle("d", ["KRW", "BTC", "USDT"]));
  assert.equal(allHub.group, "KRW_BTC");
  assert.equal(allHub.allHub, true);

  assert.equal(assignCycleGroup(cycle("e", ["ETH", "XRP", "SOL"])).group, "OTHER");
});

test("stable x-position generation is deterministic and ignores multipliers", () => {
  const cycles = [
    { ...cycle("eth", ["KRW", "BTC", "ETH"]), grossCanonicalMultiplier: 1.1 },
    { ...cycle("xrp", ["KRW", "BTC", "XRP"]), grossCanonicalMultiplier: 0.9 },
    { ...cycle("hub", ["KRW", "BTC", "USDT"]), grossCanonicalMultiplier: 1 },
  ];
  const first = buildStableCycleLayout(cycles).cycles.map(({ id, x }) => ({ id, x }));
  const second = buildStableCycleLayout(
    cycles.map((item) => ({ ...item, grossCanonicalMultiplier: item.grossCanonicalMultiplier * 2 })),
  ).cycles.map(({ id, x }) => ({ id, x }));

  assert.deepEqual(first, second);
  assert.deepEqual(first, [
    { id: "hub", x: 1 },
    { id: "eth", x: 2 },
    { id: "xrp", x: 3 },
  ]);
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
