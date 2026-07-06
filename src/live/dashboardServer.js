const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { URL } = require("node:url");
const WebSocket = require("ws");
const { AppendOnlyLogStore } = require("../core/appendOnlyLog");
const { CommandStatusStore } = require("../core/commandStatusStore");
const { EventLog } = require("../core/eventLog");
const { commandFromPathname, createDashboardCommandApi } = require("../dashboard/commandApi");
const {
  createTelemetryReadModel,
  readDelta,
  readSnapshot,
} = require("../dashboard/telemetryReadModel");

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
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
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

function resolvePublicPath(publicDir, pathname) {
  const requestPath = pathname === "/" ? "/live-dashboard.html" : pathname;
  const normalized = path.normalize(requestPath).replace(/^(\.\.[/\\])+/, "");
  const resolved = path.join(publicDir, normalized);

  return resolved.startsWith(publicDir) ? resolved : null;
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
    sendText(res, error.code === "ENOENT" ? 404 : 500, error.code === "ENOENT" ? "Not found" : error.message);
  }
}

function createDashboardRequestHandler(options = {}) {
  const {
    publicDir = path.resolve(process.cwd(), "public"),
    snapshotPath = path.resolve(process.cwd(), "out", "runtime", "latest-snapshot.json"),
    commandStatusStore = new CommandStatusStore({
      runtimeDir: path.dirname(snapshotPath),
    }),
    plotlyPath = require.resolve("plotly.js-dist-min/plotly.min.js"),
    logStore = new AppendOnlyLogStore(),
    sseClients = new Set(),
  } = options;
  const eventLog = options.eventLog || new EventLog({
    logStore,
    eventBus: options.eventBus,
  });
  const telemetryReadModel = options.telemetryReadModel || createTelemetryReadModel({
    snapshotPath,
    logStore: eventLog,
  });
  const commandApi = options.commandApi || createDashboardCommandApi({
    eventLog,
    commandStatusStore,
    readSnapshot: () => telemetryReadModel.snapshot(),
  });

  return async function requestHandler(req, res) {
    if (!isLocalRequest(req)) {
      sendJson(res, 403, { ok: false, error: "localhost clients only" });
      return;
    }

    const requestUrl = new URL(req.url, "http://localhost");

    try {
      if (req.method === "GET" && ["/api/health", "/api/dashboard/health"].includes(requestUrl.pathname)) {
        sendJson(res, 200, await telemetryReadModel.health());
        return;
      }

      if (req.method === "GET" && ["/api/state", "/api/dashboard/snapshot"].includes(requestUrl.pathname)) {
        sendJson(res, 200, await telemetryReadModel.snapshot());
        return;
      }

      if (req.method === "GET" && ["/api/logs", "/api/dashboard/logs"].includes(requestUrl.pathname)) {
        sendJson(res, 200, await telemetryReadModel.logsFromUrl(requestUrl));
        return;
      }

      if (
        req.method === "GET" &&
        ["/api/dry-run-report", "/api/dashboard/dry-run-report"].includes(requestUrl.pathname)
      ) {
        const report = await telemetryReadModel.dryRunReportFromUrl(requestUrl);

        if (requestUrl.searchParams.get("format") === "csv") {
          res.writeHead(200, {
            "Content-Type": "text/csv; charset=utf-8",
            "Cache-Control": "no-store",
            "Content-Disposition": "attachment; filename=\"dry-run-report.csv\"",
          });
          res.end(report.csv);
          return;
        }

        sendJson(res, 200, {
          ok: true,
          summary: report.summary,
          logs: report.logs,
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

        try {
          const result = await commandApi.queue(await readJsonBody(req), pathCommand);
          sendJson(res, 202, result);
        } catch (error) {
          sendJson(res, 400, { ok: false, error: error.message });
        }
        return;
      }

      if (req.method === "GET" && requestUrl.pathname.startsWith("/api/commands/")) {
        const commandId = requestUrl.pathname.slice("/api/commands/".length);
        const status = await commandApi.readStatus(commandId);

        if (!status) {
          sendJson(res, 404, { ok: false, error: "Command status not found" });
          return;
        }

        sendJson(res, 200, { ok: true, status });
        return;
      }

      if (req.method === "GET" && requestUrl.pathname === "/api/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        sseClients.add(res);
        req.on("close", () => {
          sseClients.delete(res);
        });
        res.write(`event: state\ndata: ${JSON.stringify(await telemetryReadModel.snapshot())}\n\n`);
        return;
      }

      if (req.method === "GET" && requestUrl.pathname === "/vendor/plotly.min.js") {
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

async function startDashboardServer(options = {}) {
  const port = options.port !== undefined ? options.port : Number.parseInt(process.env.PORT || "3099", 10);
  const host = options.host || "127.0.0.1";
  const snapshotPath = options.snapshotPath || path.resolve(process.cwd(), "out", "runtime", "latest-snapshot.json");
  const deltaPath = options.deltaPath || path.resolve(process.cwd(), "out", "runtime", "latest-delta.json");
  const logStore = options.logStore || new AppendOnlyLogStore({
    logDir: options.logDir || path.resolve(process.cwd(), "out", "logs"),
  });
  const commandStatusStore = options.commandStatusStore || new CommandStatusStore({
    runtimeDir: path.dirname(snapshotPath),
  });
  const eventLog = options.eventLog || new EventLog({
    logStore,
    eventBus: options.eventBus,
  });
  const sseClients = new Set();
  const liveWsClients = new Set();
  const wsServer = new WebSocket.Server({ noServer: true });
  const telemetryReadModel = options.telemetryReadModel || createTelemetryReadModel({
    snapshotPath,
    logStore: eventLog,
  });
  const server = http.createServer(createDashboardRequestHandler({
    ...options,
    snapshotPath,
    logStore,
    commandStatusStore,
    sseClients,
    telemetryReadModel,
    eventLog,
  }));
  const pushIntervalMs = options.pushIntervalMs ||
    Number.parseInt(process.env.UI_PUSH_INTERVAL_MS || "250", 10);
  let lastPushedDeltaEpochMs = 0;

  wsServer.on("connection", async (socket) => {
    liveWsClients.add(socket);
    socket.send(JSON.stringify({
      type: "hello",
      sentAtEpochMs: Date.now(),
      uiPushIntervalMs: pushIntervalMs,
    }));
    socket.send(JSON.stringify(await telemetryReadModel.snapshot()));
    socket.on("message", (data) => {
      try {
        JSON.parse(data.toString("utf8"));
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

    wsServer.handleUpgrade(req, socket, head, (ws) => {
      wsServer.emit("connection", ws, req);
    });
  });

  async function pushDelta() {
    const delta = await readDelta(deltaPath);

    if (!delta) {
      return;
    }

    if (Number(delta.sentAtEpochMs || 0) <= lastPushedDeltaEpochMs) {
      return;
    }

    lastPushedDeltaEpochMs = Number(delta.sentAtEpochMs || 0);

    const message = JSON.stringify(delta);
    const sseMessage = `event: delta\ndata: ${message}\n\n`;

    for (const client of liveWsClients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }

    for (const client of sseClients) {
      client.write(sseMessage);
    }
  }

  const pushTimer = setInterval(() => {
    pushDelta().catch(() => {});
  }, pushIntervalMs);

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    server,
    url: `http://${host}:${server.address().port}`,
    close: async () => {
      clearInterval(pushTimer);
      for (const client of sseClients) client.end();
      for (const client of liveWsClients) client.close(1000, "dashboard shutdown");
      wsServer.close();
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

module.exports = {
  createDashboardRequestHandler,
  startDashboardServer,
  readDelta,
  readSnapshot,
};
