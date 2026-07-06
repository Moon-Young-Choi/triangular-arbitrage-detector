const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const WebSocket = require("ws");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createDashboardRequestHandler, startDashboardServer } = require("../src/live/dashboardServer");
const { AppendOnlyLogStore } = require("../src/core/appendOnlyLog");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test("dashboard command API queues commands and exposes command status", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "q-gagarin-dashboard-"));
  const logStore = new AppendOnlyLogStore({ logDir: dir });
  const snapshotPath = path.join(dir, "snapshot.json");
  await fs.writeFile(snapshotPath, JSON.stringify({ engineState: "STOPPED", cycles: [], groups: [] }));
  const server = http.createServer(createDashboardRequestHandler({
    logStore,
    snapshotPath,
    publicDir: path.resolve(process.cwd(), "public"),
  }));
  const port = await listen(server);

  try {
    const accepted = await fetch(`http://127.0.0.1:${port}/api/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "Pause" }),
    });
    const rejected = await fetch(`http://127.0.0.1:${port}/api/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "Resync" }),
    });
    const commands = await logStore.readAll("commands");
    const acceptedPayload = await accepted.json();
    const commandStatus = await fetch(`http://127.0.0.1:${port}/api/commands/${acceptedPayload.commandId}`)
      .then((response) => response.json());

    assert.equal(accepted.status, 202);
    assert.equal(rejected.status, 400);
    assert.equal(commands.length, 1);
    assert.equal(commands[0].type, "dashboard.command");
    assert.equal(commands[0].command, "Pause");
    assert.equal(commands[0].mode, "OBSERVE");
    assert.equal(commands[0].engineState, "STOPPED");
    assert.equal(commands[0].auditSchema.ok, true);
    assert.equal(commandStatus.status.status, "queued");
  } finally {
    await close(server);
  }
});

