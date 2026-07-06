const test = require("node:test");
const assert = require("node:assert/strict");
const { parseSlashCommand, splitCommandLine } = require("../src/cli/commandParser");
const { modeFromStartArg } = require("../src/cli/commandRegistry");

test("CLI parser accepts slash commands and structured options only", () => {
  assert.deepEqual(splitCommandLine('/logs --kind orders --cycle "KRW-BTC-ETH"'), [
    "/logs",
    "--kind",
    "orders",
    "--cycle",
    "KRW-BTC-ETH",
  ]);

  const parsed = parseSlashCommand("/desk --start KRW --top=20 --profitable");

  assert.equal(parsed.name, "desk");
  assert.deepEqual(parsed.args, []);
  assert.deepEqual(parsed.options, {
    start: "KRW",
    top: "20",
    profitable: true,
  });
});

test("CLI parser rejects non-slash natural language", () => {
  assert.throws(
    () => parseSlashCommand("거래 시작해줘"),
    /accepts slash commands only/,
  );
});

test("start mode aliases map to engine run modes and reject REAL_AUTO", () => {
  assert.equal(modeFromStartArg("observe"), "OBSERVE");
  assert.equal(modeFromStartArg("dry"), "DRY_RUN");
  assert.equal(modeFromStartArg("real-guarded"), "REAL_GUARDED");
  assert.throws(() => modeFromStartArg("real-auto"), /Unsupported start mode/);
});
