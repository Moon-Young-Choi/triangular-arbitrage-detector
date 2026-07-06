const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { URL } = require("node:url");
const WebSocket = require("ws");
const { LiveTriangleState, parseFeeRate } = require("./liveState");
const { loadRuntimeConfig } = require("../core/runtimeConfig");
const { AppendOnlyLogStore } = require("../core/appendOnlyLog");
const { CommandStatusStore } = require("../core/commandStatusStore");
const { normalizeDashboardCommandPayload } = require("../core/commandPolicy");
const { UpbitWsOrderbookClient } = require("../exchanges/upbit/publicWsOrderbookClient");
const { executionLogMode } = require("../execution/executionPlan");
const { dryRunReportCsv, summarizeDryRun } = require("../ops/dryRunReport");
const { readFilteredLogs } = require("./logReadModel");

function contentTypeFor(filePath) {
  const extension = path.extname(filePath);

  if (extension === ".html") return "text/html; charset=utf-8";
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".js") return "application/javascript; charset=utf-8";
  if (extension === ".json") return "application/json; charset=utf-8";
  if (extension === ".png") return "image/png";
  return "application/octet-stream";
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(`${JSON.stringify(payload)}\n`);
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(text);
}

function isLocalRequest(req) {
  const remoteAddress = req.socket.remoteAddress;

  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remoteAddress);
}

async function readJsonBody(req, maxBytes = 1024 * 1024) {
  let body = "";

  for await (const chunk of req) {
    body += chunk;

    if (Buffer.byteLength(body) > maxBytes) {
      throw new Error("Request body is too large");
    }
  }

  return JSON.parse(body || "{}");
}

