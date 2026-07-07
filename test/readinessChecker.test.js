const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { AppendOnlyLogStore } = require("../src/core/appendOnlyLog");
const { DEFAULT_RUNTIME_CONFIG } = require("../src/core/runtimeConfig");
const {
  checkRealRunReadiness,
  dryRunAuditEvidence,
} = require("../src/core/readinessChecker");

function restoreEnv(name, previousValue) {
  if (previousValue === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previousValue;
  }
}

async function createLogStore(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const logStore = new AppendOnlyLogStore({ logDir: dir });
  await logStore.ensureFiles();
  return logStore;
}

function realReadySnapshot() {
  return {
    feedStatus: {
      observation: { openConnectionCount: 1 },
      validation: { openConnectionCount: 1 },
    },
    orderbookStores: {
      validation: { staleCount: 0 },
    },
    privateWsStatus: { status: "open" },
    orderChanceFresh: true,
    accountBalanceFresh: true,
  };
}

test("readiness checker explains failed real-run gates", async () => {
  const logStore = await createLogStore("q-gagarin-readiness-");
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
  assert.equal(readiness.score.total, readiness.items.length);
  assert.equal(readiness.score.failed, readiness.items.filter((item) => !item.passed).length);
  assert.equal(readiness.items.some((item) => item.id === "live-trading-enabled" && item.passed === false), true);
  assert.equal(readiness.items.some((item) => item.id === "private-ws-connected" && item.passed === false), true);
  assert.equal(readiness.items.some((item) => item.id.startsWith("dry-run")), false);
});

test("readiness checker ignores dry-run evidence for real-run gates", async () => {
  const logStore = await createLogStore("q-gagarin-readiness-dryrun-");
  const previousAccessKey = process.env.UPBIT_ACCESS_KEY;
  const previousSecretKey = process.env.UPBIT_SECRET_KEY;

  await logStore.append("decisions", {
    type: "strategy-decision",
    mode: "DRY_RUN",
    accepted: true,
    startAsset: "USDT",
    strategyId: "depthAwareLimitIoc",
    cycleId: "cycle-usdt",
    expectedNetProfit: 10,
  });
  await logStore.append("events", {
    type: "cycle.simulated_fail",
    mode: "DRY_RUN",
    engineState: "RUNNING",
    startAsset: "USDT",
    strategyId: "depthAwareLimitIoc",
    cycleId: "cycle-usdt",
    expectedNetProfit: 10,
    reason: "DEPTH_INSUFFICIENT",
  });

  process.env.UPBIT_ACCESS_KEY = "test-access";
  process.env.UPBIT_SECRET_KEY = "test-secret";

  try {
    const readiness = await checkRealRunReadiness({
      runtimeConfig: {
        ...DEFAULT_RUNTIME_CONFIG,
        runMode: "REAL_GUARDED",
        liveTradingEnabled: true,
      },
      engineSnapshot: realReadySnapshot(),
      restPermissions: { errors: [] },
      logStore,
      minimumDryRunSamples: 1000,
      minimumDryRunSamplesPerStartAsset: 1000,
      minimumDryRunCompleteRate: 1,
      maxDryRunDepthRejectionRate: 0,
      maxDryRunLatencyRejectionRate: 0,
      maxDryRunExpectedSimulatedGapRate: 0,
    });

    assert.equal(readiness.passed, true);
    assert.equal(readiness.score.failed, 0);
    assert.equal(readiness.items.some((item) => item.id.startsWith("dry-run")), false);
    assert.equal(readiness.dryRunSummary, undefined);
    assert.equal(readiness.dryRunStartAssetSummaries, undefined);
  } finally {
    restoreEnv("UPBIT_ACCESS_KEY", previousAccessKey);
    restoreEnv("UPBIT_SECRET_KEY", previousSecretKey);
  }
});

test("readiness checker still blocks missing real-run dependencies", async () => {
  const logStore = await createLogStore("q-gagarin-readiness-real-gates-");
  const previousAccessKey = process.env.UPBIT_ACCESS_KEY;
  const previousSecretKey = process.env.UPBIT_SECRET_KEY;

  process.env.UPBIT_ACCESS_KEY = "test-access";
  process.env.UPBIT_SECRET_KEY = "test-secret";

  try {
    const readiness = await checkRealRunReadiness({
      runtimeConfig: {
        ...DEFAULT_RUNTIME_CONFIG,
        runMode: "REAL_GUARDED",
        liveTradingEnabled: true,
      },
      engineSnapshot: {
        ...realReadySnapshot(),
        privateWsStatus: { status: "not_configured" },
        accountBalanceFresh: false,
      },
      restPermissions: { errors: [] },
      logStore,
    });

    assert.equal(readiness.passed, false);
    assert.equal(readiness.items.some((item) => item.id === "private-ws-connected" && item.passed === false), true);
    assert.equal(readiness.items.some((item) => item.id === "account-balance-fresh" && item.passed === false), true);
  } finally {
    restoreEnv("UPBIT_ACCESS_KEY", previousAccessKey);
    restoreEnv("UPBIT_SECRET_KEY", previousSecretKey);
  }
});

test("dry-run audit evidence remains available for reports", () => {
  const audit = dryRunAuditEvidence([
    {
      type: "cycle.done",
      auditSchema: { ok: true },
    },
    {
      type: "cycle.done",
      cycleId: "cycle-b",
      auditSchema: { ok: false, missingRequiredFields: ["engineState"] },
    },
  ]);

  assert.equal(audit.totalRows, 2);
  assert.equal(audit.validRows.length, 1);
  assert.equal(audit.invalidCount, 1);
  assert.deepEqual(audit.invalidExamples[0].missingRequiredFields, ["engineState"]);
});
