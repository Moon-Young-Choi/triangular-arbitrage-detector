const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { URL } = require("node:url");
const { LiveTriangleState, parseFeeRate } = require("./liveState");
const { formatLocalTimestampForFilename } = require("./liveUtils");
const { UpbitWsOrderbookClient } = require("../upbit/wsOrderbookClient");

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

async function readJsonBody(req, maxBytes = 20 * 1024 * 1024) {
  let body = "";

  for await (const chunk of req) {
    body += chunk;

    if (Buffer.byteLength(body) > maxBytes) {
      throw new Error("Request body is too large");
    }
  }

  return JSON.parse(body || "{}");
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

async function saveCapture(capturesDir, payload) {
  const { imageDataUrl, snapshot, timestamp } = payload;

  if (typeof imageDataUrl !== "string" || !imageDataUrl.startsWith("data:image/png;base64,")) {
    throw new Error("imageDataUrl must be a PNG data URL");
  }

  const requestedDate = timestamp ? new Date(timestamp) : new Date();
  const captureDate = Number.isNaN(requestedDate.getTime()) ? new Date() : requestedDate;
  const stamp = formatLocalTimestampForFilename(captureDate);
  const baseName = `upbit-canonical-cycles-${stamp}`;
  const pngPath = path.join(capturesDir, `${baseName}.png`);
  const jsonPath = path.join(capturesDir, `${baseName}.json`);
  const base64 = imageDataUrl.slice("data:image/png;base64,".length);
  const imageBuffer = Buffer.from(base64, "base64");

  if (imageBuffer.length === 0) {
    throw new Error("PNG payload is empty");
  }

  await fs.mkdir(capturesDir, { recursive: true });
  await fs.writeFile(pngPath, imageBuffer);
  await fs.writeFile(jsonPath, `${JSON.stringify({ timestamp: captureDate.toISOString(), snapshot }, null, 2)}\n`);

  return {
    ok: true,
    pngPath,
    jsonPath,
  };
}

function createRequestHandler(options) {
  const {
    state,
    publicDir = path.resolve(process.cwd(), "public"),
    capturesDir = path.resolve(process.cwd(), "out", "captures"),
    plotlyPath = require.resolve("plotly.js-dist-min/plotly.min.js"),
    sseClients = new Set(),
  } = options;

  return async function requestHandler(req, res) {
    if (!isLocalRequest(req)) {
      sendJson(res, 403, { ok: false, error: "localhost clients only" });
      return;
    }

    const requestUrl = new URL(req.url, "http://localhost");

    try {
      if (req.method === "GET" && requestUrl.pathname === "/api/health") {
        sendJson(res, 200, state.getHealth());
        return;
      }

      if (req.method === "GET" && requestUrl.pathname === "/api/state") {
        sendJson(res, 200, state.getSnapshot());
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

      if (req.method === "POST" && requestUrl.pathname === "/api/capture") {
        const payload = await readJsonBody(req);
        const saved = await saveCapture(capturesDir, payload);

        sendJson(res, 200, {
          ok: true,
          pngPath: path.relative(process.cwd(), saved.pngPath),
          jsonPath: path.relative(process.cwd(), saved.jsonPath),
        });
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

function sendSse(clients, eventName, payload) {
  const message = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;

  for (const client of clients) {
    client.write(message);
  }
}

async function startLiveServer(options = {}) {
  const port = options.port || Number.parseInt(process.env.PORT || "3099", 10);
  const host = options.host || "127.0.0.1";
  const uiPushIntervalMs = options.uiPushIntervalMs ||
    Number.parseInt(process.env.UI_PUSH_INTERVAL_MS || "1000", 10);
  const staleOrderbookMs = options.staleOrderbookMs ||
    Number.parseInt(process.env.STALE_ORDERBOOK_MS || "5000", 10);
  const orderbookBatchSize = Number.parseInt(process.env.UPBIT_ORDERBOOK_BATCH_SIZE || "50", 10);
  const orderbookDelayMs = Number.parseInt(process.env.UPBIT_ORDERBOOK_DELAY_MS || "200", 10);
  const wsMarketsPerConnection = Number.parseInt(process.env.UPBIT_WS_MARKETS_PER_CONNECTION || "100", 10);
  const state = options.state || new LiveTriangleState({
    feeRate: parseFeeRate(process.env.UPBIT_TAKER_FEE_RATE, 0),
    staleOrderbookMs,
  });

  if (!options.skipInitialize) {
    await state.initialize();
    await state.loadInitialOrderbooks({
      batchSize: orderbookBatchSize,
      delayMs: orderbookDelayMs,
    });
  }

  const sseClients = new Set();
  const server = http.createServer(createRequestHandler({
    state,
    sseClients,
    publicDir: options.publicDir || path.resolve(process.cwd(), "public"),
    capturesDir: options.capturesDir || path.resolve(process.cwd(), "out", "captures"),
  }));

  const wsClient = options.wsClient || new UpbitWsOrderbookClient(state.requiredMarkets || [], {
    chunkSize: wsMarketsPerConnection,
  });

  wsClient.on("orderbook", (orderbook) => {
    state.updateOrderbook(orderbook);
  });
  wsClient.on("status", (status) => {
    state.setWsStatus(status);
    sendSse(sseClients, "status", status);
  });
  wsClient.on("error", (error) => {
    sendSse(sseClients, "error", error);
  });

  const stateTimer = setInterval(() => {
    sendSse(sseClients, "state", state.getSnapshot());
  }, uiPushIntervalMs);

  const fallbackTimer = setInterval(async () => {
    if (!state.shouldUseFallback()) {
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

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  if (!options.skipFeeds) {
    wsClient.start();
  }

  return {
    server,
    state,
    wsClient,
    url: `http://${host}:${server.address().port}`,
    close: async () => {
      clearInterval(stateTimer);
      clearInterval(fallbackTimer);
      wsClient.stop();
      for (const client of sseClients) {
        client.end();
      }
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

module.exports = {
  createRequestHandler,
  saveCapture,
  startLiveServer,
};
