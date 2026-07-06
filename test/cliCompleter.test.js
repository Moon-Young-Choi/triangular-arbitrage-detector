const test = require("node:test");
const assert = require("node:assert/strict");
const {
  completeSlashCommand,
  renderSlashCommandSuggestions,
  suggestSlashCommand,
} = require("../src/cli/completer");

test("CLI completer completes slash command prefixes", () => {
  const [hits, target] = completeSlashCommand("/sta");

  assert.equal(target, "/sta");
  assert.deepEqual(hits, ["/status", "/start"]);
});

test("CLI completer completes subcommands and option values", () => {
  assert.deepEqual(completeSlashCommand("/start d"), [["dry"], "d"]);
  assert.deepEqual(completeSlashCommand("/logs --kind d"), [["decisions"], "d"]);

  const [deskOptions, deskTarget] = completeSlashCommand("/desk --st");
  assert.equal(deskTarget, "--st");
  assert.deepEqual(deskOptions, ["--start"]);
});

test("CLI completer suggests command descriptions for slash menu rendering", () => {
  const suggestions = suggestSlashCommand("/s");
  const rendered = renderSlashCommandSuggestions("/s");

  assert.ok(suggestions.some((item) => item.value === "/status"));
  assert.ok(suggestions.some((item) => item.value === "/strategy"));
  assert.match(rendered, /\/status\s+Show engine state/);
  assert.match(rendered, /\/start\s+Queue an engine Start command/);
});

