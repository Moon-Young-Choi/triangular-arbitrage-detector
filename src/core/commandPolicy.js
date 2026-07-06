const { COMMANDS, normalizeCommand } = require("./runStateMachine");
const { RUN_MODES } = require("./runtimeConfig");

const OPERATOR_START_RUN_MODES = new Set(["OBSERVE", "DRY_RUN", "REAL_GUARDED"]);
const OPERATOR_COMMAND_KEYS = new Set(["command", "runMode", "emergency"]);

function normalizeRunMode(runMode) {
  if (runMode === null || runMode === undefined || runMode === "") {
    return null;
  }

  const normalized = String(runMode).trim().toUpperCase();
  if (!RUN_MODES.has(normalized)) {
    throw new Error(`Invalid runMode: ${runMode}`);
  }

  return normalized;
}

function validateCommandMetadata(command, metadata = {}) {
  const normalizedCommand = normalizeCommand(command);
  const runMode = normalizeRunMode(metadata.runMode);
  const emergency = metadata.emergency === true;

  if (runMode && normalizedCommand !== COMMANDS.START) {
    throw new Error("runMode is allowed only with Start commands");
  }

  if (runMode && !OPERATOR_START_RUN_MODES.has(runMode)) {
    throw new Error(`runMode cannot be started from operator command: ${runMode}`);
  }

  if (metadata.emergency !== undefined && metadata.emergency !== null) {
    if (typeof metadata.emergency !== "boolean") {
      throw new Error("emergency must be a boolean");
    }

    if (emergency && normalizedCommand !== COMMANDS.STOP) {
      throw new Error("emergency is allowed only with Stop commands");
    }
  }

  return {
    command: normalizedCommand,
    runMode,
    emergency,
  };
}

function normalizeOperatorCommandPayload(payload = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Command payload must be a JSON object");
  }

  for (const key of Object.keys(payload)) {
    if (!OPERATOR_COMMAND_KEYS.has(key)) {
      throw new Error(`Unsupported operator command field: ${key}`);
    }
  }

  const normalized = validateCommandMetadata(payload.command, payload);

  return {
    command: normalized.command,
    ...(normalized.runMode ? { runMode: normalized.runMode } : {}),
    ...(normalized.emergency ? { emergency: true } : {}),
  };
}

function normalizeQueuedCommandRecord(record = {}) {
  const normalized = validateCommandMetadata(record.command, record);

  return {
    command: normalized.command,
    commandId: record.commandId,
    source: record.source || "cli",
    ...(normalized.runMode ? { runMode: normalized.runMode } : {}),
    ...(normalized.emergency ? { emergency: true } : {}),
  };
}

module.exports = {
  OPERATOR_COMMAND_KEYS,
  OPERATOR_START_RUN_MODES,
  normalizeOperatorCommandPayload,
  normalizeQueuedCommandRecord,
  validateCommandMetadata,
};
