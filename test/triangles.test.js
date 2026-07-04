const test = require("node:test");
const assert = require("node:assert/strict");
const { buildGraph } = require("../src/lib/marketGraph");
const {
  findUniqueTriangles,
  buildDirectionalCycles,
  getHubBreakdownCounts,
} = require("../src/lib/triangles");
const { convertAmount, calculateCycleMultiplier } = require("../src/lib/multiplier");

function cyclesFor(markets) {
  const { graph, pairMap } = buildGraph(markets);
  const triangles = findUniqueTriangles(graph, pairMap);
  return {
    triangles,
    cycles: buildDirectionalCycles(triangles, pairMap),
    hubBreakdown: getHubBreakdownCounts(triangles),
  };
}

test("synthetic KRW-BTC-ETH market set produces one triangle with two actual directions", () => {
  const { triangles, cycles } = cyclesFor(["KRW-BTC", "BTC-ETH", "KRW-ETH"]);

  assert.equal(triangles.length, 1);
  assert.equal(cycles.length, 2);
  assert.deepEqual(cycles.map((cycle) => cycle.cycleId), [
    "BTC|ETH|KRW:canonical",
    "BTC|ETH|KRW:reverse",
  ]);
  assert.deepEqual(cycles.find((cycle) => cycle.direction === "canonical").route, ["KRW", "BTC", "ETH", "KRW"]);
  assert.deepEqual(cycles.find((cycle) => cycle.direction === "reverse").route, ["KRW", "ETH", "BTC", "KRW"]);
});

test("rotations are not double-counted as separate triangles", () => {
  const { triangles } = cyclesFor(["KRW-BTC", "BTC-ETH", "KRW-ETH"]);

  assert.equal(triangles.length, 1);
});

test("all-hub triangle is counted once and uses the hub ring route", () => {
  const { triangles, cycles, hubBreakdown } = cyclesFor(["KRW-BTC", "KRW-USDT", "BTC-USDT"]);
  const canonical = cycles.find((cycle) => cycle.direction === "canonical");

  assert.equal(triangles.length, 1);
  assert.equal(cycles.length, 2);
  assert.deepEqual(canonical.route, ["KRW", "BTC", "USDT", "KRW"]);
  assert.equal(hubBreakdown["KRW-BTC-USDT"], 1);
});

test("BTC-USDT-X triangles use BTC -> USDT -> X -> BTC", () => {
  const { cycles } = cyclesFor(["BTC-USDT", "BTC-ETH", "USDT-ETH"]);
  const canonical = cycles.find((cycle) => cycle.direction === "canonical");

  assert.equal(cycles.length, 2);
  assert.deepEqual(canonical.route, ["BTC", "USDT", "ETH", "BTC"]);
});

test("KRW-USDT-X triangles use USDT -> KRW -> X -> USDT", () => {
  const { cycles } = cyclesFor(["KRW-USDT", "KRW-ETH", "USDT-ETH"]);
  const canonical = cycles.find((cycle) => cycle.direction === "canonical");

  assert.equal(cycles.length, 2);
  assert.deepEqual(canonical.route, ["USDT", "KRW", "ETH", "USDT"]);
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

test("reverse gross multiplier is calculated from its own bid/ask route", () => {
  const { cycles } = cyclesFor(["KRW-BTC", "BTC-ETH", "KRW-ETH"]);
  const canonical = cycles.find((cycle) => cycle.direction === "canonical");
  const reverse = cycles.find((cycle) => cycle.direction === "reverse");
  const orderbooks = new Map([
    ["KRW-BTC", {
      market: "KRW-BTC",
      timestamp: 1000,
      orderbook_units: [{ ask_price: 100, bid_price: 90, ask_size: 10, bid_size: 10 }],
    }],
    ["BTC-ETH", {
      market: "BTC-ETH",
      timestamp: 1000,
      orderbook_units: [{ ask_price: 0.1, bid_price: 0.09, ask_size: 10, bid_size: 10 }],
    }],
    ["KRW-ETH", {
      market: "KRW-ETH",
      timestamp: 1000,
      orderbook_units: [{ ask_price: 20, bid_price: 18, ask_size: 10, bid_size: 10 }],
    }],
  ]);

  const canonicalGross = calculateCycleMultiplier(canonical, null, orderbooks, 0, { nowMs: 1000 });
  const reverseGross = calculateCycleMultiplier(reverse, null, orderbooks, 0, { nowMs: 1000 });

  assert.equal(canonicalGross.available, true);
  assert.equal(reverseGross.available, true);
  assert.notEqual(reverseGross.multiplier, 1 / canonicalGross.multiplier);
  assert.equal(canonicalGross.conversions.length, 3);
  assert.equal(reverseGross.conversions.length, 3);
  assert.equal(canonicalGross.conversions[0].usedSide, "ask");
  assert.equal(canonicalGross.conversions[2].usedSide, "bid");
  assert.equal(reverseGross.conversions[0].usedSide, "ask");
  assert.equal(reverseGross.conversions[2].usedSide, "bid");
});
