const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_ENV_PATH = path.resolve(process.cwd(), ".env");

function stripInlineComment(value) {
  let quote = null;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const previous = value[index - 1];

    if ((char === "\"" || char === "'") && previous !== "\\") {
      quote = quote === char ? null : quote || char;
      continue;
    }

    if (char === "#" && quote === null) {
      return value.slice(0, index).trimEnd();
    }
  }

  return value.trimEnd();
}

function parseEnvValue(rawValue = "") {
  const value = stripInlineComment(String(rawValue).trim());
  if (value.length < 2) return value;

  const quote = value[0];
  if ((quote !== "\"" && quote !== "'") || value[value.length - 1] !== quote) {
    return value;
  }

  const inner = value.slice(1, -1);
  if (quote === "'") return inner;

  return inner
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, "\"")
    .replace(/\\\\/g, "\\");
}

function parseEnvFile(text = "") {
  const values = {};

  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const normalized = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const equalsIndex = normalized.indexOf("=");
    if (equalsIndex <= 0) continue;

    const key = normalized.slice(0, equalsIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    values[key] = parseEnvValue(normalized.slice(equalsIndex + 1));
  }

  return values;
}

function loadEnvFile(options = {}) {
  const envPath = options.envPath || DEFAULT_ENV_PATH;
  let parsed;

  try {
    parsed = parseEnvFile(fs.readFileSync(envPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return { loaded: false, path: envPath, values: {} };
    }

    throw error;
  }

  for (const [key, value] of Object.entries(parsed)) {
    if (options.override === true || process.env[key] === undefined) {
      process.env[key] = value;
    }
  }

  return { loaded: true, path: envPath, values: parsed };
}

module.exports = {
  DEFAULT_ENV_PATH,
  loadEnvFile,
  parseEnvFile,
};
