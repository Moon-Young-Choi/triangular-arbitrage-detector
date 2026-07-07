const axios = require("axios");
const crypto = require("node:crypto");
const { createJwtToken, createQueryString } = require("./auth");
const { groupForExchangeRequest } = require("./rateLimitScheduler");

const DEFAULT_BASE_URL = "https://api.upbit.com/v1";

function normalizeOrderChance(response) {
  const market = response.market || {};
  const bid = market.bid || {};
  const ask = market.ask || {};
  const bidAccount = response.bid_account || {};
  const askAccount = response.ask_account || {};

  return {
    bidFee: Number(response.bid_fee),
    askFee: Number(response.ask_fee),
    makerBidFee: Number(response.maker_bid_fee ?? response.bid_fee),
    makerAskFee: Number(response.maker_ask_fee ?? response.ask_fee),
    market: {
      id: market.id,
      bid: {
        ...bid,
        minTotal: bid.min_total ?? bid.minTotal ?? market.min_total ?? market.minTotal,
        maxTotal: bid.max_total ?? bid.maxTotal ?? market.max_total ?? market.maxTotal,
      },
      ask: {
        ...ask,
        minTotal: ask.min_total ?? ask.minTotal ?? market.min_total ?? market.minTotal,
        maxTotal: ask.max_total ?? ask.maxTotal ?? market.max_total ?? market.maxTotal,
      },
      maxTotal: market.max_total,
      minTotal: market.min_total,
      state: market.state,
    },
    bidAccount,
    askAccount,
    raw: response,
  };
}

function pickDefined(source = {}, keys = []) {
  return Object.fromEntries(
    keys
      .filter((key) => source[key] !== undefined && source[key] !== null)
      .map((key) => [key, source[key]]),
  );
}

function summarizeRestPayload(payload) {
  if (!payload) return null;

  if (Array.isArray(payload)) {
    return {
      type: "array",
      count: payload.length,
      currencies: payload
        .map((item) => item && item.currency)
        .filter(Boolean)
        .slice(0, 20),
    };
  }

  if (typeof payload !== "object") {
    return {
      type: typeof payload,
    };
  }

  const summary = pickDefined(payload, [
    "market",
    "uuid",
    "identifier",
    "side",
    "ord_type",
    "order_type",
    "state",
    "price",
    "volume",
    "remaining_volume",
    "executed_volume",
    "avg_price",
    "paid_fee",
    "trade_fee",
    "time_in_force",
    "bid_fee",
    "ask_fee",
    "maker_bid_fee",
    "maker_ask_fee",
    "from",
    "to",
    "currency",
    "amount",
  ]);

  if (payload.market && typeof payload.market === "object") {
    summary.market = pickDefined(payload.market, ["id", "state", "min_total", "max_total"]);
  }

  if (payload.bid_account || payload.ask_account) {
    summary.accounts = {
      bidCurrency: payload.bid_account && payload.bid_account.currency,
      askCurrency: payload.ask_account && payload.ask_account.currency,
      hasBidBalance: Boolean(payload.bid_account),
      hasAskBalance: Boolean(payload.ask_account),
    };
  }

  return summary;
}

function summarizeRestError(error) {
  const response = error && error.response;
  const data = response && response.data;
  const upbitError = data && data.error;

  return {
    status: response && response.status,
    code: upbitError && upbitError.name || error && error.code || null,
    message: upbitError && upbitError.message || error && error.message || "REST request failed",
  };
}

class UpbitExchangeRestClient {
  constructor(options = {}) {
    this.accessKey = options.accessKey || process.env.UPBIT_ACCESS_KEY;
    this.secretKey = options.secretKey || process.env.UPBIT_SECRET_KEY;
    this.baseUrl = options.baseUrl || DEFAULT_BASE_URL;
    this.client = options.client || axios.create({ baseURL: this.baseUrl, timeout: options.timeout || 15000 });
    this.liveTradingEnabled = options.liveTradingEnabled === true;
    this.chanceTtlMs = options.chanceTtlMs || 30000;
    this.chanceCache = new Map();
    this.logStore = options.logStore || null;
    this.mode = options.mode || (this.liveTradingEnabled ? "REAL" : "OBSERVE");
    this.scheduler = options.scheduler || null;
  }

  assertCredentials() {
    if (!this.accessKey || !this.secretKey) {
      throw new Error("Upbit API credentials are required");
    }
  }

  authHeaders(query) {
    this.assertCredentials();
    return {
      Authorization: `Bearer ${createJwtToken({
        accessKey: this.accessKey,
        secretKey: this.secretKey,
        query,
      })}`,
    };
  }

  appendRestAudit(type, payload = {}) {
    if (!this.logStore) return null;

    const event = {
      type,
      mode: payload.mode || this.mode,
      exchange: "upbit",
      ...payload,
    };

    this.logStore.append("events", event).catch(() => {});
    return event;
  }

  refuseTradingMutation(operation, method, pathname, payload, payloadKey) {
    const requestId = payload && (payload.identifier || payload.uuid) || crypto.randomUUID();
    this.appendRestAudit("exchange.rest.refused", {
      requestId,
      traceId: requestId,
      method,
      pathname,
      operation,
      reason: "LIVE_TRADING_DISABLED",
      [payloadKey]: summarizeRestPayload(payload),
    });
    throw new Error(`${operation} refused because liveTradingEnabled=false`);
  }

