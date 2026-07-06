const test = require("node:test");
const assert = require("node:assert/strict");
const { EmergencyStop } = require("../src/execution/emergencyStop");

test("emergency stop latches reason and can be cleared after stop handling", () => {
  const stop = new EmergencyStop();
  const triggered = stop.trigger("MAX_DAILY_LOSS", {
    source: "real-run-limits",
    startAsset: "KRW",
  });

  assert.equal(triggered.active, true);
  assert.equal(triggered.reason, "MAX_DAILY_LOSS");
  assert.equal(triggered.source, "real-run-limits");

  const duplicate = stop.trigger("OTHER_REASON");
  assert.equal(duplicate.reason, "MAX_DAILY_LOSS");

  const cleared = stop.clear({ reason: "operator-stop" });
  assert.equal(cleared.active, false);
  assert.equal(cleared.reason, null);
});
