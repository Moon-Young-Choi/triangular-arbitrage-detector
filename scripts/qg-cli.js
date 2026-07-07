#!/usr/bin/env node

const { loadEnvFile } = require("../src/core/envFile");
const { runCli } = require("../src/cli");

loadEnvFile();

runCli(process.argv.slice(2)).catch((error) => {
  console.error(`error: ${error.message}`);
  process.exitCode = 1;
});
