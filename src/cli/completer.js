const { COMMANDS } = require("./commandRegistry");

const START_ASSETS = ["KRW", "BTC", "USDT"];
const LOG_KINDS = ["events", "decisions", "orders", "fills", "errors"];
const RUN_MODES = ["OBSERVE", "DRY_RUN", "REAL", "REAL_GUARDED"];
const OUTPUT_FORMATS = ["json", "csv", "txt"];
const STRATEGY_IDS = ["topOfBookBaseline", "depthAwareLimitIoc"];

const COMMAND_DETAILS = COMMANDS.map(([usage, description]) => ({
  value: usage.split(/\s+/)[0],
  usage,
  description,
}));
const COMMAND_NAMES = COMMAND_DETAILS.map((command) => command.value);
const HELP_COMMAND_NAMES = COMMAND_NAMES.map((command) => command.slice(1));

const COMMON_OPTIONS = [
  entry("--json", "Print JSON output when supported"),
  entry("--watch", "Refresh this command repeatedly"),
];

const COMMAND_COMPLETIONS = {
  "/help": {
    argsByPosition: [
      HELP_COMMAND_NAMES.map((command) => entry(command, `Show help for /${command}`)),
    ],
  },
  "/start": {
    argsByPosition: [[
      entry("observe", "Observe markets without simulated or real execution"),
      entry("dry", "Run simulated executions without real orders"),
      entry("real-guarded", "Request real trading after readiness checks"),
    ]],
    options: [
      entry("--follow", "Follow executed contract details after Start"),
      entry("--limit", "Maximum contract rows to read while following"),
      entry("--color", "always or never"),
    ],
  },
  "/market": {
    argsByPosition: [[
      entry("feeds", "Show public and private feed status"),
      entry("fees", "Show loaded fee and market policies"),
      entry("stale", "Show stale orderbook counts"),
      entry("latency", "Show market-data latency budget"),
      entry("exchanges", "Show configured exchange support"),
    ]],
  },
  "/strategy": {
    argsByPosition: [[
      entry("list", "List configured strategies"),
      entry("active", "Show active strategy"),
      entry("explain", "Explain a strategy contract"),
      entry("select", "Select strategy for the next start"),
    ]],
    argsByFirstArg: {
      explain: {
        1: STRATEGY_IDS.map((strategy) => entry(strategy, "Configured strategy id")),
      },
      select: {
        1: STRATEGY_IDS.map((strategy) => entry(strategy, "Configured strategy id")),
      },
    },
  },
  "/system": {
    argsByPosition: [[
      entry("perf", "Show process and event-loop metrics"),
      entry("latency", "Show latency budget"),
      entry("guards", "Show guard state"),
      entry("files", "Show runtime file paths"),
    ]],
  },
  "/execution": {
    argsByPosition: [[
      entry("contracts", "Show executed contract details"),
      entry("orders", "Show latest orders"),
      entry("fills", "Show latest fills"),
      entry("pnl", "Show real-run PnL summary"),
      entry("residuals", "Show residual assets"),
      entry("guards", "Show execution guard state"),
    ]],
  },
  "/contracts": {
    options: [
      entry("--follow", "Follow new executed contracts"),
      entry("--limit", "Maximum rows to read"),
      entry("--mode", "DRY_RUN or REAL"),
      entry("--start", "Filter by start asset"),
      entry("--strategy", "Filter by strategy id"),
      entry("--cycle", "Filter by cycle id"),
      entry("--sinceMs", "Lookback window in milliseconds"),
      entry("--from", "Start timestamp"),
      entry("--to", "End timestamp"),
      entry("--color", "always or never"),
      entry("--no-color", "Disable ANSI colors"),
    ],
    optionValues: {
      mode: RUN_MODES.map((mode) => entry(mode, "Run mode")),
      start: START_ASSETS.map((asset) => entry(asset, "Start asset")),
      strategy: STRATEGY_IDS.map((strategy) => entry(strategy, "Strategy id")),
      limit: [entry("10", "Compact history"), entry("50", "Follow buffer")],
      color: [entry("always", "Force ANSI colors"), entry("never", "Disable ANSI colors")],
    },
  },
  "/logs": {
    options: [
      entry("--kind", "events, decisions, orders, fills, or errors"),
      entry("--follow", "Follow new log rows"),
      entry("--limit", "Maximum rows to read"),
      entry("--mode", "Filter by run mode"),
      entry("--start", "Filter by start asset"),
      entry("--strategy", "Filter by strategy id"),
      entry("--cycle", "Filter by cycle id"),
      entry("--type", "Filter by event type"),
    ],
    optionValues: {
      kind: LOG_KINDS.map((kind) => entry(kind, "Log kind")),
      mode: RUN_MODES.map((mode) => entry(mode, "Run mode")),
      start: START_ASSETS.map((asset) => entry(asset, "Start asset")),
      strategy: STRATEGY_IDS.map((strategy) => entry(strategy, "Strategy id")),
      limit: [entry("50", "Recent rows"), entry("200", "Larger sample")],
    },
  },
  "/dryrun": {
    argsByPosition: [[entry("report", "Show dry-run review report")]],
    options: [
      entry("--format", "json or csv"),
      entry("--limit", "Maximum rows to inspect"),
      entry("--sinceMs", "Lookback window in milliseconds"),
      entry("--from", "Start timestamp"),
      entry("--to", "End timestamp"),
    ],
    optionValues: {
      format: ["json", "csv"].map((format) => entry(format, "Report output format")),
      limit: [entry("5000", "Default report sample")],
    },
  },
  "/replay": {
    argsByPosition: [[entry("dryrun", "Replay dry-run from a tape")]],
    options: [
      entry("--tape", "Orderbook tape JSON path"),
      entry("--cycles", "Cycle JSON path"),
      entry("--config", "Runtime config path"),
      entry("--nowMs", "Deterministic replay clock"),
      entry("--format", "summary, json, or csv"),
    ],
    optionValues: {
      format: ["summary", "json", "csv"].map((format) => entry(format, "Replay output format")),
    },
  },
  "/config": {
    argsByPosition: [[
      entry("show", "Show active config"),
      entry("validate", "Validate active or draft config"),
      entry("draft", "Inspect or edit draft config"),
    ]],
    argsByFirstArg: {
      draft: {
        1: [
          entry("show", "Show draft config"),
          entry("set", "Set a draft config path"),
          entry("diff", "Compare active and draft config"),
          entry("save", "Save draft when engine is stopped"),
        ],
      },
    },
    options: [entry("--draft", "Use draft config")],
  },
  "/opportunity": {
    argsByPosition: [[
      entry("show", "Show selected desk opportunity"),
      entry("legs", "Show route leg details"),
      entry("latency", "Show opportunity latency"),
      entry("plan", "Show execution plan"),
    ], [
      entry("#1", "Top desk row"),
      entry("#2", "Second desk row"),
      entry("#3", "Third desk row"),
    ]],
  },
  "/export": {
    argsByPosition: [[entry("desk", "Export current desk ranking")]],
    options: [entry("--format", "txt, json, or csv"), entry("--start", "Filter by start asset")],
    optionValues: {
      format: OUTPUT_FORMATS.map((format) => entry(format, "Export output format")),
      start: START_ASSETS.map((asset) => entry(asset, "Start asset")),
    },
  },
  "/desk": {
    options: [
      entry("--start", "KRW, BTC, or USDT"),
      entry("--top", "Maximum rows to show"),
      entry("--profitable", "Only positive net opportunities"),
      entry("--format", "json or csv"),
    ],
    optionValues: {
      start: START_ASSETS.map((asset) => entry(asset, "Start asset")),
      top: [entry("10", "Compact view"), entry("20", "Default view"), entry("50", "Larger view")],
      format: ["json", "csv"].map((format) => entry(format, "Desk output format")),
    },
  },
};

