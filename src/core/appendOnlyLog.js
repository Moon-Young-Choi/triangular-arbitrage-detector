const fs = require("node:fs/promises");
const path = require("node:path");
const {
  AUDIT_COMMON_KEYS,
  auditPayload,
  buildAuditRecord,
  resolveTraceId,
} = require("./auditEvent");

const LOG_FILES = Object.freeze({
  events: "events.ndjson",
  decisions: "decisions.ndjson",
  market: "market.ndjson",
  orders: "orders.ndjson",
  fills: "fills.ndjson",
  errors: "errors.ndjson",
  commands: "commands.ndjson",
});

const SECRET_KEY_PATTERN = /(secret|accessKey|access_key|authorization|token)/i;
const DEFAULT_TAIL_READ_BYTES = 8 * 1024 * 1024;
const TAIL_CHUNK_BYTES = 64 * 1024;

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
    this.writeQueue = Promise.resolve();
  }

  filePath(kind) {
    const fileName = this.files[kind];

    if (!fileName) {
      throw new Error(`Unknown log kind: ${kind}`);
    }

    return path.join(this.logDir, fileName);
  }

  async append(kind, payload = {}) {
    const auditRecord = buildAuditRecord(kind, payload);
    const record = sanitizeForLog(auditRecord);
    const write = async () => {
      await fs.mkdir(this.logDir, { recursive: true });
      await fs.appendFile(this.filePath(kind), `${JSON.stringify(record)}\n`);
      return record;
    };

    this.writeQueue = this.writeQueue.then(write, write);
    return this.writeQueue;
  }

  async readAll(kind, options = {}) {
    const limit = options.limit || 200;
    const maxBytes = Number.isFinite(Number(options.maxBytes))
      ? Math.max(1024, Number(options.maxBytes))
      : DEFAULT_TAIL_READ_BYTES;

    let file;
    try {
      file = await fs.open(this.filePath(kind), "r");
      const stats = await file.stat();

      if (stats.size === 0 || limit <= 0) {
        return [];
      }

      let position = stats.size;
      let bytesCollected = 0;
      let newlineCount = 0;
      const chunks = [];

      while (position > 0 && bytesCollected < maxBytes && newlineCount <= limit) {
        const readSize = Math.min(TAIL_CHUNK_BYTES, position, maxBytes - bytesCollected);
        const buffer = Buffer.alloc(readSize);
        position -= readSize;

        const { bytesRead } = await file.read(buffer, 0, readSize, position);
        if (bytesRead <= 0) break;

        const chunk = buffer.subarray(0, bytesRead);
        for (const byte of chunk) {
          if (byte === 10) newlineCount += 1;
        }
        chunks.unshift(chunk);
        bytesCollected += bytesRead;
      }

      const text = Buffer.concat(chunks).toString("utf8");
      const lines = text
        .trim()
        .split("\n")
        .filter(Boolean);
      const completeLines = position > 0 ? lines.slice(1) : lines;

      return completeLines.slice(-limit).map((line) => JSON.parse(line));
    } catch (error) {
      if (error.code === "ENOENT") {
        return [];
      }

      throw error;
    } finally {
      if (file) {
        await file.close();
      }
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
  AUDIT_COMMON_KEYS,
  auditPayload,
  buildAuditRecord,
  resolveTraceId,
  sanitizeForLog,
};
