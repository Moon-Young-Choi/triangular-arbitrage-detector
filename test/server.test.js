const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { EventEmitter } = require("node:events");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");
const { createRequestHandler, startLiveServer } = require("../src/live/server");
const { AppendOnlyLogStore } = require("../src/core/appendOnlyLog");
const { DEFAULT_RUNTIME_CONFIG } = require("../src/core/runtimeConfig");

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

function fakeOrderbookClient() {
  const emitter = new EventEmitter();

  return {
    started: 0,
    stopped: 0,
    on: emitter.on.bind(emitter),
    emit: emitter.emit.bind(emitter),
    start() {
      this.started += 1;
    },
    stop() {
      this.stopped += 1;
    },
  };
}

async function waitForCommandStatus(baseUrl, commandId, expectedStatus) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const payload = await fetch(`${baseUrl}/api/commands/${commandId}`).then((response) => response.json());

    if (payload.status && payload.status.status === expectedStatus) {
      return payload.status;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`Timed out waiting for command ${commandId} to become ${expectedStatus}`);
}

test("live server health and state endpoints work without Upbit network", async () => {
  const state = {
    getHealth() {
      return { ok: true, wsStatus: { stopped: true } };
    },
    getSnapshot() {
      return {
        summary: { marketsLoaded: 0 },
        groups: [],
        cycles: [],
        serverStartedAt: "2026-07-04T00:00:00.000Z",
        lastCalculatedAt: "2026-07-04T00:00:00.000Z",
        wsStatus: { stopped: true },
      };
    },
  };
  const server = http.createServer(createRequestHandler({ state }));
  const port = await listen(server);

  try {
    const health = await fetch(`http://127.0.0.1:${port}/api/health`).then((response) => response.json());
    const snapshot = await fetch(`http://127.0.0.1:${port}/api/state`).then((response) => response.json());

    assert.equal(health.ok, true);
    assert.equal(snapshot.summary.marketsLoaded, 0);
    assert.deepEqual(snapshot.cycles, []);
  } finally {
    await close(server);
  }
});

test("combined live server rejects dashboard mutation APIs by default", async () => {
  let mutationCount = 0;
  const state = {
    getHealth() {
      return { ok: true, wsStatus: { stopped: true } };
    },
    getSnapshot() {
      return {
        summary: { marketsLoaded: 0 },
        groups: [],
        cycles: [],
        wsStatus: { stopped: true },
      };
    },
    setFeeRate() {
      mutationCount += 1;
    },
    selectStrategy() {
      mutationCount += 1;
    },
  };
  const server = http.createServer(createRequestHandler({ state }));
  const port = await listen(server);

  try {
    const settings = await fetch(`http://127.0.0.1:${port}/api/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feeRate: 0.001, staleOrderbookMs: 250 }),
    });
    const strategy = await fetch(`http://127.0.0.1:${port}/api/strategy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ strategyId: "depthAwareLimitIoc" }),
    });
    const capture = await fetch(`http://127.0.0.1:${port}/api/capture`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageDataUrl: "data:image/png;base64,AA==", snapshot: {} }),
    });

    assert.equal(settings.status, 403);
    assert.equal(strategy.status, 403);
    assert.equal(capture.status, 405);
    assert.equal(mutationCount, 0);
  } finally {
    await close(server);
  }
});

test("combined live server ignores legacy dashboard mutation override", async () => {
  let mutationCount = 0;
  const state = {
    getHealth() {
      return { ok: true, wsStatus: { stopped: true } };
    },
    getSnapshot() {
      return {
        summary: { marketsLoaded: 0 },
        groups: [],
        cycles: [],
        wsStatus: { stopped: true },
      };
    },
    setFeeRate() {
      mutationCount += 1;
    },
    selectStrategy() {
      mutationCount += 1;
    },
    recalculateAll() {
      mutationCount += 1;
    },
  };
  const server = http.createServer(createRequestHandler({
    state,
    allowDashboardMutations: true,
  }));
  const port = await listen(server);

  try {
    const settings = await fetch(`http://127.0.0.1:${port}/api/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feeRate: 0.001, staleOrderbookMs: 250 }),
    });
    const strategy = await fetch(`http://127.0.0.1:${port}/api/strategy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ strategyId: "depthAwareBestIoc" }),
    });

    assert.equal(settings.status, 403);
    assert.equal(strategy.status, 403);
    assert.equal(mutationCount, 0);
  } finally {
    await close(server);
  }
});

test("live server WebSocket sends hello and full-state without Upbit network", async () => {
  const state = {
    requiredMarkets: [],
    updateOrderbook() {},
    setWsStatus(status) {
      this.wsStatus = status;
    },
    getHealth() {
      return { ok: true, wsStatus: { stopped: true } };
    },
    getSnapshot() {
      return {
        type: "full-state",
        summary: {
          marketsLoaded: 0,
          uniqueTriangleCount: 0,
          plottedCycleCount: 0,
          feeRate: 0,
          executableBreakEvenGross: 1,
        },
        groups: [],
        groupCounts: {},
        xRange: { min: 0.25, max: 1.75 },
        cycles: [],
        serverStartedAt: "2026-07-04T00:00:00.000Z",
        lastCalculatedAt: "2026-07-04T00:00:00.000Z",
        wsStatus: { stopped: true },
        metrics: {},
      };
    },
    consumeDelta() {
      return {
        type: "delta",
        sentAtEpochMs: Date.now(),
        changedCycles: [],
        summaryDelta: {},
        metrics: {},
      };
    },
    shouldUseFallback() {
      return false;
    },
    metrics: {
      increment() {},
    },
  };
  const liveServer = await startLiveServer({
    port: 0,
    state,
    skipInitialize: true,
    skipFeeds: true,
    uiPushIntervalMs: 16,
  });
  const messages = [];
  const ws = new WebSocket(`${liveServer.url.replace("http:", "ws:")}/ws/live`);

  try {
    await new Promise((resolve, reject) => {
      ws.on("message", (data) => {
        messages.push(JSON.parse(data.toString("utf8")));
        if (messages.length === 2) resolve();
      });
      ws.on("error", reject);
    });

    assert.equal(messages[0].type, "hello");
    assert.equal(messages[1].type, "full-state");
    assert.equal(Object.hasOwn(messages[1].summary, ["lower", "Break", "Even"].join("")), false);
  } finally {
    ws.close();
    await liveServer.close();
  }
});

