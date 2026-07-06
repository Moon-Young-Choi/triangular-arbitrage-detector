const crypto = require("node:crypto");
const { CommandInbox } = require("../core/commandInbox");
const {
  normalizeDashboardCommandPayload,
  normalizeOperatorCommandPayload,
} = require("../core/commandPolicy");
const { CommandStatusStore } = require("../core/commandStatusStore");
const { EventLog } = require("../core/eventLog");
const { executionLogMode } = require("../execution/executionPlan");

function engineStateFromSnapshot(snapshot = {}) {
  return snapshot.engineState || (snapshot.engine && snapshot.engine.state) || "UNKNOWN";
}

function runModeFromSnapshot(snapshot = {}) {
  return snapshot.runtimeConfig && snapshot.runtimeConfig.runMode || "OBSERVE";
}

function commandFromPathname(pathname) {
  if (!pathname.startsWith("/api/command/")) return null;

  const commandName = pathname.slice("/api/command/".length).toLowerCase();
  if (commandName === "start") return "Start";
  if (commandName === "pause") return "Pause";
  if (commandName === "stop") return "Stop";
  return undefined;
}

function normalizeCommandRequest(payload = {}, pathCommand) {
  if (pathCommand === undefined) {
    throw new Error("Invalid engine command endpoint");
  }

  if (pathCommand) {
    if (payload.command !== undefined) {
      const bodyRequest = normalizeDashboardCommandPayload(payload);
      if (bodyRequest.command !== pathCommand) {
        throw new Error(`Command path ${pathCommand} does not match payload command ${bodyRequest.command}`);
      }
      return bodyRequest;
    }

    return normalizeDashboardCommandPayload({ ...payload, command: pathCommand });
  }

  return normalizeDashboardCommandPayload(payload);
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

function createDashboardCommandApi(options = {}) {
  const {
    eventLog = new EventLog(options),
    commandStatusStore,
    readSnapshot,
    randomUUID = crypto.randomUUID,
  } = options;

  if (!eventLog || typeof eventLog.append !== "function") {
    throw new Error("Dashboard command API requires eventLog.append");
  }

  if (!commandStatusStore || typeof commandStatusStore.write !== "function") {
    throw new Error("Dashboard command API requires commandStatusStore.write");
  }

  if (typeof readSnapshot !== "function") {
    throw new Error("Dashboard command API requires readSnapshot");
  }

  return {
    async queue(payload = {}, pathCommand = null) {
      const request = normalizeCommandRequest(payload, pathCommand);
      const commandId = randomUUID();
      const snapshot = await readSnapshot();
      const commandRunMode = request.runMode || runModeFromSnapshot(snapshot);
      const record = await eventLog.append("commands", {
        type: "dashboard.command",
        mode: executionLogMode(commandRunMode),
        engineState: engineStateFromSnapshot(snapshot),
        command: request.command,
        commandId,
        runMode: request.runMode,
        emergency: request.emergency === true,
        source: "dashboard",
      });

      await commandStatusStore.write(commandId, {
        status: "queued",
        command: request.command,
        runMode: request.runMode,
        emergency: request.emergency === true,
        source: "dashboard",
        queuedAt: record.timestamp,
      });

      return {
        ok: true,
        command: record.command,
        commandId: record.commandId,
        runMode: record.runMode,
        status: "queued",
      };
    },

    readStatus(commandId) {
      return commandStatusStore.read(commandId);
    },
  };
}

module.exports = {
  commandFromPathname,
  createCommandQueue,
  createDashboardCommandApi,
  engineStateFromSnapshot,
  normalizeCommandRequest,
  runModeFromSnapshot,
};
