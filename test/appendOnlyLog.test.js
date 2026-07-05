const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { AppendOnlyLogStore, sanitizeForLog } = require("../src/core/appendOnlyLog");

test("append-only log store writes ndjson and redacts secrets", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "q-gagarin-log-"));
  const store = new AppendOnlyLogStore({ logDir: dir });

  await store.ensureFiles();
  await store.append("events", {
    type: "example",
    secretKey: "super-secret",
    nested: {
      authorization: "Bearer token",
      ok: true,
    },
  });

  const rows = await store.readAll("events");

  assert.equal(rows.length, 1);
  assert.equal(rows[0].secretKey, "[redacted]");
  assert.equal(rows[0].nested.authorization, "[redacted]");
  assert.equal(sanitizeForLog({ access_key: "abc" }).access_key, "[redacted]");
});
