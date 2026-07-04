const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createRequestHandler } = require("../src/live/server");

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
