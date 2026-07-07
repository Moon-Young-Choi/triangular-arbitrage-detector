const test = require("node:test");
const assert = require("node:assert/strict");
const {
  contractsSinceRun,
  engineRunBaselineMs,
  renderContractsMonitor,
  summarizeContracts,
} = require("../src/cli/renderers/contractsMonitor");
const { stripAnsi } = require("../src/cli/renderers/table");

function sampleSnapshot(overrides = {}) {
  return {
    engineState: "RUNNING",
    serverStartedAt: "2026-07-07T01:00:00.000Z",
    lastCalculatedAt: "2026-07-07T01:00:05.000Z",
    runtimeConfig: {
      runMode: "DRY_RUN",
      liveTradingEnabled: false,
      activeStrategyId: "topOfBookBaseline",
      exchange: "upbit",
    },
    engineProcess: {
      pid: 1234,
      startedAt: "2026-07-07T01:00:00.000Z",
      startedAtEpochMs: Date.parse("2026-07-07T01:00:00.000Z"),
    },
    execution: {
      dryRunCapital: {
        buckets: {
          KRW: { availableBalance: 1000015 },
          BTC: { availableBalance: 0.05 },
        },
      },
    },
    ...overrides,
  };
}

function contract(overrides = {}) {
  return {
    type: "cycle.done",
    mode: "DRY_RUN",
    timestamp: "2026-07-07T01:00:01.000Z",
    cycleId: "KRW|SOL|USDT:canonical:KRW",
    triangleId: "KRW|SOL|USDT",
    direction: "canonical",
    route: ["KRW", "SOL", "USDT", "KRW"],
    startAsset: "KRW",
    strategyId: "topOfBookBaseline",
    startAmount: 10000,
    outputAmount: 10015,
    pnl: 15,
    profitRate: 0.0015,
    expectedNetProfit: 20,
    expectedSimulatedGap: 5,
    capitalBefore: { availableBalance: 1000000, reservedBalance: 0, lockedBalance: 0, residualBalance: 0 },
    capitalAfter: { availableBalance: 1000015, reservedBalance: 0, lockedBalance: 0, residualBalance: 0 },
    cycleExecutionLatency: {
      simulated: true,
      cycleTotalMs: 0,
    },
    legResults: [
      {
        legIndex: 1,
        market: "KRW-SOL",
        side: "bid",
        fromAsset: "KRW",
        toAsset: "SOL",
        inputAmount: 10000,
        outputAmount: 0.081,
        averagePrice: 123000,
        feeRate: 0.0005,
      },
    ],
    ...overrides,
  };
}

test("contracts monitor renders balances, mode, and run PnL since engine start", () => {
  const logs = [
    contract({
      timestamp: "2026-07-07T00:59:59.000Z",
      pnl: 999,
      outputAmount: 10999,
    }),
    contract(),
    contract({
      mode: "REAL",
      timestamp: "2026-07-07T01:00:02.000Z",
      cycleId: "KRW|BTC|USDT:reverse:KRW",
      triangleId: "KRW|BTC|USDT",
      direction: "reverse",
      pnl: -5,
      outputAmount: 9995,
      profitRate: -0.0005,
    }),
  ];
  const snapshot = sampleSnapshot();
  const baselineMs = engineRunBaselineMs(snapshot);
  const rendered = renderContractsMonitor(snapshot, logs, {
    color: false,
    baselineMs,
    nowMs: Date.parse("2026-07-07T01:00:06.000Z"),
    detailCount: 1,
  });

  assert.match(rendered, /q-gagarin contracts/);
  assert.match(rendered, /Mode\s+DRY_RUN/);
  assert.match(rendered, /Dry-run simulated available/);
  assert.match(rendered, /Run PnL since engine start/);
  assert.match(rendered, /DRY_RUN\s+KRW\s+1\s+1\/0\/0\s+\+15.00 KRW\s+\+0.1500%/);
  assert.match(rendered, /REAL\s+KRW\s+1\s+0\/1\/0\s+-5.00 KRW\s+-0.0500%/);
  assert.doesNotMatch(rendered, /\+999.00 KRW/);
  assert.match(rendered, /REAL Contract 2026-07-07T01:00:02.000Z/);
});

test("contracts monitor summarizes contracts by mode and asset", () => {
  const rows = [
    contract({ pnl: 10, startAmount: 1000 }),
    contract({ pnl: -2, startAmount: 1000 }),
    contract({ mode: "REAL", startAsset: "USDT", startAmount: 10, pnl: 0.1 }),
  ];
  const summary = summarizeContracts(rows);

  assert.deepEqual(summary.map((row) => [row.mode, row.asset, row.contracts, row.pnl, row.startAmount]), [
    ["DRY_RUN", "KRW", 2, 8, 2000],
    ["REAL", "USDT", 1, 0.1, 10],
  ]);
});

test("contracts monitor can render color without breaking plain text", () => {
  const rendered = renderContractsMonitor(sampleSnapshot(), [contract()], {
    color: true,
    nowMs: Date.parse("2026-07-07T01:00:06.000Z"),
  });

  assert.match(rendered, /\x1b\[/);
  assert.match(stripAnsi(rendered), /DRY_RUN\s+KRW/);
});

test("contracts monitor filters contract rows by baseline", () => {
  const rows = contractsSinceRun([
    contract({ timestamp: "2026-07-07T00:59:59.000Z" }),
    contract({ timestamp: "2026-07-07T01:00:01.000Z" }),
  ], Date.parse("2026-07-07T01:00:00.000Z"));

  assert.equal(rows.length, 1);
  assert.equal(rows[0].timestamp, "2026-07-07T01:00:01.000Z");
});
