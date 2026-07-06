const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { normalizeQueuedCommandRecord } = require("./commandPolicy");

function compactTimestamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(".", "-");
}

function safeFileName(name) {
  return String(name || "").replace(/[^a-zA-Z0-9._-]/g, "_");
}

async function renameWithFallback(fromPath, toPath) {
  try {
    await fs.rename(fromPath, toPath);
    return toPath;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const parsed = path.parse(toPath);
    const fallbackPath = path.join(parsed.dir, `${parsed.name}-${crypto.randomUUID()}${parsed.ext}`);
    await fs.rename(fromPath, fallbackPath);
    return fallbackPath;
  }
}

class CommandInbox {
  constructor(options = {}) {
    const runtimeDir = options.runtimeDir || path.resolve(process.cwd(), "out", "runtime");
    const commandDir = options.commandDir || path.join(runtimeDir, "commands");

    this.commandDir = commandDir;
    this.inboxDir = options.inboxDir || path.join(commandDir, "inbox");
    this.processedDir = options.processedDir || path.join(commandDir, "processed");
    this.tmpDir = options.tmpDir || path.join(commandDir, "tmp");
    this.randomUUID = options.randomUUID || crypto.randomUUID;
    this.now = options.now || (() => new Date());
  }

  async ensureDirs() {
    await fs.mkdir(this.inboxDir, { recursive: true });
    await fs.mkdir(this.processedDir, { recursive: true });
    await fs.mkdir(this.tmpDir, { recursive: true });
  }

  commandFileName(commandId, date = this.now()) {
    return `${compactTimestamp(date)}-${safeFileName(commandId)}.json`;
  }

  async enqueue(payload = {}) {
    await this.ensureDirs();

    const commandId = payload.commandId || this.randomUUID();
    const createdAt = payload.createdAt || this.now().toISOString();
    const normalized = normalizeQueuedCommandRecord({
      ...payload,
      commandId,
      source: payload.source || "cli",
    });
    const record = {
      type: payload.type || `${normalized.source || "cli"}.command`,
      createdAt,
      commandId,
      command: normalized.command,
      source: normalized.source || "cli",
      ...(normalized.runMode ? { runMode: normalized.runMode } : {}),
      ...(normalized.emergency ? { emergency: true } : {}),
    };
    const fileName = this.commandFileName(commandId, new Date(createdAt));
    const tmpPath = path.join(this.tmpDir, `${fileName}.${process.pid}.${this.randomUUID()}.tmp`);
    const finalPath = path.join(this.inboxDir, fileName);

    await fs.writeFile(tmpPath, `${JSON.stringify(record, null, 2)}\n`);
    await fs.rename(tmpPath, finalPath);

    return {
      ...record,
      fileName,
      filePath: finalPath,
    };
  }

  async listPending() {
    await this.ensureDirs();
    const names = await fs.readdir(this.inboxDir);
    const jsonNames = names.filter((name) => name.endsWith(".json")).sort();
    const records = [];

    for (const fileName of jsonNames) {
      const filePath = path.join(this.inboxDir, fileName);
      try {
        const record = JSON.parse(await fs.readFile(filePath, "utf8"));
        records.push({ fileName, filePath, record });
      } catch (error) {
        if (error.code !== "ENOENT") {
          records.push({
            fileName,
            filePath,
            record: null,
            error,
          });
        }
      }
    }

    return records;
  }

  async markProcessed(entry) {
    await this.ensureDirs();
    const fromPath = entry.filePath;
    const commandId = entry.record && entry.record.commandId || path.parse(entry.fileName).name;
    const toPath = path.join(this.processedDir, this.commandFileName(commandId));

    return renameWithFallback(fromPath, toPath);
  }
}

module.exports = {
  CommandInbox,
  compactTimestamp,
};
