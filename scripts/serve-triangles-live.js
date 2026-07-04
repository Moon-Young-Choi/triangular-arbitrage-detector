#!/usr/bin/env node

const { startLiveServer } = require("../src/live/server");

async function main() {
  const liveServer = await startLiveServer();

  console.log(`Live Upbit triangle dashboard: ${liveServer.url}`);
  console.log("Press Ctrl+C to stop.");

  const shutdown = async () => {
    try {
      await liveServer.close();
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
