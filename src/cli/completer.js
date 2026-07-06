const { COMMANDS } = require("./commandRegistry");

const COMMAND_NAMES = COMMANDS.map(([command]) => command.split(" ")[0]);

function completeSlashCommand(line = "") {
  const input = String(line || "");
  const token = input.trimStart().split(/\s+/)[0] || "";
  const hits = COMMAND_NAMES.filter((command) => command.startsWith(token));

  return [hits.length > 0 ? hits : COMMAND_NAMES, token];
}

module.exports = {
  COMMAND_NAMES,
  completeSlashCommand,
};
