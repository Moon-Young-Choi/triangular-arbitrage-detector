const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { CommandInbox } = require("../src/core/commandInbox");

test("command inbox writes command files atomically and marks processed", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "q-gagarin-command-inbox-"));
  const inbox = new CommandInbox({
    runtimeDir: dir,
    randomUUID: () => "11111111-1111-4111-8111-111111111111",
    now: () => new Date("2026-07-06T12:00:00.123Z"),
  });

  const queued = await inbox.enqueue({
    command: "Start",
    runMode: "DRY_RUN",
    source: "cli",
  });
  const pending = await inbox.listPending();

  assert.equal(queued.commandId, "11111111-1111-4111-8111-111111111111");
  assert.equal(queued.command, "Start");
  assert.equal(queued.runMode, "DRY_RUN");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].record.commandId, queued.commandId);
  assert.match(pending[0].fileName, /^20260706T120000-123Z-/);

  await inbox.markProcessed(pending[0]);

  assert.equal((await inbox.listPending()).length, 0);
  const processed = await fs.readdir(path.join(dir, "commands", "processed"));
  assert.equal(processed.length, 1);
});
