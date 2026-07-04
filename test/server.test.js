const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const WebSocket = require("ws");
const { createRequestHandler, startLiveServer } = require("../src/live/server");

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
