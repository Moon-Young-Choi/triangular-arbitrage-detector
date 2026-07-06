#!/usr/bin/env node

process.stderr.write([
  "q-gagarin browser operation is deprecated.",
  "Use terminal operation instead:",
  "  npm run engine",
  "  npm run cli",
  "",
].join("\n"));
process.exitCode = 1;
