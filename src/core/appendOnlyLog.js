const fs = require("node:fs/promises");
const path = require("node:path");

const LOG_FILES = Object.freeze({
  events: "events.ndjson",
  decisions: "decisions.ndjson",
  orders: "orders.ndjson",
  fills: "fills.ndjson",
  errors: "errors.ndjson",
  commands: "commands.ndjson",
});

const SECRET_KEY_PATTERN = /(secret|accessKey|access_key|authorization|token)/i;

function sanitizeForLog(value) {
  if (Array.isArray(value)) {
    return value.map(sanitizeForLog);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SECRET_KEY_PATTERN.test(key) ? "[redacted]" : sanitizeForLog(item),
    ]),
  );
}

class AppendOnlyLogStore {
  constructor(options = {}) {
    this.logDir = options.logDir || path.resolve(process.cwd(), "out", "logs");
    this.files = {
      ...LOG_FILES,
      ...(options.files || {}),
    };
  }

  filePath(kind) {
    const fileName = this.files[kind];

    if (!fileName) {
      throw new Error(`Unknown log kind: ${kind}`);
    }

    return path.join(this.logDir, fileName);
  }

  async append(kind, payload) {
    const record = sanitizeForLog({
      timestamp: new Date().toISOString(),
      ...payload,
    });

    await fs.mkdir(this.logDir, { recursive: true });
    await fs.appendFile(this.filePath(kind), `${JSON.stringify(record)}\n`);
    return record;
  }

  async readAll(kind, options = {}) {
    const limit = options.limit || 200;

    try {
      const text = await fs.readFile(this.filePath(kind), "utf8");
      return text
        .trim()
        .split("\n")
        .filter(Boolean)
        .slice(-limit)
        .map((line) => JSON.parse(line));
    } catch (error) {
      if (error.code === "ENOENT") {
        return [];
      }

      throw error;
    }
  }

  async ensureFiles() {
    await fs.mkdir(this.logDir, { recursive: true });
    await Promise.all(
      Object.values(this.files).map(async (fileName) => {
        const filePath = path.join(this.logDir, fileName);

        try {
          await fs.access(filePath);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          await fs.writeFile(filePath, "");
        }
      }),
    );
  }
}

module.exports = {
  LOG_FILES,
  AppendOnlyLogStore,
  sanitizeForLog,
};
