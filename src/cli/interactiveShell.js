const readline = require("node:readline");
const { parseSlashCommand } = require("./commandParser");
const { completeSlashCommand } = require("./completer");
const { runCliCommand, renderStatus } = require("./commandRegistry");

async function startInteractiveShell(context) {
  const snapshot = await context.telemetry.snapshot();
  context.output.write([
    "q-gagarin CLI",
    "",
    renderStatus(snapshot),
    "",
    "Type /help for commands.",
  ].join("\n"));
  context.output.write("\n");

  const rl = readline.createInterface({
    input: process.stdin,
    output: context.output,
    prompt: "qg> ",
    completer: completeSlashCommand,
  });

  rl.prompt();

  rl.on("line", async (line) => {
    try {
      const parsed = parseSlashCommand(line);
      const result = await runCliCommand(parsed, context);

      if (result && result.exit) {
        rl.close();
        return;
      }
    } catch (error) {
      context.errorOutput.write(`error: ${error.message}\n`);
    }

    rl.prompt();
  });

  return new Promise((resolve) => {
    rl.on("close", () => {
      context.output.write("\n");
      resolve();
    });
  });
}

module.exports = {
  startInteractiveShell,
};
