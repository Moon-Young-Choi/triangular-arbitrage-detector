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
  assert.equal(readiness.score.total, readiness.items.length);
  assert.equal(readiness.score.failed, readiness.items.filter((item) => !item.passed).length);
  assert.equal(readiness.items.some((item) => item.id === "live-trading-enabled" && item.passed === false), true);
  assert.equal(readiness.items.some((item) => item.id === "private-ws-connected" && item.passed === false), true);
});

test("readiness checker blocks real run on weak dry-run evidence", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "q-gagarin-readiness-dryrun-"));
  const logStore = new AppendOnlyLogStore({ logDir: dir });
  const previousAccessKey = process.env.UPBIT_ACCESS_KEY;
  const previousSecretKey = process.env.UPBIT_SECRET_KEY;

  await logStore.ensureFiles();
  await logStore.append("decisions", {
    type: "strategy-decision",
    mode: "DRY_RUN",
    accepted: true,
    startAsset: "KRW",
    strategyId: "depthAwareLimitIoc",
    cycleId: "cycle-a",
    expectedNetProfit: 10,
  });
  await logStore.append("decisions", {
    type: "strategy-decision",
    mode: "DRY_RUN",
    accepted: true,
    startAsset: "KRW",
    strategyId: "depthAwareLimitIoc",
    cycleId: "cycle-b",
    expectedNetProfit: 10,
  });
  await logStore.append("events", {
    type: "cycle.simulated_done",
    mode: "DRY_RUN",
    engineState: "RUNNING",
    startAsset: "KRW",
    strategyId: "depthAwareLimitIoc",
    cycleId: "cycle-a",
    expectedNetProfit: 10,
    pnl: 9,
  });
  await logStore.append("events", {
    type: "cycle.simulated_fail",
    mode: "DRY_RUN",
    engineState: "RUNNING",
    startAsset: "KRW",
    strategyId: "depthAwareLimitIoc",
    cycleId: "cycle-b",
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
      engineSnapshot: {
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
      },
      restPermissions: { errors: [] },
      logStore,
      minimumDryRunSamples: 2,
      minimumDryRunCompleteRate: 0.75,
      maxDryRunDepthRejectionRate: 0.25,
      maxDryRunLatencyRejectionRate: 0.25,
      maxDryRunExpectedSimulatedGapRate: 0.25,
    });

    assert.equal(readiness.passed, false);
    assert.equal(readiness.dryRunSummary.simulatedCompleteRate, 0.5);
    assert.equal(readiness.dryRunSummary.depthRejectionRate, 0.5);
    assert.equal(
      readiness.items.some((item) => item.id === "dry-run-complete-rate" && item.passed === false),
      true,
    );
    assert.equal(
      readiness.items.some((item) => item.id === "dry-run-depth-rejection-rate" && item.passed === false),
      true,
    );
  } finally {
    if (previousAccessKey === undefined) {
      delete process.env.UPBIT_ACCESS_KEY;
    } else {
      process.env.UPBIT_ACCESS_KEY = previousAccessKey;
    }

    if (previousSecretKey === undefined) {
      delete process.env.UPBIT_SECRET_KEY;
    } else {
      process.env.UPBIT_SECRET_KEY = previousSecretKey;
    }
  }
});