function commandFromPathname(pathname) {
  if (!pathname.startsWith("/api/command/")) return null;

  const commandName = pathname.slice("/api/command/".length).toLowerCase();
  if (commandName === "start") return "Start";
  if (commandName === "pause") return "Pause";
  if (commandName === "stop") return "Stop";
  return undefined;
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

async function serveFile(res, filePath) {
  try {
    const data = await fs.readFile(filePath);
    res.writeHead(200, {
      "Content-Type": contentTypeFor(filePath),
      "Cache-Control": "no-store",
    });
    res.end(data);
  } catch (error) {
    if (error.code === "ENOENT") {
      sendText(res, 404, "Not found");
    } else {
      sendText(res, 500, error.message);
    }
  }
}

function resolvePublicPath(publicDir, pathname) {
  const requestPath = pathname === "/" ? "/live-dashboard.html" : pathname;
  const normalized = path.normalize(requestPath).replace(/^(\.\.[/\\])+/, "");
  const resolved = path.join(publicDir, normalized);

  if (!resolved.startsWith(publicDir)) {
    return null;
  }

  return resolved;
}

function createRequestHandler(options) {
  const {
    state,
    publicDir = path.resolve(process.cwd(), "public"),
    plotlyPath = null,
    logStore = new AppendOnlyLogStore(),
    commandStatusStore = new CommandStatusStore(),
    commandHandler = null,
    sseClients = new Set(),
  } = options;

  return async function requestHandler(req, res) {
    if (!isLocalRequest(req)) {
      sendJson(res, 403, { ok: false, error: "localhost clients only" });
      return;
    }

    const requestUrl = new URL(req.url, "http://localhost");

    try {
      if (req.method === "GET" && ["/api/health", "/api/dashboard/health"].includes(requestUrl.pathname)) {
        sendJson(res, 200, state.getHealth());
        return;
      }

      if (req.method === "GET" && ["/api/state", "/api/dashboard/snapshot"].includes(requestUrl.pathname)) {
        sendJson(res, 200, state.getSnapshot());
        return;
      }

      if (req.method === "GET" && ["/api/logs", "/api/dashboard/logs"].includes(requestUrl.pathname)) {
        const { kind, filters } = logFiltersFromUrl(requestUrl);
        sendJson(res, 200, {
          ok: true,
          kind,
          logs: await readFilteredLogs(logStore, filters),
        });
        return;
      }

      if (
        req.method === "GET" &&
        ["/api/dry-run-report", "/api/dashboard/dry-run-report"].includes(requestUrl.pathname)
      ) {
        const logs = await readFilteredLogs(logStore, {
          kind: "all",
          limit: Number.parseInt(requestUrl.searchParams.get("limit") || "5000", 10),
          mode: "DRY_RUN",
          from: requestUrl.searchParams.get("from") || "",
          to: requestUrl.searchParams.get("to") || "",
          sinceMs: requestUrl.searchParams.get("sinceMs") || "",
        });
        const summary = summarizeDryRun(logs);

        if (requestUrl.searchParams.get("format") === "csv") {
          res.writeHead(200, {
            "Content-Type": "text/csv; charset=utf-8",
            "Cache-Control": "no-store",
            "Content-Disposition": "attachment; filename=\"dry-run-report.csv\"",
          });
          res.end(dryRunReportCsv(summary));
          return;
        }

        sendJson(res, 200, {
          ok: true,
          summary,
          logs,
        });
        return;
      }

      const pathCommand = commandFromPathname(requestUrl.pathname);
      if (
        req.method === "POST" &&
        (requestUrl.pathname === "/api/command" || pathCommand !== null)
      ) {
        if (pathCommand === undefined) {
          sendJson(res, 400, { ok: false, error: "Invalid engine command endpoint" });
          return;
        }

        if (typeof commandHandler !== "function") {
          sendJson(res, 503, { ok: false, error: "Engine command handling is not configured" });
          return;
        }

        const payload = await readJsonBody(req);
        let request;

        try {
          if (pathCommand) {
            if (payload.command !== undefined) {
              const bodyRequest = normalizeDashboardCommandPayload(payload);
              if (bodyRequest.command !== pathCommand) {
                throw new Error(`Command path ${pathCommand} does not match payload command ${bodyRequest.command}`);
              }
              request = bodyRequest;
            } else {
              request = normalizeDashboardCommandPayload({ ...payload, command: pathCommand });
            }
          } else {
            request = normalizeDashboardCommandPayload(payload);
          }
        } catch (error) {
          sendJson(res, 400, { ok: false, error: error.message });
          return;
        }

        const commandId = crypto.randomUUID();
        const commandRunMode = request.runMode || (state.runtimeConfig && state.runtimeConfig.runMode);
        const record = await logStore.append("commands", {
          type: "dashboard.command",
          mode: executionLogMode(commandRunMode),
          engineState: state.engineState || "STOPPED",
          command: request.command,
          commandId,
          runMode: request.runMode,
          emergency: request.emergency === true,
          source: "dashboard",
        });
        await commandStatusStore.write(commandId, {
          status: "queued",
          command: request.command,
          runMode: request.runMode,
          emergency: request.emergency === true,
          source: "dashboard",
          queuedAt: record.timestamp,
        });

        commandHandler(request, { commandId, queuedAt: record.timestamp }).catch(async (error) => {
          await commandStatusStore.write(commandId, {
            status: "rejected",
            command: request.command,
            runMode: request.runMode,
            emergency: request.emergency === true,
            source: "dashboard",
            message: error.message,
          });
          await logStore.append("errors", {
            type: "engine.command.rejected",
            command: request.command,
            commandId,
            runMode: request.runMode,
            message: error.message,
          });
        });

        sendJson(res, 202, {
          ok: true,
          command: record.command,
          commandId: record.commandId,
          runMode: record.runMode,
          status: "queued",
        });
        return;
      }

      if (req.method === "GET" && requestUrl.pathname.startsWith("/api/commands/")) {
        const commandId = requestUrl.pathname.slice("/api/commands/".length);
        const status = await commandStatusStore.read(commandId);

        if (!status) {
          sendJson(res, 404, { ok: false, error: "Command status not found" });
          return;
        }

        sendJson(res, 200, { ok: true, status });
        return;
      }

      if (req.method === "POST" && requestUrl.pathname === "/api/settings") {
        sendJson(res, 403, {
          ok: false,
          error: "Dashboard mutation APIs are disabled. Change config while the engine is stopped and restart it.",
        });
        return;
      }

      if (req.method === "POST" && requestUrl.pathname === "/api/strategy") {
        sendJson(res, 403, {
          ok: false,
          error: "Dashboard strategy mutation is disabled. Select strategies through stopped runtime config only.",
        });
        return;
      }

      if (req.method === "GET" && requestUrl.pathname === "/api/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        res.write("retry: 2000\n\n");
        sseClients.add(res);
        req.on("close", () => {
          sseClients.delete(res);
        });
        res.write(`event: state\ndata: ${JSON.stringify(state.getSnapshot())}\n\n`);
        return;
      }

      if (req.method === "GET" && requestUrl.pathname === "/vendor/plotly.min.js") {
        if (!plotlyPath) {
          sendText(res, 410, "Browser dashboard assets are deprecated. Use npm run cli.");
          return;
        }
        await serveFile(res, plotlyPath);
        return;
      }

      if (req.method === "GET") {
        const resolved = resolvePublicPath(publicDir, requestUrl.pathname);

        if (!resolved) {
          sendText(res, 403, "Forbidden");
          return;
        }

        await serveFile(res, resolved);
        return;
      }

      sendJson(res, 405, { ok: false, error: "Method not allowed" });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message });
    }
  };
}

