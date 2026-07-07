const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  loadEnvFile,
  parseEnvFile,
} = require("../src/core/envFile");

function restoreEnv(name, previousValue) {
  if (previousValue === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previousValue;
  }
}

test("env file parser reads simple quoted and exported values", () => {
  assert.deepEqual(parseEnvFile([
    "# ignored",
    "UPBIT_ACCESS_KEY=test-access",
    "UPBIT_SECRET_KEY=\"test secret\"",
    "export Q_GAGARIN_ALLOW_LIVE_TRADING=true",
    "INLINE=value # comment",
    "INVALID-NAME=ignored",
  ].join("\n")), {
    UPBIT_ACCESS_KEY: "test-access",
    UPBIT_SECRET_KEY: "test secret",
    Q_GAGARIN_ALLOW_LIVE_TRADING: "true",
    INLINE: "value",
  });
});

test("env file loader does not override existing environment by default", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "q-gagarin-env-"));
  const envPath = path.join(dir, ".env");
  const previousAccessKey = process.env.UPBIT_ACCESS_KEY;
  const previousSecretKey = process.env.UPBIT_SECRET_KEY;

  await fs.writeFile(envPath, [
    "UPBIT_ACCESS_KEY=file-access",
    "UPBIT_SECRET_KEY=file-secret",
  ].join("\n"));

  process.env.UPBIT_ACCESS_KEY = "shell-access";
  delete process.env.UPBIT_SECRET_KEY;

  try {
    const result = loadEnvFile({ envPath });

    assert.equal(result.loaded, true);
    assert.equal(process.env.UPBIT_ACCESS_KEY, "shell-access");
    assert.equal(process.env.UPBIT_SECRET_KEY, "file-secret");
  } finally {
    restoreEnv("UPBIT_ACCESS_KEY", previousAccessKey);
    restoreEnv("UPBIT_SECRET_KEY", previousSecretKey);
  }
});

test("env file loader tolerates a missing file", () => {
  const result = loadEnvFile({ envPath: path.join(os.tmpdir(), "q-gagarin-missing.env") });

  assert.equal(result.loaded, false);
  assert.deepEqual(result.values, {});
});
