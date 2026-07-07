const axios = require("axios");

const BASE_URL = "https://api.upbit.com/v1";

function chunk(items, size) {
  const chunks = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function fetchUpbitMarkets(client = axios, options = {}) {
  const execute = () => client.get(`${BASE_URL}/market/all`, {
    params: { is_details: "true" },
    headers: { Accept: "application/json" },
    timeout: 15000,
  });
  const response = options.scheduler
    ? await options.scheduler.scheduleRest("market", options.priority || "normal", "market/all", execute)
    : await execute();

  if (!Array.isArray(response.data)) {
    throw new Error("Unexpected Upbit market/all response");
  }

  return response.data;
}

async function fetchOrderbooks(marketCodes, options = {}) {
  const {
    client = axios,
    batchSize = 50,
    delayMs = 200,
    scheduler = null,
    priority = "warmup",
    onProgress = null,
  } = options;

  const uniqueMarkets = [...new Set(marketCodes)].sort();
  const orderbookMap = new Map();
  const errors = [];
  const batches = chunk(uniqueMarkets, batchSize);

  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];

    try {
      const execute = () => client.get(`${BASE_URL}/orderbook`, {
        params: { markets: batch.join(",") },
        headers: { Accept: "application/json" },
        timeout: 15000,
      });
      const response = scheduler
        ? await scheduler.scheduleRest("orderbook", priority, "orderbook", execute, {
            batchIndex: index,
            batchCount: batches.length,
            marketCount: batch.length,
          })
        : await execute();

      if (!Array.isArray(response.data)) {
        throw new Error("Unexpected Upbit orderbook response");
      }

      for (const orderbook of response.data) {
        if (orderbook && orderbook.market) {
          orderbookMap.set(orderbook.market, orderbook);
        }
      }
      if (typeof onProgress === "function") {
        onProgress({
          batchIndex: index,
          batchCount: batches.length,
          requestedMarketCount: uniqueMarkets.length,
          fetchedMarketCount: orderbookMap.size,
        });
      }
    } catch (error) {
      errors.push({
        markets: batch,
        message: error.response
          ? `HTTP ${error.response.status}: ${JSON.stringify(error.response.data)}`
          : error.message,
      });
    }

    if (index < batches.length - 1 && delayMs > 0) {
      await sleep(delayMs);
    }
  }

  return {
    orderbookMap,
    errors,
    requestedMarketCount: uniqueMarkets.length,
    fetchedMarketCount: orderbookMap.size,
  };
}

module.exports = {
  fetchUpbitMarkets,
  fetchOrderbooks,
};
