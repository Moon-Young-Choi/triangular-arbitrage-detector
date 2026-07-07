#!/usr/bin/env node

const readline = require("node:readline");
const { startEngineRuntime } = require("../src/engine/engineRuntime");
const {
  dashboardColorEnabled,
  renderEngineDashboard,
} = require("../src/cli/renderers/engineDashboard");

function dashboardEnabled(output = process.stdout) {
  return output &&
    output.isTTY === true &&
    process.env.Q_GAGARIN_ENGINE_DASHBOARD !== "false";
}

function dashboardIntervalMs() {
  const parsed = Number.parseInt(process.env.Q_GAGARIN_ENGINE_DASHBOARD_INTERVAL_MS || "1000", 10);
  return Number.isFinite(parsed) ? Math.max(250, parsed) : 1000;
}

function startDashboard(runtime, output = process.stdout) {
  let stopped = false;
  const useAlternateScreen = output && output.isTTY === true && process.env.Q_GAGARIN_ENGINE_ALT_SCREEN !== "false";

  if (useAlternateScreen) {
    output.write("\x1b[?1049h\x1b[?25l");
  }

  function render() {
    if (stopped) return;

    let text;
    try {
      text = renderEngineDashboard(runtime.snapshot(), {
        color: dashboardColorEnabled(output),
        nowMs: Date.now(),
        snapshotPath: runtime.snapshotPath,
      });
    } catch (error) {
      text = [
        "q-gagarin engine",
        "",
        `Dashboard error: ${error.message}`,
        "",
        `Snapshot: ${runtime.snapshotPath}`,
        "Press Ctrl+C to stop.",
      ].join("\n");
    }

    readline.cursorTo(output, 0, 0);
    readline.clearScreenDown(output);
    output.write(`${text}\n`);
  }

  render();
  const timer = setInterval(render, dashboardIntervalMs());

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
      if (useAlternateScreen) {
        output.write("\x1b[?25h\x1b[?1049l");
      } else {
        output.write("\n");
      }
    },
  };
}

async function main() {
  const runtime = await startEngineRuntime({
    autoStart: process.env.ENGINE_AUTO_START !== "0",
  });
  const dashboard = dashboardEnabled(process.stdout)
    ? startDashboard(runtime, process.stdout)
    : null;

  if (!dashboard) {
    console.log(`q-gagarin engine running. pid=${process.pid}`);
    console.log(`Snapshot: ${runtime.snapshotPath}`);
    console.log("Press Ctrl+C to stop.");
  }

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;

    try {
      if (dashboard) dashboard.stop();
      await runtime.stop();
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
