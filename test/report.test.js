const test = require("node:test");
const assert = require("node:assert/strict");
const { buildMultiplierCsv } = require("../src/lib/report");

test("CSV export contains directional rows without deleted reverse estimate fields", () => {
  const csv = buildMultiplierCsv([
    {
      triangleId: "BTC|ETH|KRW",
      cycleId: "BTC|ETH|KRW:reverse",
      direction: "reverse",
      routeLabel: "KRW -> ETH -> BTC -> KRW",
      markets: ["KRW-ETH", "BTC-ETH", "KRW-BTC"],
      available: true,
      grossMultiplier: 1.002,
      netMultiplier: 1.0005,
      profitRate: 0.0005,
      unavailableReason: null,
    },
  ]);

  assert.match(csv, /direction/);
  assert.match(csv, /BTC\|ETH\|KRW:reverse/);
  assert.equal(csv.includes(["implied", "Reverse"].join("")), false);
  assert.equal(csv.includes(["lower", "Break", "Even"].join("")), false);
});