function entry(value, description = "") {
  return { value, description };
}

function uniqueEntries(entries = []) {
  const seen = new Set();
  const result = [];

  for (const item of entries) {
    const normalized = typeof item === "string" ? entry(item) : item;
    if (!normalized || !normalized.value || seen.has(normalized.value)) continue;
    seen.add(normalized.value);
    result.push(normalized);
  }

  return result;
}

function matchingEntries(entries = [], prefix = "") {
  const normalizedPrefix = String(prefix || "");
  return uniqueEntries(entries).filter((item) => item.value.startsWith(normalizedPrefix));
}

function optionKey(token = "") {
  if (!String(token).startsWith("--")) return "";
  return String(token).slice(2).split("=")[0];
}

function completionContext(line = "") {
  const input = String(line || "");
  const text = input.trimStart();
  const endsWithSpace = /\s$/.test(input);
  const tokens = text ? text.split(/\s+/) : [];
  const currentIndex = endsWithSpace ? tokens.length : Math.max(0, tokens.length - 1);
  const current = endsWithSpace ? "" : tokens[currentIndex] || "";
  const previous = currentIndex > 0 ? tokens[currentIndex - 1] : "";
  const command = tokens[0] && tokens[0].startsWith("/")
    ? tokens[0].toLowerCase()
    : "";

  return {
    input,
    text,
    tokens,
    command,
    current,
    currentIndex,
    previous,
    endsWithSpace,
  };
}

