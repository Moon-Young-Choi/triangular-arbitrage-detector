const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { AppendOnlyLogStore } = require("../src/core/appendOnlyLog");
const { DEFAULT_RUNTIME_CONFIG } = require("../src/core/runtimeConfig");
const { checkRealRunReadiness } = require("../src/core/readinessChecker");

test("readiness checker explains failed real-run gates", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "q-gagarin-readiness-"));
  const logStore = new AppendOnlyLogStore({ logDir: dir });
  await logStore.ensureFiles();
  const readiness = await checkRealRunReadiness({
    runtimeConfig: DEFAULT_RUNTIME_CONFIG,
    engineSnapshot: {
      feedStatus: {},
      orderbookStores: {},
      privateWsStatus: { status: "not_configured" },
    },
    logStore,
    minimumDryRunSamples: 1,
  });

  assert.equal(readiness.passed, false);
  assert.equal(readiness.items.some((item) => item.id === "live-trading-enabled" && item.passed === false), true);
  assert.equal(readiness.items.some((item) => item.id === "private-ws-connected" && item.passed === false), true);
});