test("readiness checker requires dry-run evidence for every enabled start asset", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "q-gagarin-readiness-start-assets-"));
  const logStore = new AppendOnlyLogStore({ logDir: dir });
  const previousAccessKey = process.env.UPBIT_ACCESS_KEY;
  const previousSecretKey = process.env.UPBIT_SECRET_KEY;

  await logStore.ensureFiles();
  await logStore.append("decisions", {
    type: "strategy-decision",
    mode: "DRY_RUN",
    accepted: true,
    startAsset: "KRW",
    strategyId: "depthAwareLimitIoc",
    cycleId: "cycle-krw",
    expectedNetProfit: 10,
  });
  await logStore.append("decisions", {
    type: "strategy-decision",
    mode: "DRY_RUN",
    accepted: true,
    startAsset: "BTC",
    strategyId: "depthAwareLimitIoc",
    cycleId: "cycle-btc",
    expectedNetProfit: 10,
  });
  await logStore.append("events", {
    type: "cycle.simulated_done",
    mode: "DRY_RUN",
    engineState: "RUNNING",
    startAsset: "KRW",
    strategyId: "depthAwareLimitIoc",
    cycleId: "cycle-krw",
    expectedNetProfit: 10,
    pnl: 9,
  });

  process.env.UPBIT_ACCESS_KEY = "test-access";
  process.env.UPBIT_SECRET_KEY = "test-secret";

  try {
    const readiness = await checkRealRunReadiness({
      runtimeConfig: {
        ...DEFAULT_RUNTIME_CONFIG,
        runMode: "REAL_GUARDED",
        liveTradingEnabled: true,
        enabledStartAssets: ["KRW", "BTC"],
      },
      engineSnapshot: {
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
      },
      restPermissions: { errors: [] },
      logStore,
      minimumDryRunSamples: 2,
      minimumDryRunSamplesPerStartAsset: 1,
      minimumDryRunCompleteRate: 0.75,
      maxDryRunDepthRejectionRate: 0.25,
      maxDryRunLatencyRejectionRate: 0.25,
      maxDryRunExpectedSimulatedGapRate: 0.25,
    });

    assert.equal(readiness.passed, false);
    assert.equal(readiness.score.total, readiness.items.length);
    assert.equal(readiness.score.failed, readiness.items.filter((item) => !item.passed).length);
    assert.equal(readiness.dryRunSummary.totalOpportunities, 2);
    assert.equal(readiness.dryRunSummary.simulatedCompleteRate, 1);
    assert.equal(readiness.dryRunStartAssetSummaries.KRW.simulatedAttemptCycles, 1);
    assert.equal(readiness.dryRunStartAssetSummaries.BTC.totalOpportunities, 1);
    assert.equal(readiness.dryRunStartAssetSummaries.BTC.simulatedAttemptCycles, 0);
    assert.equal(
      readiness.items.some((item) => item.id === "dry-run-start-asset-attempts-BTC" && item.passed === false),
      true,
    );
    assert.equal(
      readiness.items.some((item) => item.id === "dry-run-start-asset-complete-rate-BTC" && item.passed === false),
      true,
    );
    assert.equal(
      readiness.items.some((item) => item.id === "dry-run-complete-rate" && item.passed === true),
      true,
    );
  } finally {
    if (previousAccessKey === undefined) {
      delete process.env.UPBIT_ACCESS_KEY;
    } else {
      process.env.UPBIT_ACCESS_KEY = previousAccessKey;
    }

    if (previousSecretKey === undefined) {
      delete process.env.UPBIT_SECRET_KEY;
    } else {
      process.env.UPBIT_SECRET_KEY = previousSecretKey;
    }
  }
});

test("readiness checker refuses schema-incomplete dry-run evidence", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "q-gagarin-readiness-audit-schema-"));
  const logStore = new AppendOnlyLogStore({ logDir: dir });
  const previousAccessKey = process.env.UPBIT_ACCESS_KEY;
  const previousSecretKey = process.env.UPBIT_SECRET_KEY;

  await logStore.ensureFiles();
  await logStore.append("decisions", {
    type: "strategy-decision",
    mode: "DRY_RUN",
    accepted: true,
    startAsset: "KRW",
    strategyId: "depthAwareLimitIoc",
    cycleId: "cycle-complete",
    expectedNetProfit: 10,
  });
  await logStore.append("events", {
    type: "cycle.done",
    mode: "DRY_RUN",
    startAsset: "KRW",
    strategyId: "depthAwareLimitIoc",
    cycleId: "cycle-complete",
    expectedNetProfit: 10,
    pnl: 9,
  });

  process.env.UPBIT_ACCESS_KEY = "test-access";
  process.env.UPBIT_SECRET_KEY = "test-secret";

  try {
    const readiness = await checkRealRunReadiness({
      runtimeConfig: {
        ...DEFAULT_RUNTIME_CONFIG,
        runMode: "REAL_GUARDED",
        liveTradingEnabled: true,
        enabledStartAssets: ["KRW"],
      },
      engineSnapshot: {
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
      },
      restPermissions: { errors: [] },
      logStore,
      minimumDryRunSamples: 1,
      minimumDryRunSamplesPerStartAsset: 1,
      minimumDryRunCompleteRate: 0.5,
      maxDryRunDepthRejectionRate: 1,
      maxDryRunLatencyRejectionRate: 1,
      maxDryRunExpectedSimulatedGapRate: 1,
    });
    const auditItem = readiness.items.find((item) => item.id === "dry-run-audit-schema-complete");

    assert.equal(readiness.passed, false);
    assert.equal(auditItem.passed, false);
    assert.equal(auditItem.invalidCount, 1);
    assert.deepEqual(auditItem.invalidExamples[0].missingRequiredFields, ["engineState"]);
    assert.equal(readiness.dryRunAudit.totalRows, 2);
    assert.equal(readiness.dryRunAudit.invalidCount, 1);
    assert.equal(readiness.dryRunSummary.totalOpportunities, 1);
    assert.equal(readiness.dryRunSummary.simulatedCompleteCycles, 0);
  } finally {
    if (previousAccessKey === undefined) {
      delete process.env.UPBIT_ACCESS_KEY;
    } else {
      process.env.UPBIT_ACCESS_KEY = previousAccessKey;
    }

    if (previousSecretKey === undefined) {
      delete process.env.UPBIT_SECRET_KEY;
    } else {
      process.env.UPBIT_SECRET_KEY = previousSecretKey;
    }
  }
});