function commandEntries(prefix = "") {
  return matchingEntries(COMMAND_DETAILS, prefix);
}

function commandSpec(command) {
  return COMMAND_COMPLETIONS[command] || {};
}

function optionEntries(spec = {}) {
  return uniqueEntries([...(spec.options || []), ...COMMON_OPTIONS]);
}

function argsBeforeCurrent(context) {
  const end = context.endsWithSpace ? context.tokens.length : context.currentIndex;
  return context.tokens.slice(1, end).filter((token, index, tokens) => {
    if (token.startsWith("--")) return false;
    const previous = tokens[index - 1];
    return !(previous && previous.startsWith("--"));
  });
}

function argumentEntries(spec, context) {
  const previousArgs = argsBeforeCurrent(context);
  const position = previousArgs.length;
  const firstArg = previousArgs[0];
  const scoped = firstArg &&
    spec.argsByFirstArg &&
    spec.argsByFirstArg[firstArg] &&
    spec.argsByFirstArg[firstArg][position];

  return scoped || spec.argsByPosition && spec.argsByPosition[position] || [];
}

function optionValueEntries(spec, context) {
  const inlineMatch = context.current.match(/^--([^=]+)=(.*)$/);
  if (inlineMatch) {
    const key = inlineMatch[1];
    const valuePrefix = inlineMatch[2];
    const values = spec.optionValues && spec.optionValues[key] || [];
    return {
      target: context.current,
      entries: matchingEntries(values.map((item) => {
        const normalized = typeof item === "string" ? entry(item) : item;
        return entry(`--${key}=${normalized.value}`, normalized.description);
      }), `--${key}=${valuePrefix}`),
    };
  }

  const previousKey = optionKey(context.previous);
  if (previousKey && !context.current.startsWith("--")) {
    const values = spec.optionValues && spec.optionValues[previousKey] || [];
    return {
      target: context.current,
      entries: matchingEntries(values, context.current),
    };
  }

  return null;
}

function completionMatches(line = "") {
  const context = completionContext(line);

  if (!context.text || context.currentIndex === 0) {
    const prefix = context.text ? context.current : "";
    if (prefix && !prefix.startsWith("/")) return { target: context.current, entries: [] };
    return { target: context.current, entries: commandEntries(prefix) };
  }

  const spec = commandSpec(context.command);
  const valueMatch = optionValueEntries(spec, context);
  if (valueMatch && valueMatch.entries.length > 0) return valueMatch;

  if (context.current.startsWith("--")) {
    return {
      target: context.current,
      entries: matchingEntries(optionEntries(spec), context.current),
    };
  }

  const argMatches = matchingEntries(argumentEntries(spec, context), context.current);
  if (argMatches.length > 0) {
    return { target: context.current, entries: argMatches };
  }

  if (!context.current) {
    return {
      target: context.current,
      entries: optionEntries(spec),
    };
  }

  return { target: context.current, entries: [] };
}

function completeSlashCommand(line = "") {
  const { target, entries } = completionMatches(line);
  const hits = entries.map((item) => item.value);

  return [hits.length > 0 ? hits : COMMAND_NAMES, target];
}

function suggestSlashCommand(line = "", options = {}) {
  const context = completionContext(line);
  if (!context.text.startsWith("/")) return [];

  const limit = Math.max(1, Number.parseInt(options.limit || "8", 10));
  const { entries } = completionMatches(line);
  return entries.slice(0, limit);
}

function renderSlashCommandSuggestions(line = "", options = {}) {
  const suggestions = suggestSlashCommand(line, options);
  if (suggestions.length === 0) return "";

  const width = Math.min(28, Math.max(12, ...suggestions.map((item) => item.value.length + 2)));
  const rows = suggestions.map((item) => {
    const value = item.value.padEnd(width, " ");
    return `  ${value}${item.description || ""}`.trimEnd();
  });

  return rows.join("\n");
}

module.exports = {
  COMMAND_NAMES,
  completeSlashCommand,
  renderSlashCommandSuggestions,
  suggestSlashCommand,
};
