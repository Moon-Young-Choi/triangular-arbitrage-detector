#!/usr/bin/env node

const fs = require("node:fs/promises");
const path = require("node:path");
const { formatLocalTimestampForFilename } = require("../src/live/liveUtils");

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

async function readJson(filePath) {
  const content = await fs.readFile(filePath, "utf8");
  return JSON.parse(content);
}

function buildPayload({ snapshot, snapshotPath }) {
  const summary = snapshot.summary || {};

  return {
    generatedAt: new Date().toISOString(),
    source: "runtime-snapshot",
    snapshotPath,
    engineState: snapshot.engineState || snapshot.engine && snapshot.engine.state || "UNKNOWN",
    marketCount: summary.marketsLoaded || 0,
    triangleCount: summary.uniqueTriangleCount || summary.uniqueTriangles || 0,
    plottedCycleCount: summary.plottedCycleCount || 0,
    runtimeConfig: snapshot.runtimeConfig || null,
    performanceBudget: snapshot.performanceBudget || null,
    readiness: snapshot.readiness || null,
    summary,
  };
}

async function main() {
  const outDir = path.resolve(process.cwd(), readOption("--out", path.join("out", "baseline")));
  const snapshotPath = path.resolve(process.cwd(), readOption("--snapshot", path.join("out", "runtime", "latest-snapshot.json")));
  const snapshot = await readJson(snapshotPath);
  const payload = buildPayload({ snapshot, snapshotPath: path.relative(process.cwd(), snapshotPath) });
  const outputPath = await writeBaseline(outDir, payload);

  console.log(`Wrote ${path.relative(process.cwd(), outputPath)}`);
  console.log(`engineState: ${payload.engineState}`);
  console.log(`marketCount: ${payload.marketCount}`);
  console.log(`triangleCount: ${payload.triangleCount}`);
  console.log(`plottedCycleCount: ${payload.plottedCycleCount}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
