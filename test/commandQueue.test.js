const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { CommandInbox } = require("../src/core/commandInbox");
const { CommandStatusStore } = require("../src/core/commandStatusStore");
const { createCommandQueue } = require("../src/ops/commandQueue");

test("operator command queue writes atomic inbox commands and status", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "q-gagarin-command-queue-"));
  const commandInbox = new CommandInbox({
    runtimeDir: dir,
    randomUUID: () => "11111111-1111-4111-8111-111111111111",
    now: () => new Date("2026-07-06T12:00:00.000Z"),
  });
  const commandStatusStore = new CommandStatusStore({ runtimeDir: dir });
  const queue = createCommandQueue({
    commandInbox,
    commandStatusStore,
    source: "cli",
    async readSnapshot() {
      return {
        engineState: "STOPPED",
        runtimeConfig: {
          runMode: "OBSERVE",
        },
      };
    },
  });

  const result = await queue.queue({ command: "Start", runMode: "dry_run" });
  const pending = await commandInbox.listPending();
  const status = await queue.readStatus(result.commandId);

  assert.equal(result.ok, true);
  assert.equal(result.command, "Start");
  assert.equal(result.runMode, "DRY_RUN");
  assert.equal(result.source, "cli");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].record.command, "Start");
  assert.equal(pending[0].record.source, "cli");
  assert.equal(status.status, "queued");
  assert.equal(status.command, "Start");
  assert.equal(status.runMode, "DRY_RUN");
  assert.equal(status.engineState, "STOPPED");
});

test("operator command queue rejects non-command mutation payloads", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "q-gagarin-command-queue-policy-"));
  const queue = createCommandQueue({
    runtimeDir: dir,
    commandStatusStore: new CommandStatusStore({ runtimeDir: dir }),
  });

  await assert.rejects(
    () => queue.queue({ command: "Start", feeRate: 0.01 }),
    /Unsupported operator command field/,
  );
  await assert.rejects(
    () => queue.queue({ command: "Pause", runMode: "DRY_RUN" }),
    /runMode is allowed only with Start/,
  );
  await assert.rejects(
    () => queue.queue({ command: "Start", runMode: "REAL_AUTO" }),
    /cannot be started from operator command/,
  );
});