function sendSse(clients, eventName, payload) {
  const message = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;

  for (const client of clients) {
    client.write(message);
  }
}

function sendWs(clients, payload) {
  const message = JSON.stringify(payload);

  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

function clampInterval(value, defaultValue) {
  const parsed = Number.parseInt(value || "", 10);
  const interval = Number.isInteger(parsed) ? parsed : defaultValue;

  return Math.max(16, Math.min(1000, interval));
}

async function startLiveServer(options = {}) {
  const port = options.port !== undefined ? options.port : Number.parseInt(process.env.PORT || "3099", 10);
  const host = options.host || "127.0.0.1";
  const uiPushIntervalMs = clampInterval(options.uiPushIntervalMs || process.env.UI_PUSH_INTERVAL_MS, 250);
  const ssePushIntervalMs = options.ssePushIntervalMs ||
    Number.parseInt(process.env.SSE_PUSH_INTERVAL_MS || "1000", 10);
  const staleOrderbookMs = options.staleOrderbookMs ||
    Number.parseInt(process.env.STALE_ORDERBOOK_MS || "3000", 10);
  const orderbookBatchSize = Number.parseInt(process.env.UPBIT_ORDERBOOK_BATCH_SIZE || "50", 10);
  const orderbookDelayMs = Number.parseInt(process.env.UPBIT_ORDERBOOK_DELAY_MS || "200", 10);
  const wsMarketsPerConnection = Number.parseInt(process.env.UPBIT_WS_MARKETS_PER_CONNECTION || "100", 10);
  const logStore = options.logStore || new AppendOnlyLogStore({
    logDir: options.logDir || path.resolve(process.cwd(), "out", "logs"),
  });
  const commandStatusStore = options.commandStatusStore || new CommandStatusStore({
    runtimeDir: options.runtimeDir || path.resolve(process.cwd(), "out", "runtime"),
  });
  const runtimeConfig = options.runtimeConfig || loadRuntimeConfig({
    configPath: options.runtimeConfigPath,
    allowLiveTrading: process.env.Q_GAGARIN_ALLOW_LIVE_TRADING === "true",
  });
  const state = options.state || new LiveTriangleState({
    feeRate: parseFeeRate(process.env.UPBIT_TAKER_FEE_RATE, 0),
    staleOrderbookMs,
    runtimeConfig,
    logStore,
  });

  if (options.state && typeof state.setRuntimeConfig === "function" && !state.runtimeConfig) {
    state.setRuntimeConfig(runtimeConfig);
  }

  if (!options.skipInitialize) {
    await state.initialize();
    await state.loadInitialOrderbooks({
      batchSize: orderbookBatchSize,
      delayMs: orderbookDelayMs,
    });
  }

  const sseClients = new Set();
  const liveWsClients = new Set();
  const liveWsServer = new WebSocket.Server({ noServer: true });
  let feedsRunning = false;
  let wsClient = null;
  let validationWsClient = null;

  function startFeeds() {
    if (feedsRunning) return;
    state.engineState = "RUNNING";
    wsClient.start();
    validationWsClient.start();
    feedsRunning = true;
  }

  function stopFeeds() {
    wsClient.stop();
    validationWsClient.stop();
    feedsRunning = false;
  }

  async function applyLocalCommand(request, metadata = {}) {
    const previousState = state.engineState || "STOPPED";

    if (request.command === "Start") {
      if (request.runMode === "REAL_GUARDED") {
        throw new Error("REAL_GUARDED requires the separated engine runtime");
      }

      if (!["STOPPED", "PAUSED"].includes(previousState)) {
        throw new Error(`Cannot Start while ${previousState}`);
      }

      if (request.runMode && typeof state.setRuntimeConfig === "function") {
        state.setRuntimeConfig({
          ...state.runtimeConfig,
          runMode: request.runMode,
        });
      }

      startFeeds();
    } else if (request.command === "Pause") {
      if (previousState !== "RUNNING") {
        throw new Error(`Cannot Pause while ${previousState}`);
      }

      state.engineState = "PAUSED";
    } else if (request.command === "Stop") {
      if (!["RUNNING", "PAUSED", "ERROR", "STOPPED"].includes(previousState)) {
        throw new Error(`Cannot Stop while ${previousState}`);
      }

      stopFeeds();
      state.engineState = "STOPPED";
    }

    const nextState = state.engineState || "STOPPED";
    const event = await logStore.append("events", {
      type: "engine.state_changed",
      mode: executionLogMode(state.runtimeConfig && state.runtimeConfig.runMode),
      engineState: nextState,
      command: request.command,
      previousState,
      nextState,
      runMode: state.runtimeConfig && state.runtimeConfig.runMode,
      commandId: metadata.commandId,
      source: "combined-live-server",
    });
    await commandStatusStore.write(metadata.commandId, {
      status: "accepted",
      command: request.command,
      previousState,
      nextState,
      runMode: state.runtimeConfig && state.runtimeConfig.runMode,
      eventTimestamp: event.timestamp,
      source: "combined-live-server",
    });
    sendWs(liveWsClients, {
      type: "state",
      sentAtEpochMs: Date.now(),
      stateDelta: {
        engineState: nextState,
        runtimeConfig: state.runtimeConfig,
      },
    });
  }

  const server = http.createServer(createRequestHandler({
    state,
    sseClients,
    logStore,
    commandStatusStore,
    commandHandler: options.commandHandler || applyLocalCommand,
    publicDir: options.publicDir || path.resolve(process.cwd(), "public"),
  }));

  liveWsServer.on("connection", (socket) => {
    liveWsClients.add(socket);
    socket.send(JSON.stringify({
      type: "hello",
      sentAtEpochMs: Date.now(),
      uiPushIntervalMs,
      runtimeConfig,
    }));
    socket.send(JSON.stringify(state.getSnapshot()));

    socket.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString("utf8"));

        if (message.type === "client-metrics" && state.metrics) {
          if (typeof state.metrics.recordBrowserRender === "function") {
            state.metrics.recordBrowserRender(message);
          } else if (message.renderedFrames && typeof state.metrics.increment === "function") {
            state.metrics.increment("browserRenderedFrames", Number(message.renderedFrames) || 0);
          }
        }
      } catch (_error) {
        socket.send(JSON.stringify({
          type: "error",
          message: "Invalid client message",
        }));
      }
    });

    socket.on("close", () => {
      liveWsClients.delete(socket);
    });
  });

  server.on("upgrade", (req, socket, head) => {
    const requestUrl = new URL(req.url, "http://localhost");

    if (requestUrl.pathname !== "/ws/live" || !isLocalRequest(req)) {
      socket.destroy();
      return;
    }

    liveWsServer.handleUpgrade(req, socket, head, (ws) => {
      liveWsServer.emit("connection", ws, req);
    });
  });

  wsClient = options.wsClient || new UpbitWsOrderbookClient(state.requiredMarkets || [], {
    chunkSize: wsMarketsPerConnection,
    orderbookUnit: runtimeConfig.observationOrderbookUnit,
  });
  validationWsClient = options.validationWsClient || new UpbitWsOrderbookClient(state.requiredMarkets || [], {
    chunkSize: wsMarketsPerConnection,
    orderbookUnit: runtimeConfig.validationOrderbookUnit,
  });

  wsClient.on("orderbook", (orderbook) => {
    state.updateObservationOrderbook(orderbook);
  });
  wsClient.on("status", (status) => {
    state.setWsStatus(status, "observation");
    sendSse(sseClients, "status", status);
    sendWs(liveWsClients, {
      type: "status",
      feedName: "observation",
      sentAtEpochMs: Date.now(),
      status,
    });
  });
  wsClient.on("error", (error) => {
    sendSse(sseClients, "error", error);
    sendWs(liveWsClients, {
      type: "error",
      sentAtEpochMs: Date.now(),
      error,
    });
  });
  validationWsClient.on("orderbook", (orderbook) => {
    if (typeof state.updateValidationOrderbook === "function") {
      state.updateValidationOrderbook(orderbook);
    }
  });
  validationWsClient.on("status", (status) => {
    if (typeof state.setWsStatus === "function") {
      state.setWsStatus(status, "validation");
    }
    sendSse(sseClients, "validation-status", status);
    sendWs(liveWsClients, {
      type: "status",
      feedName: "validation",
      sentAtEpochMs: Date.now(),
      status,
    });
  });
  validationWsClient.on("error", (error) => {
    sendSse(sseClients, "error", error);
    sendWs(liveWsClients, {
      type: "error",
      feedName: "validation",
      sentAtEpochMs: Date.now(),
      error,
    });
  });

  let deltaTimer = null;
  let sseTimer = null;
  let fallbackTimer = null;

  const startTimers = () => {
    deltaTimer = setInterval(() => {
      if (liveWsClients.size === 0) {
        return;
      }

      const delta = state.consumeDelta();
      delta.sentAtEpochMs = Date.now();
      sendWs(liveWsClients, delta);
    }, uiPushIntervalMs);

    sseTimer = setInterval(() => {
      if (sseClients.size > 0) {
        sendSse(sseClients, "state", state.getSnapshot());
      }
    }, ssePushIntervalMs);

    fallbackTimer = setInterval(async () => {
      if (state.engineState !== "RUNNING" || !state.shouldUseFallback()) {
        return;
      }

      try {
        await state.fallbackPoll({
          batchSize: orderbookBatchSize,
          delayMs: orderbookDelayMs,
        });
      } catch (error) {
        sendSse(sseClients, "error", {
          type: "fallback",
          message: error.message,
        });
      }
    }, Math.max(staleOrderbookMs, 5000));
  };

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  if (!options.skipFeeds) {
    startFeeds();
  }
  startTimers();

  return {
    server,
    state,
    wsClient,
    validationWsClient,
    url: `http://${host}:${server.address().port}`,
    uiPushIntervalMs,
    runtimeConfig,
    close: async () => {
      if (deltaTimer) clearInterval(deltaTimer);
      if (sseTimer) clearInterval(sseTimer);
      if (fallbackTimer) clearInterval(fallbackTimer);
      stopFeeds();
      if (state.engineState === "RUNNING") {
        state.engineState = "STOPPED";
      }
      for (const client of sseClients) {
        client.end();
      }
      for (const client of liveWsClients) {
        client.close(1000, "server shutdown");
      }
      liveWsServer.close();
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

module.exports = {
  createRequestHandler,
  startLiveServer,
};
