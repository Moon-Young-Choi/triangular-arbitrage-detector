const readline = require("node:readline");
const { parseSlashCommand } = require("./commandParser");
const {
  acceptSlashCommandSuggestion,
  completeSlashCommand,
  renderSlashCommandSuggestions,
  slashCommandSuggestionState,
} = require("./completer");
const { runCliCommand, renderStatus } = require("./commandRegistry");

function supportsCompletionPanel(input, output) {
  return input &&
    output &&
    input.isTTY === true &&
    output.isTTY === true &&
    process.env.Q_GAGARIN_COMPLETION_PANEL !== "false";
}

function completionColorEnabled(output) {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0") return true;
  return output && output.isTTY === true;
}

function installCompletionPanel(rl, input, output, options = {}) {
  let panelActive = false;
  let panelLineCount = 0;
  let selectedIndex = 0;
  const completionOptions = {
    limit: 8,
    strategyRegistry: options.strategyRegistry,
  };
  const originalTtyWrite = typeof rl._ttyWrite === "function" ? rl._ttyWrite : null;

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
    const state = slashCommandSuggestionState(line, {
      ...completionOptions,
      width: output.columns || 80,
    });

    if (state.entries.length === 0) {
      selectedIndex = 0;
    } else if (selectedIndex >= state.entries.length) {
      selectedIndex = state.entries.length - 1;
    }

    const panel = renderSlashCommandSuggestions(line, {
      ...completionOptions,
      color: completionColorEnabled(output),
      selectedIndex,
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

  function replaceInputLine(line) {
    rl.line = line;
    rl.cursor = line.length;
    selectedIndex = 0;
    redrawPanel();
  }

  function submitInputLine(line) {
    clearPanelFromCurrentLine();
    rl.line = "";
    rl.cursor = 0;
    output.write(`${rl.getPrompt()}${line}\n`);
    rl.emit("line", line);
  }

  function handlePanelKey(key = {}) {
    if (!panelActive) return false;

    const state = slashCommandSuggestionState(rl.line || "", completionOptions);
    if (state.entries.length === 0) return false;

    if (key.name === "up") {
      selectedIndex = (selectedIndex + state.entries.length - 1) % state.entries.length;
      redrawPanel();
      return true;
    }

    if (key.name === "down") {
      selectedIndex = (selectedIndex + 1) % state.entries.length;
      redrawPanel();
      return true;
    }

    if (key.name === "return" || key.name === "enter") {
      const accepted = acceptSlashCommandSuggestion(rl.line || "", selectedIndex, completionOptions);
      if (!accepted) return false;
      if (accepted.execute) {
        submitInputLine(accepted.line);
      } else {
        replaceInputLine(accepted.line);
      }
      return true;
    }

    return false;
  }

  function scheduleRedraw(_, key = {}) {
    if (["up", "down", "return", "enter"].includes(key.name)) return;
    selectedIndex = 0;
    setImmediate(redrawPanel);
  }

  if (originalTtyWrite) {
    rl._ttyWrite = function patchedTtyWrite(sequence, key) {
      if (handlePanelKey(key || {})) return;
      return originalTtyWrite.call(this, sequence, key);
    };
  }

  readline.emitKeypressEvents(input, rl);
  input.on("keypress", scheduleRedraw);

  rl.on("line", clearPanelFromCurrentLine);
  rl.on("close", () => {
    input.off("keypress", scheduleRedraw);
    if (originalTtyWrite && rl._ttyWrite) {
      rl._ttyWrite = originalTtyWrite;
    }
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
    completer: (line) => completeSlashCommand(line, {
      strategyRegistry: context.strategyRegistry,
    }),
  });

  if (supportsCompletionPanel(input, output)) {
    installCompletionPanel(rl, input, output, {
      strategyRegistry: context.strategyRegistry,
    });
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
