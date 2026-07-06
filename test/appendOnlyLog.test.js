const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  AppendOnlyLogStore,
  buildAuditRecord,
  sanitizeForLog,
} = require("../src/core/appendOnlyLog");

test("append-only log store writes ndjson and redacts secrets", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "q-gagarin-log-"));
  const store = new AppendOnlyLogStore({ logDir: dir });

  await store.ensureFiles();
  await store.append("events", {
    type: "example",
    mode: "DRY_RUN",
    cycleId: "KRW|BTC|ETH:canonical:KRW",
    startAsset: "KRW",
    strategyId: "depthAwareBestIoc",
    engineState: "RUNNING",
    secretKey: "super-secret",
    nested: {
      authorization: "Bearer token",
      ok: true,
    },
  });
  await store.append("market", {
    type: "market.orderbook_update",
    mode: "DRY_RUN",
    market: "KRW-BTC",
    traceId: "observation:KRW-BTC:1000:1",
    exchangeTimestampMs: 1000,
    serverReceivedAtMs: 1010,
    orderbook_units: [{
      ask_price: 100,
      bid_price: 99,
      ask_size: 1,
      bid_size: 2,
    }],
  });

  const rows = await store.readAll("events");
  const marketRows = await store.readAll("market");

  assert.equal(rows.length, 1);
  assert.equal(typeof rows[0].eventId, "string");
  assert.equal(typeof rows[0].ts, "string");
  assert.equal(rows[0].traceId, "KRW|BTC|ETH:canonical:KRW");
  assert.equal(rows[0].mode, "DRY_RUN");
  assert.equal(rows[0].exchange, "upbit");
  assert.equal(rows[0].startAsset, "KRW");
  assert.equal(rows[0].cycleId, "KRW|BTC|ETH:canonical:KRW");
  assert.equal(rows[0].strategyId, "depthAwareBestIoc");
  assert.equal(rows[0].engineState, "RUNNING");
  assert.equal(rows[0].auditSchemaVersion, 1);
  assert.equal(rows[0].auditSchema.ok, true);
  assert.equal(rows[0].auditSchema.canonicalType, false);
  assert.equal(rows[0].payload.secretKey, "[redacted]");
  assert.equal(rows[0].payload.nested.authorization, "[redacted]");
  assert.equal(rows[0].secretKey, "[redacted]");
  assert.equal(rows[0].nested.authorization, "[redacted]");
  assert.equal(marketRows.length, 1);
  assert.equal(marketRows[0].type, "market.orderbook_update");
  assert.equal(marketRows[0].market, "KRW-BTC");
  assert.equal(marketRows[0].traceId, "observation:KRW-BTC:1000:1");
  assert.equal(marketRows[0].auditSchema.canonicalType, true);
  assert.deepEqual(marketRows[0].auditSchema.missingRequiredFields, ["engineState"]);
  assert.equal(sanitizeForLog({ access_key: "abc" }).access_key, "[redacted]");
});

test("audit records expose canonical schema completeness without dropping payload context", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "q-gagarin-audit-schema-"));
  const store = new AppendOnlyLogStore({ logDir: dir });

  await store.append("events", {
    type: "cycle.done",
    mode: "REAL",
    exchange: "upbit",
    startAsset: "KRW",
    cycleId: "BTC|ETH|KRW:canonical:KRW",
    strategyId: "depthAwareBestIoc",
    engineState: "RUNNING",
    pnl: 42,
    payload: {
      outputAmount: 10042,
      feeSummary: {
        totalPaidFee: 3,
      },
    },
  });
  await store.append("commands", {
    type: "dashboard.command",
    mode: "DRY_RUN",
    engineState: "STOPPED",
    commandId: "command-1",
    command: "Start",
    runMode: "DRY_RUN",
    source: "dashboard",
  });
  await store.append("events", {
    type: "risk.rejected",
    mode: "REAL",
    cycleId: "cycle-with-missing-context",
    reason: "ORDER_ACK_LATENCY",
  });

  const [cycleDone, riskRejected] = await store.readAll("events");
  const [command] = await store.readAll("commands");

  assert.equal(cycleDone.auditSchema.ok, true);
  assert.equal(cycleDone.auditSchema.canonicalType, true);
  assert.equal(cycleDone.payload.outputAmount, 10042);
  assert.equal(cycleDone.payload.feeSummary.totalPaidFee, 3);
  assert.equal(command.auditSchema.ok, true);
  assert.equal(command.traceId, "command-1");
  assert.equal(command.payload.runMode, "DRY_RUN");
  assert.equal(riskRejected.auditSchema.ok, false);
  assert.deepEqual(
    riskRejected.auditSchema.missingRequiredFields.sort(),
    ["engineState", "startAsset", "strategyId"].sort(),
  );
});

test("audit record builder derives trace ids and reports required fields deterministically", () => {
  const record = buildAuditRecord("orders", {
    type: "order.ack",
    mode: "REAL",
    planId: "plan-1",
    startAsset: "BTC",
    cycleId: "cycle-1",
    strategyId: "depthAwareBestIoc",
    engineState: "RUNNING",
    uuid: "uuid-1",
  }, {
    randomUUID: () => "event-1",
    nowIso: "2026-07-06T00:00:00.000Z",
  });

  assert.equal(record.eventId, "event-1");
  assert.equal(record.traceId, "cycle-1");
  assert.equal(record.ts, "2026-07-06T00:00:00.000Z");
  assert.equal(record.auditSchema.ok, true);
  assert.equal(record.payload.planId, "plan-1");
  assert.equal(record.payload.uuid, "uuid-1");
});

test("append-only log store serializes concurrent append calls in call order", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "q-gagarin-log-order-"));
  const store = new AppendOnlyLogStore({ logDir: dir });
  const writes = [];

  for (let index = 0; index < 30; index += 1) {
    writes.push(store.append("fills", {
      type: "order.simulated_fill",
      mode: "DRY_RUN",
      startAsset: "KRW",
      cycleId: "cycle-ordered",
      strategyId: "depthAwareBestIoc",
      engineState: "RUNNING",
      legIndex: index,
    }));
  }

  await Promise.all(writes);
  const rows = await store.readAll("fills", { limit: 40 });

  assert.deepEqual(rows.map((row) => row.legIndex), [...Array(30).keys()]);
});

test("append-only log store reads recent rows from large ndjson files without full-file load", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "q-gagarin-log-tail-"));
  const store = new AppendOnlyLogStore({ logDir: dir });
  await fs.mkdir(dir, { recursive: true });

  const rows = [];
  for (let index = 0; index < 5000; index += 1) {
    rows.push(JSON.stringify({
      timestamp: `2026-07-06T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
      type: "strategy-decision",
      mode: "DRY_RUN",
      index,
      payload: "x".repeat(300),
    }));
  }
  await fs.writeFile(store.filePath("decisions"), `${rows.join("\n")}\n`);

  const recent = await store.readAll("decisions", {
    limit: 5,
    maxBytes: 16 * 1024,
  });

  assert.deepEqual(recent.map((row) => row.index), [4995, 4996, 4997, 4998, 4999]);
});
