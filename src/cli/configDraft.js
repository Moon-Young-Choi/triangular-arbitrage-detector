const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  DEFAULT_RUNTIME_CONFIG,
  DEFAULT_RUNTIME_CONFIG_PATH,
  validateRuntimeConfig,
} = require("../core/runtimeConfig");

const DEFAULT_DRAFT_CONFIG_PATH = path.resolve(process.cwd(), "config", "runtime.draft.json");

async function readJsonIfExists(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(tmpPath, filePath);
}

async function readActiveConfig(configPath = DEFAULT_RUNTIME_CONFIG_PATH) {
  return readJsonIfExists(configPath, JSON.parse(JSON.stringify(DEFAULT_RUNTIME_CONFIG)));
}

async function readDraftConfig(draftPath = DEFAULT_DRAFT_CONFIG_PATH) {
  return readJsonIfExists(draftPath, null);
}

async function baseDraftConfig(options = {}) {
  return await readDraftConfig(options.draftPath) || await readActiveConfig(options.configPath);
}

function parseConfigValue(raw) {
  const value = String(raw);
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function setConfigPath(config, dottedPath, value) {
  const parts = String(dottedPath || "").split(".").filter(Boolean);
  if (parts.length === 0) {
    throw new Error("Config path is required");
  }

  let cursor = config;
  for (const part of parts.slice(0, -1)) {
    if (!cursor[part] || typeof cursor[part] !== "object" || Array.isArray(cursor[part])) {
      cursor[part] = {};
    }
    cursor = cursor[part];
  }

  cursor[parts[parts.length - 1]] = value;
  return config;
}

function getConfigPath(config, dottedPath) {
  const parts = String(dottedPath || "").split(".").filter(Boolean);
  let cursor = config;

  for (const part of parts) {
    if (!cursor || typeof cursor !== "object" || !(part in cursor)) {
      return undefined;
    }
    cursor = cursor[part];
  }

  return cursor;
}

function diffConfigs(left, right, prefix = "") {
  const rows = [];
  const keys = new Set([
    ...Object.keys(left && typeof left === "object" ? left : {}),
    ...Object.keys(right && typeof right === "object" ? right : {}),
  ]);

  for (const key of [...keys].sort()) {
    const pathKey = prefix ? `${prefix}.${key}` : key;
    const leftValue = left && typeof left === "object" ? left[key] : undefined;
    const rightValue = right && typeof right === "object" ? right[key] : undefined;
    const bothObjects = leftValue && rightValue &&
      typeof leftValue === "object" &&
      typeof rightValue === "object" &&
      !Array.isArray(leftValue) &&
      !Array.isArray(rightValue);

    if (bothObjects) {
      rows.push(...diffConfigs(leftValue, rightValue, pathKey));
    } else if (JSON.stringify(leftValue) !== JSON.stringify(rightValue)) {
      rows.push({
        path: pathKey,
        active: leftValue,
        draft: rightValue,
      });
    }
  }

  return rows;
}

function validateConfig(config, options = {}) {
  return validateRuntimeConfig(config, {
    allowLiveTrading: options.allowLiveTrading === true,
  });
}

module.exports = {
  DEFAULT_DRAFT_CONFIG_PATH,
  baseDraftConfig,
  diffConfigs,
  getConfigPath,
  parseConfigValue,
  readActiveConfig,
  readDraftConfig,
  setConfigPath,
  validateConfig,
  writeJsonAtomic,
};
