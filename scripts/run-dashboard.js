#!/usr/bin/env node

const { startDashboardServer } = require("../src/live/dashboardServer");

async function main() {
  const dashboard = await startDashboardServer();

  console.log(`q-gagarin dashboard: ${dashboard.url}`);
  console.log("Press Ctrl+C to stop.");

  const shutdown = async () => {
    try {
      await dashboard.close();
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
