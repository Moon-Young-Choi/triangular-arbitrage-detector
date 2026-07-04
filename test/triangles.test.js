const test = require("node:test");
const assert = require("node:assert/strict");
const { buildGraph } = require("../src/lib/marketGraph");
const {
  findUniqueTriangles,
  buildCanonicalCycles,
  getHubBreakdownCounts,
} = require("../src/lib/triangles");
const { convertAmount } = require("../src/lib/multiplier");

function cyclesFor(markets) {
  const { graph, pairMap } = buildGraph(markets);
  const triangles = findUniqueTriangles(graph, pairMap);
  return {
    triangles,
    cycles: buildCanonicalCycles(triangles, pairMap),
    hubBreakdown: getHubBreakdownCounts(triangles),
  };
}

test("synthetic KRW-BTC-ETH market set produces one canonical triangle", () => {
  const { triangles, cycles } = cyclesFor(["KRW-BTC", "BTC-ETH", "KRW-ETH"]);

  assert.equal(triangles.length, 1);
  assert.equal(cycles.length, 1);
  assert.deepEqual(cycles[0].route, ["KRW", "BTC", "ETH", "KRW"]);
});

test("rotations are not double-counted as separate triangles", () => {
  const { triangles } = cyclesFor(["KRW-BTC", "BTC-ETH", "KRW-ETH"]);

  assert.equal(triangles.length, 1);
});

test("reverse direction is not emitted by default", () => {
  const { cycles } = cyclesFor(["KRW-BTC", "BTC-ETH", "KRW-ETH"]);
  const routeLabels = cycles.map((cycle) => cycle.routeLabel);

  assert.equal(cycles.length, 1);
  assert.deepEqual(routeLabels, ["KRW -> BTC -> ETH -> KRW"]);
  assert.equal(routeLabels.includes("KRW -> ETH -> BTC -> KRW"), false);
});

test("all-hub triangle is counted once and uses the hub ring route", () => {
  const { triangles, cycles, hubBreakdown } = cyclesFor(["KRW-BTC", "KRW-USDT", "BTC-USDT"]);

  assert.equal(triangles.length, 1);
  assert.equal(cycles.length, 1);
  assert.deepEqual(cycles[0].route, ["KRW", "BTC", "USDT", "KRW"]);
  assert.equal(hubBreakdown["KRW-BTC-USDT"], 1);
});

test("BTC-USDT-X triangles use BTC -> USDT -> X -> BTC", () => {
  const { cycles } = cyclesFor(["BTC-USDT", "BTC-ETH", "USDT-ETH"]);

  assert.equal(cycles.length, 1);
  assert.deepEqual(cycles[0].route, ["BTC", "USDT", "ETH", "BTC"]);
});

test("KRW-USDT-X triangles use USDT -> KRW -> X -> USDT", () => {
  const { cycles } = cyclesFor(["KRW-USDT", "KRW-ETH", "USDT-ETH"]);

  assert.equal(cycles.length, 1);
  assert.deepEqual(cycles[0].route, ["USDT", "KRW", "ETH", "USDT"]);
});

test("incomplete triangles are not counted", () => {
  const { triangles, cycles } = cyclesFor(["KRW-BTC", "BTC-ETH"]);

  assert.equal(triangles.length, 0);
  assert.equal(cycles.length, 0);
});

test("QUOTE -> BASE conversion buys at best ask", () => {
  const orderbook = {
    market: "KRW-BTC",
    orderbook_units: [{ ask_price: 100, bid_price: 90 }],
  };

  assert.equal(convertAmount(1000, "KRW", "BTC", "KRW-BTC", orderbook, 0.001), 9.99);
});

test("BASE -> QUOTE conversion sells at best bid", () => {
  const orderbook = {
    market: "KRW-BTC",
    orderbook_units: [{ ask_price: 100, bid_price: 90 }],
  };

  assert.equal(convertAmount(2, "BTC", "KRW", "KRW-BTC", orderbook, 0.001), 179.82);
});
