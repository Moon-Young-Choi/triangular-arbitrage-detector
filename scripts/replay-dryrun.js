#!/usr/bin/env node
const fs = require("node:fs/promises");
const path = require("node:path");
const { DEFAULT_RUNTIME_CONFIG, loadRuntimeConfig } = require("../src/core/runtimeConfig");
const { replayDryRunReport } = require("../src/replay/replayEngine");
const { replayRealExecution } = require("../src/replay/executionReplay");

async function readJson(filePath, fallback) {
  if (!filePath) return fallback;
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function main() {
  const tapePath = process.env.TAPE_JSON || process.argv[2];
  const cyclesPath = process.env.CYCLES_JSON || process.argv[3] ||
    path.resolve(process.cwd(), "out", "upbit-canonical-cycles.json");
  const scenarioPath = process.env.SCENARIO_JSON || process.argv[4];
  const runtimeConfig = process.env.RUNTIME_CONFIG
    ? loadRuntimeConfig({ configPath: process.env.RUNTIME_CONFIG })
    : DEFAULT_RUNTIME_CONFIG;

  if (!tapePath) {
    throw new Error("Usage: TAPE_JSON=orderbook-tape.json [CYCLES_JSON=cycles.json] [SCENARIO_JSON=scenario.json] npm run replay:dryrun");
  }

  const tape = await readJson(tapePath, []);
  const scenario = await readJson(scenarioPath, null);
  const cyclesPayload = await readJson(cyclesPath, []);
  const cycles = Array.isArray(cyclesPayload) ? cyclesPayload : cyclesPayload.cycles || [];
  const result = await replayDryRunReport({
    cycles,
    tape,
    runtimeConfig: {
      ...runtimeConfig,
      runMode: "DRY_RUN",
    },
    feeRate: Number(process.env.UPBIT_TAKER_FEE_RATE || 0),
    staleOrderbookMs: Number(process.env.STALE_ORDERBOOK_MS || 3000),
    nowMs: process.env.REPLAY_NOW_MS ? Number(process.env.REPLAY_NOW_MS) : Date.now(),
  });
  const executionReplays = scenario
    ? await Promise.all(result.executionPlans.map(async (plan) => {
      const replayed = await replayRealExecution(plan, {
        runtimeConfig: {
          ...runtimeConfig,
          liveTradingEnabled: true,
        },
        scenario,
        privateWsConnected: scenario.privateWsConnected !== false,
        orderChanceFresh: scenario.orderChanceFresh !== false,
        accountBalanceFresh: scenario.accountBalanceFresh !== false,
        validationDepthFresh: scenario.validationDepthFresh !== false,
      });

      return {
        planId: plan.planId,
        cycleId: plan.cycleId,
        ok: replayed.result.ok,
        reason: replayed.result.reason || null,
        pnl: replayed.result.pnl,
        outputAmount: replayed.result.outputAmount,
        replayEventCount: replayed.replayEvents.length,
        logEventTypes: replayed.logEvents.map((event) => event.type).filter(Boolean),
      };
    }))
    : [];

  process.stdout.write(`${JSON.stringify({
    generatedAt: result.generatedAt,
    candidateCount: result.candidateCount,
    acceptedCount: result.acceptedCount,
    rejectedCount: result.rejectedCount,
    executionPlanCount: result.executionPlans.length,
    replayManifest: result.replayManifest,
    dryRunReport: result.dryRunReport,
    dryRunExecutions: result.dryRunExecutions,
    plans: result.executionPlans.map((plan) => ({
      planId: plan.planId,
      cycleId: plan.cycleId,
      startAsset: plan.startAsset,
      startAmount: plan.startAmount,
      expectedNetProfit: plan.expectedNetProfit,
      strategyId: plan.strategyId,
    })),
    executionReplays,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
