#!/usr/bin/env node

const readline = require("node:readline");
const { loadEnvFile } = require("../src/core/envFile");
const { createTelemetryReadModel } = require("../src/ops/telemetryReadModel");
const { renderContracts } = require("../src/cli/renderers/contracts");
const {
  contractKey,
  contractsSinceRun,
  engineRunBaselineMs,
  monitorColorEnabled,
  renderContractsMonitor,
} = require("../src/cli/renderers/contractsMonitor");

loadEnvFile();

function readOption(name, fallback = "") {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  return argv[index + 1] || fallback;
}

function hasFlag(name) {
  return process.argv.slice(2).includes(name);
}

function numberOption(name, fallback) {
  const parsed = Number.parseInt(readOption(name, String(fallback)), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function intervalMs() {
  const parsed = Number.parseInt(
    readOption("--interval", process.env.Q_GAGARIN_CONTRACTS_MONITOR_INTERVAL_MS || "1000"),
    10,
  );
  return Number.isFinite(parsed) ? Math.max(250, parsed) : 1000;
}

function liveScreenEnabled(output = process.stdout) {
  return output &&
    output.isTTY === true &&
    process.env.Q_GAGARIN_CONTRACTS_MONITOR !== "false" &&
    !hasFlag("--append");
}

function colorOption() {
  if (hasFlag("--no-color")) return "never";
  return readOption("--color", "");
}

async function readMonitorState(telemetry, baselineMs, options = {}) {
  const snapshot = await telemetry.snapshot();
  const effectiveBaselineMs = engineRunBaselineMs(snapshot, baselineMs);
  const result = await telemetry.logs({
    kind: "all",
    limit: options.logLimit,
    type: "cycle",
    from: effectiveBaselineMs ? new Date(effectiveBaselineMs).toISOString() : "",
  });

  return {
    snapshot,
    baselineMs: effectiveBaselineMs,
    logs: result.logs,
  };
}

async function main() {
  const telemetry = createTelemetryReadModel();
  const output = process.stdout;
  const monitorStartedAtMs = Date.now();
  const options = {
    logLimit: numberOption("--log-limit", 1000),
    maxRows: numberOption("--rows", 12),
    detailCount: numberOption("--details", 2),
    color: colorOption(),
  };
  let baselineMs = monitorStartedAtMs;
  let seenKeys = new Set();
  let stopped = false;

  async function renderLive() {
    const state = await readMonitorState(telemetry, baselineMs, options);
    if (state.baselineMs !== baselineMs) {
      baselineMs = state.baselineMs;
      seenKeys = new Set();
    }

    const text = renderContractsMonitor(state.snapshot, state.logs, {
      color: monitorColorEnabled(output, options),
      baselineMs,
      monitorStartedAtMs,
      maxRows: options.maxRows,
      detailCount: options.detailCount,
      nowMs: Date.now(),
    });

    readline.cursorTo(output, 0, 0);
    readline.clearScreenDown(output);
    output.write(`${text}\n`);
  }

  async function renderAppend() {
    const state = await readMonitorState(telemetry, baselineMs, options);
    if (state.baselineMs !== baselineMs) {
      baselineMs = state.baselineMs;
      seenKeys = new Set();
    }

    const contracts = contractsSinceRun(state.logs, baselineMs);
    const fresh = contracts.filter((row) => {
      const key = contractKey(row);
      if (seenKeys.has(key)) return false;
      seenKeys.add(key);
      return true;
    });

    if (fresh.length > 0) {
      output.write(`${renderContracts(fresh, {
        color: monitorColorEnabled(output, options),
      })}\n`);
    }
  }

  if (hasFlag("--once")) {
    const state = await readMonitorState(telemetry, baselineMs, options);
    output.write(`${renderContractsMonitor(state.snapshot, state.logs, {
      color: monitorColorEnabled(output, options),
      baselineMs: state.baselineMs,
      monitorStartedAtMs,
      maxRows: options.maxRows,
      detailCount: options.detailCount,
      nowMs: Date.now(),
    })}\n`);
    return;
  }

  const live = liveScreenEnabled(output);
  const render = live ? renderLive : renderAppend;
  await render();
  const timer = setInterval(() => {
    render().catch((error) => {
      if (live) {
        readline.cursorTo(output, 0, 0);
        readline.clearScreenDown(output);
      }
      output.write(`contracts monitor error: ${error.stack || error.message}\n`);
    });
  }, intervalMs());

  const shutdown = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    output.write("\n");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
