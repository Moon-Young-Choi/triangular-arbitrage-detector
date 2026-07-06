const readline = require("node:readline");
const { parseSlashCommand } = require("./commandParser");
const {
  completeSlashCommand,
  renderSlashCommandSuggestions,
} = require("./completer");
const { runCliCommand, renderStatus } = require("./commandRegistry");

function supportsCompletionPanel(input, output) {
  return input &&
    output &&
    input.isTTY === true &&
    output.isTTY === true &&
    process.env.Q_GAGARIN_COMPLETION_PANEL !== "false";
}

function installCompletionPanel(rl, input, output) {
  let panelActive = false;
  let panelLineCount = 0;

  function clearPanelFromCurrentLine() {
    if (!panelActive) return;
    readline.cursorTo(output, 0);
    readline.clearScreenDown(output);
    panelActive = false;
    panelLineCount = 0;
  }

  function redrawPanel() {
    const line = rl.line || "";
    const cursor = Number.isInteger(rl.cursor) ? rl.cursor : line.length;
    const panel = renderSlashCommandSuggestions(line, {
      limit: 8,
      width: output.columns || 80,
    });
    const panelLines = panel ? panel.split("\n").length : 0;

    readline.cursorTo(output, 0);
    readline.clearScreenDown(output);
    output.write(`${rl.getPrompt()}${line}`);

    if (panel) {
      output.write(`\n${panel}`);
      readline.moveCursor(output, 0, -panelLines);
      panelActive = true;
      panelLineCount = panelLines;
    } else {
      panelActive = false;
      panelLineCount = 0;
    }

    readline.cursorTo(output, rl.getPrompt().length + cursor);
  }

  function scheduleRedraw(_, key = {}) {
    if (key.name === "return" || key.name === "enter") return;
    setImmediate(redrawPanel);
  }

  readline.emitKeypressEvents(input, rl);
  input.on("keypress", scheduleRedraw);

  rl.on("line", clearPanelFromCurrentLine);
  rl.on("close", () => {
    input.off("keypress", scheduleRedraw);
    if (panelLineCount > 0) {
      clearPanelFromCurrentLine();
    }
  });
}

async function startInteractiveShell(context) {
  const input = context.input || process.stdin;
  const output = context.output;
  const snapshot = await context.telemetry.snapshot();
  output.write([
    "q-gagarin CLI",
    "",
    renderStatus(snapshot),
    "",
    "Type /help for commands. Use Tab or slash suggestions to complete commands.",
  ].join("\n"));
  output.write("\n");

  const rl = readline.createInterface({
    input,
    output,
    prompt: "qg> ",
    completer: completeSlashCommand,
  });

  if (supportsCompletionPanel(input, output)) {
    installCompletionPanel(rl, input, output);
  }

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
