const { CommandInbox } = require("../core/commandInbox");
const { normalizeOperatorCommandPayload } = require("../core/commandPolicy");
const { CommandStatusStore } = require("../core/commandStatusStore");

function engineStateFromSnapshot(snapshot = {}) {
  return snapshot.engineState || (snapshot.engine && snapshot.engine.state) || "UNKNOWN";
}

function runModeFromSnapshot(snapshot = {}) {
  return snapshot.runtimeConfig && snapshot.runtimeConfig.runMode || "OBSERVE";
}

function createCommandQueue(options = {}) {
  const {
    commandInbox = new CommandInbox(options),
    commandStatusStore = new CommandStatusStore(options),
    readSnapshot,
    source = "cli",
  } = options;

  if (!commandInbox || typeof commandInbox.enqueue !== "function") {
    throw new Error("Command queue requires commandInbox.enqueue");
  }

  if (!commandStatusStore || typeof commandStatusStore.write !== "function") {
    throw new Error("Command queue requires commandStatusStore.write");
  }

  return {
    async queue(payload = {}) {
      const request = normalizeOperatorCommandPayload(payload);
      const snapshot = typeof readSnapshot === "function" ? await readSnapshot() : {};
      const queued = await commandInbox.enqueue({
        ...request,
        source,
      });

      await commandStatusStore.write(queued.commandId, {
        status: "queued",
        command: queued.command,
        runMode: queued.runMode,
        emergency: queued.emergency === true,
        source,
        queuedAt: queued.createdAt,
        engineState: engineStateFromSnapshot(snapshot),
      });

      return {
        ok: true,
        command: queued.command,
        commandId: queued.commandId,
        runMode: queued.runMode,
        emergency: queued.emergency === true,
        source,
        status: "queued",
        filePath: queued.filePath,
      };
    },

    readStatus(commandId) {
      return commandStatusStore.read(commandId);
    },
  };
}

module.exports = {
  createCommandQueue,
  engineStateFromSnapshot,
  runModeFromSnapshot,
};
