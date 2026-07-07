const test = require("node:test");
const assert = require("node:assert/strict");
const {
  acceptSlashCommandSuggestion,
  completeSlashCommand,
  renderSlashCommandSuggestions,
  slashCommandSuggestionState,
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
  assert.equal(
    slashCommandSuggestionState("/pocket transfer sub-to-main BTC ").entries.some((entry) => (
      entry.value === "10000" || entry.value === "30000"
    )),
    false,
  );

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

test("CLI completer accepts selected slash suggestions", () => {
  const accepted = acceptSlashCommandSuggestion("/sta", "/start");

  assert.equal(accepted.line, "/start ");
  assert.equal(accepted.execute, false);

  const dry = acceptSlashCommandSuggestion("/start d", "dry");
  assert.equal(dry.line, "/start dry");
  assert.equal(dry.execute, true);
});

test("CLI completer selects strategies from registry", () => {
  const strategyRegistry = {
    list: () => [
      { id: "sampleStrategy", description: "sample strategy" },
      { id: "bestLevelResidualIoc", description: "best level residual" },
    ],
  };
  const state = slashCommandSuggestionState("/strategy select b", { strategyRegistry });

  assert.deepEqual(state.entries.map((item) => item.value), ["bestLevelResidualIoc"]);
  assert.deepEqual(
    slashCommandSuggestionState("/strategy select ", { strategyRegistry }).entries.map((item) => item.value),
    ["sampleStrategy", "bestLevelResidualIoc"],
  );

  const accepted = acceptSlashCommandSuggestion("/strategy select b", 0, { strategyRegistry });
  assert.equal(accepted.line, "/strategy select bestLevelResidualIoc");
  assert.equal(accepted.execute, true);
});

test("CLI completer marks selected slash menu row", () => {
  const rendered = renderSlashCommandSuggestions("/s", { selectedIndex: 1 });

  assert.match(rendered, /^> \/summary/m);
});
