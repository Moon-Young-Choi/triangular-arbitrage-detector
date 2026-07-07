const EventEmitter = require("node:events");
const crypto = require("node:crypto");
const WebSocket = require("ws");
const { createJwtToken } = require("./auth");

const DEFAULT_PRIVATE_WS_ENDPOINT = "wss://api.upbit.com/websocket/v1/private";

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeMyOrderEvent(payload = {}) {
  const state = payload.state || payload.order_state || payload.ty || null;
  const tradeTimestamp = payload.trade_timestamp || payload.trade_timestamp_ms || payload.ttms || null;
  const orderTimestamp = payload.created_at || payload.order_timestamp || payload.order_timestamp_ms || payload.otms || null;
  const eventTimestamp = payload.timestamp || payload.tms || Date.now();

  return {
    uuid: payload.uuid || null,
    identifier: payload.identifier || null,
    market: payload.code || payload.market || null,
    side: payload.side || null,
    orderType: payload.ord_type || payload.order_type || null,
    state,
    price: numberOrNull(payload.price),
    avgPrice: numberOrNull(payload.avg_price || payload.avgPrice),
    volume: numberOrNull(payload.volume),
    remainingVolume: numberOrNull(payload.remaining_volume || payload.remainingVolume),
    executedVolume: numberOrNull(payload.executed_volume || payload.executedVolume),
    paidFee: numberOrNull(payload.paid_fee || payload.paidFee),
    tradeFee: numberOrNull(payload.trade_fee || payload.tradeFee),
    isMaker: payload.is_maker === true || payload.isMaker === true,
    tradeTimestamp,
    orderTimestamp,
    eventTimestamp,
    raw: payload,
  };
}

class UpbitPrivateWsClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.endpoint = options.endpoint || DEFAULT_PRIVATE_WS_ENDPOINT;
    this.accessKey = options.accessKey || process.env.UPBIT_ACCESS_KEY;
    this.secretKey = options.secretKey || process.env.UPBIT_SECRET_KEY;
    this.codes = Array.isArray(options.codes) ? options.codes : [];
    this.WebSocket = options.WebSocket || WebSocket;
    this.pingIntervalMs = options.pingIntervalMs || 20000;
    this.reconnectMinMs = options.reconnectMinMs || 1000;
    this.reconnectMaxMs = options.reconnectMaxMs || 30000;
    this.scheduler = options.scheduler || null;
    this.ws = null;
    this.pingTimer = null;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.stopped = true;
    this.lastMessageAt = null;
  }

  authHeader() {
    if (!this.accessKey || !this.secretKey) {
      throw new Error("Upbit API credentials are required for private WebSocket");
    }

    return `Bearer ${createJwtToken({
      accessKey: this.accessKey,
      secretKey: this.secretKey,
    })}`;
  }

  start() {
    this.stopped = false;
    this.open();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.pingTimer);
    clearTimeout(this.reconnectTimer);

    if (this.ws && this.ws.readyState === this.WebSocket.OPEN) {
      this.ws.close(1000, "private ws shutdown");
    } else if (this.ws) {
      this.ws.terminate();
    }

    this.emit("status", this.getStatus());
  }

  open() {
    const open = () => {
      if (this.stopped) return null;
      const headers = {
        Authorization: this.authHeader(),
      };
      const ws = new this.WebSocket(this.endpoint, { headers });
      this.ws = ws;
      this.emit("status", this.getStatus("connecting"));

      ws.on("open", () => {
      this.reconnectAttempt = 0;
      const payload = JSON.stringify([
        { ticket: `q-gagarin-private-${crypto.randomUUID()}` },
        { type: "myOrder", codes: this.codes },
      ]);
      const sendSubscription = () => new Promise((resolve, reject) => {
        ws.send(payload, (error) => {
          if (error) reject(error);
          else resolve({ ok: true });
        });
      });
      if (this.scheduler && typeof this.scheduler.scheduleWebSocketMessage === "function") {
        this.scheduler.scheduleWebSocketMessage(
          "private:myOrder",
          "critical",
          "private-myorder-subscribe",
          sendSubscription,
        ).catch((error) => {
          this.emit("error", {
            type: "websocket-message",
            message: error.message,
          });
        });
      } else {
        sendSubscription().catch((error) => {
          this.emit("error", {
            type: "websocket-message",
            message: error.message,
          });
        });
      }
      this.pingTimer = setInterval(() => {
        if (ws.readyState === this.WebSocket.OPEN) {
          ws.ping();
        }
      }, this.pingIntervalMs);
      this.emit("status", this.getStatus("open"));
      });

      ws.on("message", (data) => {
      this.lastMessageAt = Date.now();

      try {
        const payload = JSON.parse(data.toString("utf8"));
        this.emit("myOrder", normalizeMyOrderEvent(payload));
      } catch (error) {
        this.emit("error", {
          type: "parse",
          message: error.message,
        });
      }
      });

      ws.on("error", (error) => {
      this.emit("error", {
        type: "websocket",
        message: error.message,
      });
      });

      ws.on("close", (code, reason) => {
      clearInterval(this.pingTimer);
      this.emit("status", this.getStatus("closed", { code, reason: reason.toString("utf8") }));

      if (!this.stopped) {
        const delayMs = Math.min(this.reconnectMinMs * 2 ** this.reconnectAttempt, this.reconnectMaxMs);
        this.reconnectAttempt += 1;
        this.reconnectTimer = setTimeout(() => {
          if (!this.stopped) this.open();
        }, delayMs);
      }
      });

      return ws;
    };

    if (this.scheduler && typeof this.scheduler.scheduleWebSocketConnect === "function") {
      this.emit("status", this.getStatus("queued"));
      this.scheduler.scheduleWebSocketConnect(
        "critical",
        "private-myorder-connect",
        open,
      ).catch((error) => {
        this.emit("status", this.getStatus("failed"));
        this.emit("error", {
          type: "websocket-connect",
          message: error.message,
        });
      });
    } else {
      open();
    }
  }

  getStatus(status, metadata = {}) {
    return {
      endpoint: this.endpoint,
      status: status || (this.stopped ? "stopped" : "unknown"),
      stopped: this.stopped,
      lastMessageAt: this.lastMessageAt,
      reconnectAttempt: this.reconnectAttempt,
      ...metadata,
    };
  }
}

module.exports = {
  DEFAULT_PRIVATE_WS_ENDPOINT,
  UpbitPrivateWsClient,
  normalizeMyOrderEvent,
};
