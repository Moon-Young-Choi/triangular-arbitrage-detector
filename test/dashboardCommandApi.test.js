const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { AppendOnlyLogStore } = require("../src/core/appendOnlyLog");
const { CommandStatusStore } = require("../src/core/commandStatusStore");
const {
  commandFromPathname,
  createDashboardCommandApi,
  normalizeCommandRequest,
} = require("../src/dashboard/commandApi");

test("dashboard command API queues only audited engine commands", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "q-gagarin-command-api-"));
  const logStore = new AppendOnlyLogStore({ logDir: path.join(dir, "logs") });
  const commandStatusStore = new CommandStatusStore({ runtimeDir: dir });
  await logStore.ensureFiles();

  const api = createDashboardCommandApi({
    logStore,
    commandStatusStore,
    randomUUID: () => "11111111-1111-4111-8111-111111111111",
    async readSnapshot() {
      return {
        engineState: "STOPPED",
        runtimeConfig: {
          runMode: "OBSERVE",
        },
      };
    },
  });

  const result = await api.queue({ runMode: "DRY_RUN" }, "Start");
  const commands = await logStore.readAll("commands");
  const status = await api.readStatus(result.commandId);

  assert.equal(result.command, "Start");
  assert.equal(result.runMode, "DRY_RUN");
  assert.equal(commands.length, 1);
  assert.equal(commands[0].type, "dashboard.command");
  assert.equal(commands[0].mode, "DRY_RUN");
  assert.equal(commands[0].engineState, "STOPPED");
  assert.equal(commands[0].auditSchema.ok, true);
  assert.equal(status.status, "queued");
  assert.equal(status.command, "Start");
  assert.equal(status.runMode, "DRY_RUN");
});

test("dashboard command API rejects endpoint mismatch and mutation fields", () => {
  assert.equal(commandFromPathname("/api/command/start"), "Start");
  assert.equal(commandFromPathname("/api/command/restart"), undefined);

  assert.throws(
    () => normalizeCommandRequest({ command: "Start", runMode: "DRY_RUN" }, "Pause"),
    /does not match/,
  );
  assert.throws(
    () => normalizeCommandRequest({ command: "Start", feeRate: 0.01 }, null),
    /Unsupported dashboard command field/,
  );
  assert.throws(
    () => normalizeCommandRequest({}, undefined),
    /Invalid engine command endpoint/,
  );
});
