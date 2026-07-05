#!/usr/bin/env node

const { startEngineRuntime } = require("../src/engine/engineRuntime");

async function main() {
  const runtime = await startEngineRuntime({
    autoStart: process.env.ENGINE_AUTO_START !== "0",
  });

  console.log(`q-gagarin engine running. pid=${process.pid}`);
  console.log(`Snapshot: ${runtime.snapshotPath}`);
  console.log("Press Ctrl+C to stop.");

  const shutdown = async () => {
    try {
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
