const test = require("node:test");
const assert = require("node:assert/strict");
const { LiveTriangleState } = require("../src/live/liveState");
const { createStrategyRegistry } = require("../src/strategies/registry");

test("strategy registry exposes baseline and depth-aware strategies", () => {
  const registry = createStrategyRegistry();
  const strategies = registry.list();
  const baseline = registry.get("topOfBookBaseline");

  assert.deepEqual(strategies.map((strategy) => strategy.id).sort(), [
    "depthAwareBestIoc",
    "topOfBookBaseline",
  ]);
  assert.equal(baseline.evaluate({
    row: {
      status: "available",
      netProfitRate: 0.001,
    },
  }).accepted, true);
  assert.equal(baseline.evaluate({
    row: {
      status: "available",
      netProfitRate: 0,
    },
  }).reason, "PROFIT_BELOW_THRESHOLD");
});

test("strategy selection is guarded to STOPPED engine state", () => {
  const state = new LiveTriangleState({ engineState: "STOPPED" });

  state.selectStrategy("depthAwareBestIoc");
  assert.equal(state.activeStrategy.id, "depthAwareBestIoc");

  state.engineState = "RUNNING";
  assert.throws(() => state.selectStrategy("topOfBookBaseline"), /STOPPED/);
});