test("dashboard explicit command endpoints queue only matching Start Pause Stop commands", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "q-gagarin-dashboard-command-endpoints-"));
  const logStore = new AppendOnlyLogStore({ logDir: dir });
  const snapshotPath = path.join(dir, "snapshot.json");
  await fs.writeFile(snapshotPath, JSON.stringify({ engineState: "STOPPED", cycles: [], groups: [] }));
  const server = http.createServer(createDashboardRequestHandler({
    logStore,
    snapshotPath,
    publicDir: path.resolve(process.cwd(), "public"),
  }));
  const port = await listen(server);

  try {
    const start = await fetch(`http://127.0.0.1:${port}/api/command/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runMode: "DRY_RUN" }),
    });
    const mismatch = await fetch(`http://127.0.0.1:${port}/api/command/pause`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "Start", runMode: "DRY_RUN" }),
    });
    const invalid = await fetch(`http://127.0.0.1:${port}/api/command/restart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const commands = await logStore.readAll("commands");
    const payload = await start.json();

    assert.equal(start.status, 202);
    assert.equal(payload.command, "Start");
    assert.equal(payload.runMode, "DRY_RUN");
    assert.equal(mismatch.status, 400);
    assert.equal(invalid.status, 400);
    assert.equal(commands.length, 1);
    assert.equal(commands[0].type, "dashboard.command");
    assert.equal(commands[0].command, "Start");
    assert.equal(commands[0].runMode, "DRY_RUN");
    assert.equal(commands[0].mode, "DRY_RUN");
    assert.equal(commands[0].engineState, "STOPPED");
    assert.equal(commands[0].auditSchema.ok, true);
  } finally {
    await close(server);
  }
});

test("dashboard command API rejects non-command mutation payloads", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "q-gagarin-dashboard-command-policy-"));
  const logStore = new AppendOnlyLogStore({ logDir: dir });
  const snapshotPath = path.join(dir, "snapshot.json");
  await fs.writeFile(snapshotPath, JSON.stringify({ engineState: "STOPPED", cycles: [], groups: [] }));
  const server = http.createServer(createDashboardRequestHandler({
    logStore,
    snapshotPath,
    publicDir: path.resolve(process.cwd(), "public"),
  }));
  const port = await listen(server);

  try {
    const pauseWithRunMode = await fetch(`http://127.0.0.1:${port}/api/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "Pause", runMode: "DRY_RUN" }),
    });
    const startRealAuto = await fetch(`http://127.0.0.1:${port}/api/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "Start", runMode: "REAL_AUTO" }),
    });
    const settingsPayload = await fetch(`http://127.0.0.1:${port}/api/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "Start", feeRate: 0.01 }),
    });
    const acceptedStart = await fetch(`http://127.0.0.1:${port}/api/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "Start", runMode: "DRY_RUN" }),
    });
    const commands = await logStore.readAll("commands");
    const accepted = await acceptedStart.json();

    assert.equal(pauseWithRunMode.status, 400);
    assert.equal(startRealAuto.status, 400);
    assert.equal(settingsPayload.status, 400);
    assert.equal(acceptedStart.status, 202);
    assert.equal(accepted.runMode, "DRY_RUN");
    assert.equal(commands.length, 1);
    assert.equal(commands[0].type, "dashboard.command");
    assert.equal(commands[0].command, "Start");
    assert.equal(commands[0].runMode, "DRY_RUN");
    assert.equal(commands[0].mode, "DRY_RUN");
    assert.equal(commands[0].engineState, "STOPPED");
    assert.equal(commands[0].auditSchema.ok, true);
  } finally {
    await close(server);
  }
});

test("dashboard read-only telemetry endpoints expose snapshot logs health and dry-run report", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "q-gagarin-dashboard-readonly-"));
  const logStore = new AppendOnlyLogStore({ logDir: dir });
  const snapshotPath = path.join(dir, "snapshot.json");
  await logStore.ensureFiles();
  await logStore.append("decisions", {
    type: "strategy-decision",
    mode: "DRY_RUN",
    accepted: true,
    startAsset: "KRW",
    strategyId: "s1",
    cycleId: "c1",
  });
  await fs.writeFile(snapshotPath, JSON.stringify({
    type: "full-state",
    engineState: "RUNNING",
    cycles: [],
    groups: [],
  }));
  const server = http.createServer(createDashboardRequestHandler({
    logStore,
    snapshotPath,
    publicDir: path.resolve(process.cwd(), "public"),
  }));
  const port = await listen(server);

  try {
    const health = await fetch(`http://127.0.0.1:${port}/api/dashboard/health`).then((response) => response.json());
    const snapshot = await fetch(`http://127.0.0.1:${port}/api/dashboard/snapshot`).then((response) => response.json());
    const logs = await fetch(`http://127.0.0.1:${port}/api/dashboard/logs?mode=DRY_RUN&type=decision`).then((response) => response.json());
    const report = await fetch(`http://127.0.0.1:${port}/api/dashboard/dry-run-report`).then((response) => response.json());
    const capture = await fetch(`http://127.0.0.1:${port}/api/capture`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageDataUrl: "data:image/png;base64,AA==", snapshot: {} }),
    });

    assert.equal(health.ok, true);
    assert.equal(health.engineState, "RUNNING");
    assert.equal(snapshot.engineState, "RUNNING");
    assert.equal(logs.logs.length, 1);
    assert.equal(report.summary.totalOpportunities, 1);
    assert.equal(report.summary.byLatencyBand.unknown.opportunities, 1);
    assert.equal(report.summary.byBestLevelTouchRatio.unknown.opportunities, 1);
    assert.equal(capture.status, 405);
  } finally {
    await close(server);
  }
});

test("dashboard WebSocket sends one full-state then runtime deltas", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "q-gagarin-dashboard-delta-"));
  const snapshotPath = path.join(dir, "latest-snapshot.json");
  const deltaPath = path.join(dir, "latest-delta.json");
  await fs.writeFile(snapshotPath, JSON.stringify({
    type: "full-state",
    engineState: "RUNNING",
    summary: { marketsLoaded: 1 },
    cycles: [],
    groups: [],
  }));
  const dashboard = await startDashboardServer({
    port: 0,
    snapshotPath,
    deltaPath,
    logDir: path.join(dir, "logs"),
    pushIntervalMs: 25,
  });
  const messages = [];
  const ws = new WebSocket(`${dashboard.url.replace("http:", "ws:")}/ws/live`);

  try {
    await new Promise((resolve, reject) => {
      ws.on("message", (data) => {
        messages.push(JSON.parse(data.toString("utf8")));
        if (messages.some((message) => message.type === "full-state")) {
          resolve();
        }
      });
      ws.on("error", reject);
    });

    await fs.writeFile(deltaPath, JSON.stringify({
      type: "delta",
      sentAtEpochMs: Date.now(),
      changedCycles: [],
      summaryDelta: { marketsLoaded: 2 },
      metrics: {},
      stateDelta: { engineState: "RUNNING" },
    }));

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for delta")), 1000);
      ws.on("message", (data) => {
        const message = JSON.parse(data.toString("utf8"));
        if (message.type === "delta") {
          clearTimeout(timer);
          resolve();
        }
      });
    });

    assert.equal(messages[0].type, "hello");
    assert.equal(messages.some((message) => message.type === "full-state"), true);
  } finally {
    ws.close();
    await dashboard.close();
  }
});