test("combined live server exposes dashboard aliases and applies safe local commands", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "q-gagarin-combined-"));
  const logStore = new AppendOnlyLogStore({ logDir: path.join(dir, "logs") });
  await logStore.append("decisions", {
    type: "strategy-decision",
    mode: "DRY_RUN",
    accepted: true,
    startAsset: "KRW",
    strategyId: "s1",
    cycleId: "c1",
  });

  const state = {
    runtimeConfig: {
      ...DEFAULT_RUNTIME_CONFIG,
      runMode: "OBSERVE",
    },
    engineState: "STOPPED",
    requiredMarkets: [],
    updateObservationOrderbook() {},
    updateValidationOrderbook() {},
    setWsStatus() {},
    setRuntimeConfig(config) {
      this.runtimeConfig = config;
    },
    getHealth() {
      return { ok: true, engineState: this.engineState };
    },
    getSnapshot() {
      return {
        type: "full-state",
        engineState: this.engineState,
        runtimeConfig: this.runtimeConfig,
        summary: {
          marketsLoaded: 0,
          uniqueTriangleCount: 0,
          plottedCycleCount: 0,
        },
        groups: [],
        cycles: [],
        eventLog: [],
        metrics: {},
      };
    },
    consumeDelta() {
      return {
        type: "delta",
        sentAtEpochMs: Date.now(),
        changedCycles: [],
        summaryDelta: {},
        metrics: {},
      };
    },
    shouldUseFallback() {
      return false;
    },
    metrics: {
      recordBrowserRender() {},
      increment() {},
    },
  };
  const observationClient = fakeOrderbookClient();
  const validationClient = fakeOrderbookClient();
  const liveServer = await startLiveServer({
    port: 0,
    state,
    logStore,
    runtimeDir: dir,
    skipInitialize: true,
    skipFeeds: true,
    wsClient: observationClient,
    validationWsClient: validationClient,
    uiPushIntervalMs: 16,
  });

  try {
    const snapshot = await fetch(`${liveServer.url}/api/dashboard/snapshot`).then((response) => response.json());
    const logs = await fetch(`${liveServer.url}/api/dashboard/logs?mode=DRY_RUN&type=decision`).then((response) => response.json());
    const report = await fetch(`${liveServer.url}/api/dashboard/dry-run-report`).then((response) => response.json());

    assert.equal(snapshot.engineState, "STOPPED");
    assert.equal(logs.logs.length, 1);
    assert.equal(report.summary.totalOpportunities, 1);

    const start = await fetch(`${liveServer.url}/api/command/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runMode: "DRY_RUN" }),
    }).then((response) => response.json());
    const startStatus = await waitForCommandStatus(liveServer.url, start.commandId, "accepted");

    assert.equal(startStatus.nextState, "RUNNING");
    assert.equal(state.engineState, "RUNNING");
    assert.equal(state.runtimeConfig.runMode, "DRY_RUN");
    assert.equal(observationClient.started, 1);
    assert.equal(validationClient.started, 1);

    const pause = await fetch(`${liveServer.url}/api/command/pause`, { method: "POST" }).then((response) => response.json());
    const pauseStatus = await waitForCommandStatus(liveServer.url, pause.commandId, "accepted");

    assert.equal(pauseStatus.nextState, "PAUSED");
    assert.equal(state.engineState, "PAUSED");
    assert.equal(observationClient.stopped, 0);

    const rejected = await fetch(`${liveServer.url}/api/command/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runMode: "REAL_GUARDED" }),
    }).then((response) => response.json());
    const rejectedStatus = await waitForCommandStatus(liveServer.url, rejected.commandId, "rejected");

    assert.match(rejectedStatus.message, /separated engine runtime/);

    const stop = await fetch(`${liveServer.url}/api/command/stop`, { method: "POST" }).then((response) => response.json());
    const stopStatus = await waitForCommandStatus(liveServer.url, stop.commandId, "accepted");
    const events = await logStore.readAll("events");
    const commands = await logStore.readAll("commands");
    const stateChangedEvents = events.filter((event) => event.type === "engine.state_changed");

    assert.equal(stopStatus.nextState, "STOPPED");
    assert.equal(state.engineState, "STOPPED");
    assert.equal(observationClient.stopped, 1);
    assert.equal(validationClient.stopped, 1);
    assert.equal(stateChangedEvents.length, 3);
    assert.deepEqual(stateChangedEvents.map((event) => event.engineState), ["RUNNING", "PAUSED", "STOPPED"]);
    assert.equal(stateChangedEvents.every((event) => event.mode === "DRY_RUN"), true);
    assert.equal(stateChangedEvents.every((event) => event.auditSchema.ok), true);
    assert.equal(commands.length, 4);
    assert.deepEqual(commands.map((command) => command.engineState), ["STOPPED", "RUNNING", "PAUSED", "PAUSED"]);
    assert.deepEqual(commands.map((command) => command.mode), ["DRY_RUN", "DRY_RUN", "REAL", "DRY_RUN"]);
    assert.equal(commands.every((command) => command.auditSchema.ok), true);
  } finally {
    await liveServer.close();
  }
});
