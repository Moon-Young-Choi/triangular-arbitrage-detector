const DEFAULT_EXECUTION_MODE = "LIMIT_IOC_AT_OBSERVED_BEST";
const BEST_IOC_EXECUTION_MODE = "BEST_IOC";
const EXECUTION_MODE_IDS = Object.freeze([
  DEFAULT_EXECUTION_MODE,
  BEST_IOC_EXECUTION_MODE,
]);
const EXECUTION_MODE_SET = new Set(EXECUTION_MODE_IDS);

function normalizeExecutionMode(value = DEFAULT_EXECUTION_MODE) {
  const mode = value || DEFAULT_EXECUTION_MODE;

  if (!EXECUTION_MODE_SET.has(mode)) {
    throw new Error(`Invalid execution mode: ${mode}`);
  }

  return mode;
}

function normalizeEnabledExecutionModes(value = [DEFAULT_EXECUTION_MODE]) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("enabledExecutionModes must be a non-empty array");
  }

  return value.map(normalizeExecutionMode);
}

function assertExecutionModeEnabled(mode, enabledModes = [DEFAULT_EXECUTION_MODE]) {
  const normalizedMode = normalizeExecutionMode(mode);
  const enabled = normalizeEnabledExecutionModes(enabledModes);

  if (!enabled.includes(normalizedMode)) {
    throw new Error(`${normalizedMode} requires explicit enabledExecutionModes opt-in`);
  }

  return normalizedMode;
}

function orderKindForExecutionMode(mode) {
  return normalizeExecutionMode(mode) === BEST_IOC_EXECUTION_MODE ? "best" : "limit";
}

module.exports = {
  BEST_IOC_EXECUTION_MODE,
  DEFAULT_EXECUTION_MODE,
  EXECUTION_MODE_IDS,
  EXECUTION_MODE_SET,
  assertExecutionModeEnabled,
  normalizeEnabledExecutionModes,
  normalizeExecutionMode,
  orderKindForExecutionMode,
};