  async request(method, pathname, options = {}) {
    const params = options.params || null;
    const body = options.body || null;
    const query = method === "GET" || method === "DELETE" ? params : body;
    const requestId = options.requestId || crypto.randomUUID();
    const startedAtMs = Date.now();

    this.appendRestAudit("exchange.rest.request", {
      requestId,
      traceId: options.traceId || requestId,
      method,
      pathname,
      params: summarizeRestPayload(params),
      body: summarizeRestPayload(body),
      startedAtMs,
    });

    try {
      const execute = () => this.client.request({
        method,
        url: pathname,
        params,
        data: body,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...this.authHeaders(query),
        },
        paramsSerializer: (value) => createQueryString(value),
      });
      const group = options.rateLimitGroup || groupForExchangeRequest(method, pathname);
      const priority = options.priority || "normal";
      const response = this.scheduler
        ? await this.scheduler.scheduleRest(group, priority, `${method} ${pathname}`, execute, {
            requestId,
            traceId: options.traceId || requestId,
          })
        : await execute();
      const completedAtMs = Date.now();

      this.appendRestAudit("exchange.rest.response", {
        requestId,
        traceId: options.traceId || requestId,
        method,
        pathname,
        status: response.status || 200,
        latencyMs: completedAtMs - startedAtMs,
        response: summarizeRestPayload(response.data),
        completedAtMs,
      });

      return response.data;
    } catch (error) {
      const completedAtMs = Date.now();

      this.appendRestAudit("exchange.rest.error", {
        requestId,
        traceId: options.traceId || requestId,
        method,
        pathname,
        latencyMs: completedAtMs - startedAtMs,
        error: summarizeRestError(error),
        completedAtMs,
      });

      throw error;
    }
  }

  async getAccounts() {
    return this.request("GET", "/accounts", {
      priority: "normal",
      rateLimitGroup: "exchange.default",
    });
  }

  async getPockets() {
    return this.request("GET", "/pockets", {
      priority: "normal",
      rateLimitGroup: "exchange.default",
    });
  }

  async getSubPocketAssets(uuid) {
    return this.request("GET", "/pockets/assets", {
      params: { uuid },
      priority: "normal",
      rateLimitGroup: "exchange.default",
    });
  }

  async getOrderChance(market) {
    const cached = this.chanceCache.get(market);
    const now = Date.now();

    if (cached && now - cached.cachedAt < this.chanceTtlMs) {
      return cached.value;
    }

    const value = normalizeOrderChance(await this.request("GET", "/orders/chance", {
      params: { market },
      priority: "normal",
      rateLimitGroup: "exchange.default",
    }));
    this.chanceCache.set(market, { cachedAt: now, value });
    return value;
  }

  async createOrder(order) {
    if (!this.liveTradingEnabled) {
      this.refuseTradingMutation("createOrder", "POST", "/orders", order, "body");
    }

    return this.request("POST", "/orders", {
      body: order,
      priority: "trading",
      rateLimitGroup: "order",
    });
  }

  async cancelOrder(params) {
    if (!this.liveTradingEnabled) {
      this.refuseTradingMutation("cancelOrder", "DELETE", "/order", params, "params");
    }

    return this.request("DELETE", "/order", {
      params,
      priority: "critical",
      rateLimitGroup: "exchange.default",
    });
  }

  async transferFromMainPocket(transfer) {
    if (!this.liveTradingEnabled) {
      this.refuseTradingMutation("transferFromMainPocket", "POST", "/pockets/universal_transfers", transfer, "body");
    }

    return this.request("POST", "/pockets/universal_transfers", {
      body: transfer,
      priority: "critical",
      rateLimitGroup: "exchange.default",
    });
  }

  async transferFromSubPocket(transfer) {
    if (!this.liveTradingEnabled) {
      this.refuseTradingMutation("transferFromSubPocket", "POST", "/pockets/transfers", transfer, "body");
    }

    return this.request("POST", "/pockets/transfers", {
      body: transfer,
      priority: "critical",
      rateLimitGroup: "exchange.default",
    });
  }

  async getOrder(params) {
    return this.request("GET", "/order", {
      params,
      priority: "critical",
      rateLimitGroup: "exchange.default",
    });
  }

  async checkPermissions(options = {}) {
    const result = {
      viewAccounts: false,
      viewOrdersChance: false,
      errors: [],
    };

    try {
      result.accounts = await this.getAccounts();
      result.viewAccounts = true;
    } catch (error) {
      result.errors.push({
        permission: "View Accounts",
        message: error.response ? `HTTP ${error.response.status}` : error.message,
      });
    }

    if (options.market) {
      try {
        await this.getOrderChance(options.market);
        result.viewOrdersChance = true;
      } catch (error) {
        result.errors.push({
          permission: "View Orders",
          message: error.response ? `HTTP ${error.response.status}` : error.message,
        });
      }
    }

    return result;
  }
}

module.exports = {
  DEFAULT_BASE_URL,
  UpbitExchangeRestClient,
  normalizeOrderChance,
  summarizeRestError,
  summarizeRestPayload,
};