test("dashboard exposes filtered logs and dry-run report exports", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "q-gagarin-dashboard-report-"));
  const logStore = new AppendOnlyLogStore({ logDir: dir });
  const snapshotPath = path.join(dir, "snapshot.json");
  await logStore.ensureFiles();
  await logStore.append("decisions", {
    type: "strategy-decision",
    timestamp: "2026-07-06T00:00:00.000Z",
    mode: "DRY_RUN",
    accepted: true,
    startAsset: "KRW",
    strategyId: "s1",
    cycleId: "c1",
    marketState: "available",
    latencyMs: 90,
    bestLevelTouchRatio: 0.2,
  });
  await logStore.append("events", {
    type: "cycle.simulated_done",
    timestamp: "2026-07-06T00:00:10.000Z",
    mode: "DRY_RUN",
    marketState: "available",
    pnl: 12,
    latencyMs: 120,
    bestLevelTouchRatio: 0.21,
  });
  await logStore.append("decisions", {
    type: "strategy-decision",
    timestamp: "2026-07-06T00:20:00.000Z",
    mode: "DRY_RUN",
    accepted: false,
    startAsset: "BTC",
    strategyId: "s1",
    cycleId: "c2",
    marketState: "stale",
    validationReason: "STALE_ORDERBOOK",
  });
  await fs.writeFile(snapshotPath, JSON.stringify({ engineState: "STOPPED", cycles: [], groups: [] }));
  const server = http.createServer(createDashboardRequestHandler({
    logStore,
    snapshotPath,
    publicDir: path.resolve(process.cwd(), "public"),
  }));
  const port = await listen(server);

  try {
    const logs = await fetch(`http://127.0.0.1:${port}/api/logs?mode=DRY_RUN&type=decision&to=2026-07-06T00:05:00.000Z`).then((response) => response.json());
    const report = await fetch(`http://127.0.0.1:${port}/api/dry-run-report?to=2026-07-06T00:05:00.000Z`).then((response) => response.json());
    const csv = await fetch(`http://127.0.0.1:${port}/api/dry-run-report?format=csv&to=2026-07-06T00:05:00.000Z`).then((response) => response.text());

    assert.equal(logs.logs.length, 1);
    assert.equal(report.summary.simulatedCompleteCycles, 1);
    assert.equal(report.summary.totalOpportunities, 1);
    assert.equal(report.summary.byMarketState.available.opportunities, 1);
    assert.equal(report.summary.byMarketState.available.simulatedCompleteCycles, 1);
    assert.equal(report.summary.byMarketState.stale, undefined);
    assert.equal(report.summary.byLatencyBand["0-100ms"].opportunities, 1);
    assert.equal(report.summary.byLatencyBand["100-250ms"].simulatedCompleteCycles, 1);
    assert.equal(report.summary.byBestLevelTouchRatio["10-25%"].opportunities, 1);
    assert.equal(report.summary.byBestLevelTouchRatio["10-25%"].simulatedCompleteCycles, 1);
    assert.match(csv, /simulatedNetProfit/);
    assert.match(csv, /periodFrom/);
    assert.match(csv, /marketState:available:opportunities/);
    assert.match(csv, /latencyBand:0-100ms:opportunities/);
    assert.match(csv, /bestLevelTouchRatio:10-25%:simulatedCompleteCycles/);
  } finally {
    await close(server);
  }
});
