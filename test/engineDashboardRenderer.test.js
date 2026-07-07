const test = require("node:test");
const assert = require("node:assert/strict");
const { renderEngineDashboard } = require("../src/cli/renderers/engineDashboard");
const { stripAnsi } = require("../src/cli/renderers/table");

function sampleSnapshot() {
  return {
    engineState: "RUNNING",
    lastCalculatedAt: "2026-07-07T01:00:00.000Z",
    runtimeConfig: {
      runMode: "DRY_RUN",
      liveTradingEnabled: false,
      activeStrategyId: "bestLevelResidualIoc",
      exchange: "upbit",
      observationOrderbookUnit: 5,
      validationOrderbookUnit: 30,
    },
    engineProcess: {
      pid: 1234,
      snapshotPath: "out/runtime/latest-snapshot.json",
    },
    summary: {
      marketsLoaded: 220,
      uniqueTriangleCount: 120,
      plottedCycleCount: 240,
      availableLiveMultipliers: 42,
      lastUpdateTime: "2026-07-07T01:00:01.000Z",
      cycleScheduler: {
        completedCycleCount: 10,
        totalCycleCount: 20,
        pendingCycleCount: 3,
      },
    },
    wsStatus: {
      status: "open",
      openConnectionCount: 2,
    },
    validationWsStatus: {
      status: "open",
      openConnectionCount: 1,
    },
    privateWsStatus: {
      status: "not_configured",
    },
    readiness: {
      passed: false,
      score: {
        passed: 4,
        failed: 1,
        total: 5,
      },
    },
    guardStatus: {
      healthy: true,
      openOrderCount: 0,
      activeRealExecutionCount: 0,
    },
    emergencyStop: {
      active: false,
    },
    execution: {
      dryRunCapital: {
        buckets: {
          KRW: { availableBalance: 1000000 },
          BTC: { availableBalance: 0.05 },
          USDT: { availableBalance: 1000 },
        },
      },
    },
  };
}

test("engine dashboard renders current runtime status", () => {
  const rendered = renderEngineDashboard(sampleSnapshot(), {
    color: false,
    nowMs: Date.parse("2026-07-07T01:00:02.000Z"),
  });

  assert.match(rendered, /q-gagarin engine/);
  assert.match(rendered, /Engine\s+RUNNING/);
  assert.match(rendered, /Mode\s+DRY_RUN/);
  assert.match(rendered, /Strategy\s+bestLevelResidualIoc/);
  assert.match(rendered, /Warm-up\s+10\/20/);
  assert.match(rendered, /Readiness\s+4\/5/);
  assert.match(rendered, /Dry-run simulated available/);
  assert.match(rendered, /KRW\s+1000000.00/);
  assert.match(rendered, /Snapshot: out\/runtime\/latest-snapshot\.json/);
});

test("engine dashboard can color status values", () => {
  const rendered = renderEngineDashboard(sampleSnapshot(), {
    color: true,
    nowMs: Date.parse("2026-07-07T01:00:02.000Z"),
  });

  assert.match(rendered, /\x1b\[/);
  assert.match(stripAnsi(rendered), /Mode\s+DRY_RUN/);
});

test("engine dashboard labels real balances and unavailable real balance snapshots", () => {
  const snapshot = sampleSnapshot();
  snapshot.runtimeConfig.runMode = "REAL_GUARDED";
  snapshot.runtimeConfig.liveTradingEnabled = true;
  snapshot.execution = {
    realBalances: {
      availableBalances: {
        KRW: 0,
      },
    },
  };

  const rendered = renderEngineDashboard(snapshot, {
    color: false,
    nowMs: Date.parse("2026-07-07T01:00:02.000Z"),
  });

  assert.match(rendered, /Real Upbit available/);
  assert.match(rendered, /KRW\s+0.00/);

  snapshot.execution = {
    realBalances: {
      availableBalances: {},
    },
  };

  const unavailable = renderEngineDashboard(snapshot, {
    color: false,
    nowMs: Date.parse("2026-07-07T01:00:02.000Z"),
  });

  assert.match(unavailable, /Real Upbit balance unavailable/);
});

test("engine dashboard renders preparation and Upbit queue progress", () => {
  const snapshot = sampleSnapshot();
  snapshot.engineState = "PREPARING";
  snapshot.preparation = {
    phase: "freshness-gate",
    progress: {
      requiredMarketCount: 729,
      restOrderbookFetched: 700,
      restOrderbookRequested: 729,
      restOrderbookPercent: 96,
      observationMarketCount: 720,
      validationMarketCount: 718,
      observationCoverageRatio: 0.987,
      validationCoverageRatio: 0.985,
      observationStaleCount: 12,
      validationStaleCount: 14,
      observationWsConfirmedCount: 690,
      validationWsConfirmedCount: 688,
      observationRestOnlyCount: 30,
      validationRestOnlyCount: 30,
      observationQuietCount: 12,
      validationQuietCount: 14,
      wsOpenConnections: 16,
      wsConnectionCount: 16,
    },
    blockers: ["WS_CONNECTION_NO_MESSAGES"],
  };
  snapshot.rateLimit = {
    groups: {
      orderbook: {
        queued: 4,
        inFlight: 1,
        remainingSec: 5,
      },
      order: {
        queued: 0,
        inFlight: 0,
        remainingSec: 8,
      },
      "websocket-connect": {
        queued: 2,
        inFlight: 0,
        remainingSec: null,
        cooldownMs: 1000,
      },
    },
    recentThrottles: [{ status: 429 }],
  };
  snapshot.orderCapacity = {
    available: 5,
    reserved: 3,
    queued: 0,
  };

  const rendered = renderEngineDashboard(snapshot, {
    color: false,
    nowMs: Date.parse("2026-07-07T01:00:02.000Z"),
  });

  assert.match(rendered, /Preparation/);
  assert.match(rendered, /Phase\s+freshness-gate/);
  assert.match(rendered, /REST warm-up\s+700\/729 \(96%\)/);
  assert.match(rendered, /Observation\s+720 markets, 98\.7% coverage, 690 WS-confirmed, 30 REST-only, 12 quiet/);
  assert.match(rendered, /Validation\s+718 markets, 98\.5% coverage, 688 WS-confirmed, 30 REST-only, 14 quiet/);
  assert.match(rendered, /Blockers\s+WS_CONNECTION_NO_MESSAGES/);
  assert.match(rendered, /Upbit queues/);
  assert.match(rendered, /orderbook\s+4\s+1\s+5/);
  assert.match(rendered, /Order slots\s+5 available, 3 reserved, 0 queued/);
});
