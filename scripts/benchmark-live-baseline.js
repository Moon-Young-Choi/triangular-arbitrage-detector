#!/usr/bin/env node

const fs = require("node:fs/promises");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { startLiveServer } = require("../src/live/server");
const { formatLocalTimestampForFilename } = require("../src/live/liveUtils");

function hasFlag(name) {
  return process.argv.includes(name);
}

function readOption(name, defaultValue) {
  const prefix = `${name}=`;
  const value = process.argv.find((arg) => arg.startsWith(prefix));

  return value ? value.slice(prefix.length) : defaultValue;
}

async function writeBaseline(outDir, payload) {
  await fs.mkdir(outDir, { recursive: true });
  const stamp = formatLocalTimestampForFilename(new Date(payload.generatedAt));
  const outputPath = path.join(outDir, `baseline-${stamp}.json`);

  await fs.writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
  return outputPath;
}

function buildPayload({ liveServer, startupMs, snapshot, skipFeeds }) {
  const summary = snapshot.summary || {};
  const browserMetrics = snapshot.metrics && snapshot.metrics.browser;

  return {
    generatedAt: new Date().toISOString(),
    liveDashboardStartupMs: startupMs,
    url: liveServer.url,
    marketCount: summary.marketsLoaded || 0,
    triangleCount: summary.uniqueTriangleCount || summary.uniqueTriangles || 0,
    plottedCycleCount: summary.plottedCycleCount || 0,
    uiPushIntervalMs: liveServer.uiPushIntervalMs,
    averageRenderMs: browserMetrics ? browserMetrics.averageRenderMs : null,
    browserRenderSampleCount: browserMetrics ? browserMetrics.renderSampleCount : 0,
    skipFeeds,
    runtimeConfig: snapshot.runtimeConfig || liveServer.runtimeConfig || null,
    summary,
  };
}

async function main() {
  const outDir = path.resolve(process.cwd(), readOption("--out", path.join("out", "baseline")));
  const skipFeeds = !hasFlag("--start-feeds") && process.env.BASELINE_START_FEEDS !== "1";
  const started = performance.now();
  const liveServer = await startLiveServer({ skipFeeds });
  const startupMs = performance.now() - started;

  try {
    const snapshot = liveServer.state.getSnapshot();
    const payload = buildPayload({
      liveServer,
      startupMs,
      snapshot,
      skipFeeds,
    });
    const outputPath = await writeBaseline(outDir, payload);

    console.log(`Wrote ${path.relative(process.cwd(), outputPath)}`);
    console.log(`liveDashboardStartupMs: ${startupMs.toFixed(1)}`);
    console.log(`marketCount: ${payload.marketCount}`);
    console.log(`triangleCount: ${payload.triangleCount}`);
    console.log(`plottedCycleCount: ${payload.plottedCycleCount}`);
    console.log(`uiPushIntervalMs: ${payload.uiPushIntervalMs}`);
    console.log(`averageRenderMs: ${payload.averageRenderMs === null ? "n/a" : payload.averageRenderMs.toFixed(3)}`);
  } finally {
    await liveServer.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
