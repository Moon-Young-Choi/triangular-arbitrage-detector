const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeDashboardCommandPayload,
  normalizeQueuedCommandRecord,
} = require("../src/core/commandPolicy");

test("dashboard command policy accepts only Start/Pause/Stop command payloads", () => {
  assert.deepEqual(
    normalizeDashboardCommandPayload({ command: "Start", runMode: "dry_run" }),
    { command: "Start", runMode: "DRY_RUN" },
  );
  assert.deepEqual(
    normalizeDashboardCommandPayload({ command: "Stop", emergency: true }),
    { command: "Stop", emergency: true },
  );

  assert.throws(
    () => normalizeDashboardCommandPayload({ command: "Pause", runMode: "DRY_RUN" }),
    /runMode is allowed only with Start/,
  );
  assert.throws(
    () => normalizeDashboardCommandPayload({ command: "Start", runMode: "REAL_AUTO" }),
    /cannot be started from dashboard/,
  );
  assert.throws(
    () => normalizeDashboardCommandPayload({ command: "Start", feeRate: 0.1 }),
    /Unsupported dashboard command field/,
  );
  assert.throws(
    () => normalizeDashboardCommandPayload({ command: "Pause", emergency: true }),
    /emergency is allowed only with Stop/,
  );
});

test("queued command policy rejects forged unsafe dashboard records", () => {
  assert.deepEqual(
    normalizeQueuedCommandRecord({
      command: "Start",
      commandId: "cmd-1",
      source: "dashboard",
      runMode: "OBSERVE",
      timestamp: "ignored",
    }),
    {
      command: "Start",
      commandId: "cmd-1",
      source: "dashboard",
      runMode: "OBSERVE",
    },
  );

  assert.throws(
    () => normalizeQueuedCommandRecord({ command: "Stop", runMode: "DRY_RUN" }),
    /runMode is allowed only with Start/,
  );
});
