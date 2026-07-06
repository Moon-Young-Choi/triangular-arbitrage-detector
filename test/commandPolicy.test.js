const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeOperatorCommandPayload,
  normalizeQueuedCommandRecord,
} = require("../src/core/commandPolicy");

test("operator command policy accepts only Start/Pause/Stop command payloads", () => {
  assert.deepEqual(
    normalizeOperatorCommandPayload({ command: "Start", runMode: "dry_run" }),
    { command: "Start", runMode: "DRY_RUN" },
  );
  assert.deepEqual(
    normalizeOperatorCommandPayload({ command: "Stop", emergency: true }),
    { command: "Stop", emergency: true },
  );

  assert.throws(
    () => normalizeOperatorCommandPayload({ command: "Pause", runMode: "DRY_RUN" }),
    /runMode is allowed only with Start/,
  );
  assert.throws(
    () => normalizeOperatorCommandPayload({ command: "Start", runMode: "REAL_AUTO" }),
    /cannot be started from operator command/,
  );
  assert.throws(
    () => normalizeOperatorCommandPayload({ command: "Start", feeRate: 0.1 }),
    /Unsupported operator command field/,
  );
  assert.throws(
    () => normalizeOperatorCommandPayload({ command: "Pause", emergency: true }),
    /emergency is allowed only with Stop/,
  );
});

test("queued command policy rejects forged unsafe operator records", () => {
  assert.deepEqual(
    normalizeQueuedCommandRecord({
      command: "Start",
      commandId: "cmd-1",
      source: "cli",
      runMode: "OBSERVE",
      timestamp: "ignored",
    }),
    {
      command: "Start",
      commandId: "cmd-1",
      source: "cli",
      runMode: "OBSERVE",
    },
  );

  assert.throws(
    () => normalizeQueuedCommandRecord({ command: "Stop", runMode: "DRY_RUN" }),
    /runMode is allowed only with Start/,
  );
});
