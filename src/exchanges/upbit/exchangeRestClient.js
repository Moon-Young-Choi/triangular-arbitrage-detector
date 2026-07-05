const axios = require("axios");
const { createJwtToken, createQueryString } = require("./auth");

const DEFAULT_BASE_URL = "https://api.upbit.com/v1";

function normalizeOrderChance(response) {
  const market = response.market || {};
  const bidAccount = response.bid_account || {};
  const askAccount = response.ask_account || {};

  return {
    bidFee: Number(response.bid_fee),
    askFee: Number(response.ask_fee),
    makerBidFee: Number(response.maker_bid_fee ?? response.bid_fee),
    makerAskFee: Number(response.maker_ask_fee ?? response.ask_fee),
    market: {
      id: market.id,
      bid: market.bid,
      ask: market.ask,
      maxTotal: market.max_total,
      minTotal: market.min_total,
      state: market.state,
    },
    bidAccount,
    askAccount,
    raw: response,
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

  async request(method, pathname, options = {}) {
    const params = options.params || null;
    const body = options.body || null;
    const query = method === "GET" || method === "DELETE" ? params : body;
    const response = await this.client.request({
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

    return response.data;
  }

  async getAccounts() {
    return this.request("GET", "/accounts");
  }

  async getOrderChance(market) {
    const cached = this.chanceCache.get(market);
    const now = Date.now();

    if (cached && now - cached.cachedAt < this.chanceTtlMs) {
      return cached.value;
    }

    const value = normalizeOrderChance(await this.request("GET", "/orders/chance", {
      params: { market },
    }));
    this.chanceCache.set(market, { cachedAt: now, value });
    return value;
  }

  async createOrder(order) {
    if (!this.liveTradingEnabled) {
      throw new Error("createOrder refused because liveTradingEnabled=false");
    }

    return this.request("POST", "/orders", { body: order });
  }

  async cancelOrder(params) {
    return this.request("DELETE", "/order", { params });
  }

  async getOrder(params) {
    return this.request("GET", "/order", { params });
  }

  async checkPermissions(options = {}) {
    const result = {
      viewAccounts: false,
      viewOrdersChance: false,
      errors: [],
    };

    try {
      await this.getAccounts();
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
};
