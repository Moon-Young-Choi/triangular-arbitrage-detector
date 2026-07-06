const { parseSlashCommand } = require("./commandParser");
const { createCliContext, runCliCommand } = require("./commandRegistry");
const { startInteractiveShell } = require("./interactiveShell");

async function runCli(argv = process.argv.slice(2), options = {}) {
  const context = createCliContext(options);

  if (argv.length > 0) {
    const parsed = parseSlashCommand(argv.join(" "));
    await runCliCommand(parsed, context);
    return;
  }

  await startInteractiveShell(context);
}

module.exports = {
  createCliContext,
  parseSlashCommand,
  runCli,
  runCliCommand,
  startInteractiveShell,
};
