const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { AppendOnlyLogStore } = require("../src/core/appendOnlyLog");
const { EventBus } = require("../src/core/eventBus");
const { EventLog } = require("../src/core/eventLog");

test("event log appends audit records and publishes committed events", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "q-gagarin-event-log-"));
  const logStore = new AppendOnlyLogStore({ logDir: dir });
  const eventBus = new EventBus();
  const eventLog = new EventLog({ logStore, eventBus });
  const commandEvents = [];
  const allEvents = [];

  eventLog.subscribe("commands", (event, topic) => {
    commandEvents.push({ event, topic });
  });
  eventLog.subscribe("*", (event, topic) => {
    allEvents.push({ event, topic });
  });

  const record = await eventLog.append("commands", {
    type: "cli.command",
    mode: "DRY_RUN",
    engineState: "STOPPED",
    commandId: "command-event-log",
    command: "Start",
    runMode: "DRY_RUN",
    source: "cli",
  });
  const rows = await eventLog.readAll("commands");

  assert.equal(record.auditSchema.ok, true);
  assert.equal(rows.length, 1);
  assert.equal(commandEvents.length, 1);
  assert.equal(commandEvents[0].topic, "commands");
  assert.equal(commandEvents[0].event.kind, "commands");
  assert.equal(commandEvents[0].event.record.commandId, "command-event-log");
  assert.equal(allEvents.length, 1);
  assert.equal(allEvents[0].topic, "*");
  assert.equal(allEvents[0].event.record.command, "Start");
});

test("event bus isolates handler failures and supports unsubscribe", () => {
  const errors = [];
  const bus = new EventBus({
    onError(error, context) {
      errors.push({ error, context });
    },
  });
  let handled = 0;
  const unsubscribe = bus.subscribe("events", () => {
    handled += 1;
  });
  bus.subscribe("events", () => {
    throw new Error("handler failed");
  });

  assert.equal(bus.publish("events", { ok: true }), 2);
  unsubscribe();
  assert.equal(bus.publish("events", { ok: true }), 1);
  assert.equal(handled, 1);
  assert.equal(errors.length, 2);
  assert.equal(errors[0].context.topic, "events");
});
