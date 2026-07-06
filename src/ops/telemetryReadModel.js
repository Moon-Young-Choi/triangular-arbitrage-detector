const fs = require("node:fs/promises");
const path = require("node:path");
const { AppendOnlyLogStore } = require("../core/appendOnlyLog");
const {
  readFilteredLogs,
} = require("../live/logReadModel");
const {
  dryRunReportCsv,
  summarizeDryRun,
} = require("./dryRunReport");

function defaultSnapshot() {
  return {
    type: "full-state",
    summary: {
      marketsLoaded: 0,
      uniqueTriangleCount: 0,
      plottedCycleCount: 0,
    },
    cycles: [],
    groups: [],
    engine: {
      state: "STOPPED",
    },
    engineState: "STOPPED",
    eventLog: [],
  };
}

async function readSnapshot(snapshotPath) {
  try {
    return JSON.parse(await fs.readFile(snapshotPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return defaultSnapshot();
    }

    throw error;
  }
}

async function readDelta(deltaPath) {
  try {
    return JSON.parse(await fs.readFile(deltaPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

function logFiltersFromUrl(requestUrl) {
  const kind = requestUrl.searchParams.get("kind") || "all";
  const limit = Number.parseInt(requestUrl.searchParams.get("limit") || "200", 10);

  return {
    kind,
    filters: {
      kind,
      limit: Number.isInteger(limit) ? limit : 200,
      mode: requestUrl.searchParams.get("mode") || "",
      type: requestUrl.searchParams.get("type") || "",
      startAsset: requestUrl.searchParams.get("startAsset") || "",
      strategyId: requestUrl.searchParams.get("strategyId") || "",
      cycleId: requestUrl.searchParams.get("cycleId") || "",
      from: requestUrl.searchParams.get("from") || "",
      to: requestUrl.searchParams.get("to") || "",
      sinceMs: requestUrl.searchParams.get("sinceMs") || "",
    },
  };
}

function dryRunFiltersFromUrl(requestUrl) {
  const limit = Number.parseInt(requestUrl.searchParams.get("limit") || "5000", 10);

  return {
    kind: "all",
    limit: Number.isInteger(limit) ? limit : 5000,
    mode: "DRY_RUN",
    from: requestUrl.searchParams.get("from") || "",
    to: requestUrl.searchParams.get("to") || "",
    sinceMs: requestUrl.searchParams.get("sinceMs") || "",
  };
}

function createTelemetryReadModel(options = {}) {
  const snapshotPath = options.snapshotPath ||
    path.resolve(process.cwd(), "out", "runtime", "latest-snapshot.json");
  const logStore = options.logStore || new AppendOnlyLogStore({
    logDir: options.logDir || path.resolve(process.cwd(), "out", "logs"),
  });

  return {
    async health() {
      const snapshot = await readSnapshot(snapshotPath);

      return {
        ok: true,
        ops: true,
        engineState: snapshot.engineState || (snapshot.engine && snapshot.engine.state) || "UNKNOWN",
      };
    },

    snapshot() {
      return readSnapshot(snapshotPath);
    },

    delta(deltaPath = options.deltaPath || path.resolve(process.cwd(), "out", "runtime", "latest-delta.json")) {
      return readDelta(deltaPath);
    },

    async logs(filters = {}) {
      const kind = filters.kind || "all";

      return {
        ok: true,
        kind,
        logs: await readFilteredLogs(logStore, filters),
      };
    },

    async logsFromUrl(requestUrl) {
      const { kind, filters } = logFiltersFromUrl(requestUrl);

      return {
        ok: true,
        kind,
        logs: await readFilteredLogs(logStore, filters),
      };
    },

    async dryRunReport(filters = {}) {
      const logs = await readFilteredLogs(logStore, {
        kind: "all",
        limit: filters.limit || 5000,
        mode: "DRY_RUN",
        from: filters.from || "",
        to: filters.to || "",
        sinceMs: filters.sinceMs || "",
      });
      const summary = summarizeDryRun(logs);
      const csv = dryRunReportCsv(summary);

      return {
        ok: true,
        summary,
        logs,
        csv,
      };
    },

    async dryRunReportFromUrl(requestUrl) {
      const logs = await readFilteredLogs(logStore, dryRunFiltersFromUrl(requestUrl));
      const summary = summarizeDryRun(logs);
      const csv = dryRunReportCsv(summary);

      return {
        ok: true,
        summary,
        logs,
        csv,
      };
    },
  };
}

module.exports = {
  createTelemetryReadModel,
  defaultSnapshot,
  dryRunFiltersFromUrl,
  logFiltersFromUrl,
  readDelta,
  readSnapshot,
};
