const { buildGraph, mapToSortedObject } = require("../lib/marketGraph");
const {
  findUniqueTriangles,
  buildCanonicalCycles,
  getHubBreakdownCounts,
} = require("../lib/triangles");
const { calculateCycleMultiplier } = require("../lib/multiplier");
const { fetchUpbitMarkets, fetchOrderbooks } = require("../lib/upbitApi");
const {
  computeFeeMetrics,
  classifyOpportunity,
  buildStableCycleLayout,
  getCycleFreshness,
} = require("./liveUtils");

function parseFeeRate(value, defaultValue = 0) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }

  const feeRate = Number.parseFloat(value);

  if (!Number.isFinite(feeRate) || feeRate < 0 || feeRate >= 1) {
    throw new Error(`Invalid fee rate: ${value}`);
  }

  return feeRate;
}

function toCalculationOrderbook(topOfBook) {
  if (!topOfBook) {
    return null;
  }

  return {
    market: topOfBook.market,
    timestamp: topOfBook.timestamp,
    receivedAt: topOfBook.receivedAt,
    orderbook_units: [
      {
        ask_price: topOfBook.askPrice,
        bid_price: topOfBook.bidPrice,
        ask_size: topOfBook.askSize,
        bid_size: topOfBook.bidSize,
      },
    ],
  };
}

function normalizeRestOrderbook(orderbook, receivedAt = Date.now()) {
  const unit = orderbook && Array.isArray(orderbook.orderbook_units) && orderbook.orderbook_units[0];

  if (!orderbook || !unit) {
    return null;
  }

  return {
    market: orderbook.market,
    askPrice: Number(unit.ask_price),
    bidPrice: Number(unit.bid_price),
    askSize: Number(unit.ask_size),
    bidSize: Number(unit.bid_size),
    timestamp: Number(orderbook.timestamp),
    streamType: "REST",
    receivedAt,
  };
}

class LiveTriangleState {
  constructor(options = {}) {
    this.feeRate = parseFeeRate(options.feeRate, 0);
    this.staleOrderbookMs = options.staleOrderbookMs || 5000;
    this.serverStartedAt = new Date().toISOString();
    this.marketRows = [];
    this.quoteCounts = new Map();
    this.triangles = [];
    this.cycles = [];
    this.groups = [];
    this.groupCounts = {};
    this.orderbooks = new Map();
    this.wsStatus = {
      stopped: true,
      connections: [],
      openConnectionCount: 0,
    };
    this.lastCalculatedAt = null;
    this.lastOrderbookReceivedAt = null;
    this.lastFallbackPollAt = null;
    this.lastFallbackPollError = null;
  }

  async initialize() {
    const upbitMarkets = await fetchUpbitMarkets();
    const { normalizedMarkets, graph, pairMap, quoteCounts } = buildGraph(upbitMarkets);
    const triangles = findUniqueTriangles(graph, pairMap);
    const canonicalCycles = buildCanonicalCycles(triangles, pairMap);
    const layout = buildStableCycleLayout(canonicalCycles);

    this.marketRows = normalizedMarkets;
    this.quoteCounts = quoteCounts;
    this.triangles = triangles;
    this.cycles = layout.cycles;
    this.groups = layout.groups;
    this.groupCounts = layout.groupCounts;
    this.hubBreakdown = getHubBreakdownCounts(triangles);
    this.requiredMarkets = [...new Set(this.cycles.flatMap((cycle) => cycle.markets))].sort();
  }

  async loadInitialOrderbooks(options = {}) {
    const result = await fetchOrderbooks(this.requiredMarkets, options);
    const receivedAt = Date.now();

    for (const orderbook of result.orderbookMap.values()) {
      const normalized = normalizeRestOrderbook(orderbook, receivedAt);

      if (normalized) {
        this.updateOrderbook(normalized);
      }
    }

    this.lastFallbackPollAt = new Date(receivedAt).toISOString();
    this.lastFallbackPollError = result.errors.length > 0 ? result.errors : null;
    return result;
  }

  async fallbackPoll(options = {}) {
    try {
      const result = await this.loadInitialOrderbooks(options);
      this.lastFallbackPollError = result.errors.length > 0 ? result.errors : null;
      return result;
    } catch (error) {
      this.lastFallbackPollError = error.message;
      throw error;
    }
  }

  updateOrderbook(orderbook) {
    if (!orderbook || !orderbook.market) {
      return;
    }

    this.orderbooks.set(orderbook.market, orderbook);
    this.lastOrderbookReceivedAt = new Date(orderbook.receivedAt || Date.now()).toISOString();
  }

  setWsStatus(status) {
    this.wsStatus = status;
  }

  getCalculationOrderbooks() {
    return new Map(
      [...this.orderbooks.entries()].map(([market, topOfBook]) => [
        market,
        toCalculationOrderbook(topOfBook),
      ]),
    );
  }

  shouldUseFallback(nowMs = Date.now()) {
    if (!this.wsStatus || this.wsStatus.openConnectionCount === 0) {
      return true;
    }

    if (!this.lastOrderbookReceivedAt) {
      return true;
    }

    return nowMs - Date.parse(this.lastOrderbookReceivedAt) > this.staleOrderbookMs;
  }

  buildCycleRows(now = new Date()) {
    const calculatedAt = now.toISOString();
    const nowMs = now.getTime();
    const feeMetrics = computeFeeMetrics(this.feeRate);
    const calculationOrderbooks = this.getCalculationOrderbooks();

    return this.cycles.map((cycle) => {
      const freshness = getCycleFreshness(cycle, calculationOrderbooks, this.staleOrderbookMs, nowMs);
      const grossResult = calculateCycleMultiplier(cycle, null, calculationOrderbooks, 0);
      const grossCanonicalMultiplier = grossResult.available ? grossResult.multiplier : null;
      const grossProfitRate = grossCanonicalMultiplier === null ? null : grossCanonicalMultiplier - 1;
      const netCanonicalMultiplier = grossCanonicalMultiplier === null
        ? null
        : grossCanonicalMultiplier * feeMetrics.feeFactor;
      const netProfitRate = netCanonicalMultiplier === null ? null : netCanonicalMultiplier - 1;
      const impliedReverseGrossMultiplier = grossCanonicalMultiplier === null
        ? null
        : 1 / grossCanonicalMultiplier;
      const impliedReverseNetMultiplier = impliedReverseGrossMultiplier === null
        ? null
        : impliedReverseGrossMultiplier * feeMetrics.feeFactor;
      const status = freshness.status === "available" && !grossResult.available
        ? "unavailable"
        : freshness.status;
      const unavailableReason = freshness.unavailableReason || grossResult.unavailableReason || null;

      // The plotted reverse value is implied from the canonical gross multiplier. With real bid/ask orderbooks and fees, the executable reverse route must be recalculated before placing any order.
      return {
        cycleId: cycle.cycleId,
        group: cycle.group,
        groupLabel: cycle.groupLabel,
        groupIndex: cycle.groupIndex,
        allHub: cycle.allHub,
        x: cycle.x,
        y: grossCanonicalMultiplier,
        assets: cycle.triangleAssets,
        route: cycle.route,
        routeLabel: cycle.routeLabel,
        markets: cycle.markets,
        grossCanonicalMultiplier,
        netCanonicalMultiplier,
        grossProfitRate,
        netProfitRate,
        impliedReverseGrossMultiplier,
        impliedReverseNetMultiplier,
        feeRate: this.feeRate,
        upperBreakEven: feeMetrics.upperBreakEven,
        lowerBreakEven: feeMetrics.lowerBreakEven,
        status,
        opportunityClass: classifyOpportunity(grossCanonicalMultiplier, this.feeRate, status),
        unavailableReason,
        lastOrderbookTimestamp: freshness.lastOrderbookTimestamp,
        oldestOrderbookReceivedAt: freshness.oldestOrderbookReceivedAt,
        calculatedAt,
      };
    });
  }

  getSnapshot(now = new Date()) {
    const cycles = this.buildCycleRows(now);
    const availableCount = cycles.filter((cycle) => cycle.status === "available").length;
    const unavailableCount = cycles.length - availableCount;
    const feeMetrics = computeFeeMetrics(this.feeRate);

    this.lastCalculatedAt = now.toISOString();

    return {
      summary: {
        marketsLoaded: this.marketRows.length,
        quoteCounts: mapToSortedObject(this.quoteCounts),
        uniqueTriangles: this.triangles.length,
        canonicalCycles: this.cycles.length,
        availableLiveMultipliers: availableCount,
        unavailableOrStaleCycles: unavailableCount,
        feeRate: this.feeRate,
        upperBreakEven: feeMetrics.upperBreakEven,
        lowerBreakEven: feeMetrics.lowerBreakEven,
        lastUpdateTime: this.lastOrderbookReceivedAt,
        staleOrderbookMs: this.staleOrderbookMs,
        requiredMarketCount: this.requiredMarkets ? this.requiredMarkets.length : 0,
        fallbackLastPolledAt: this.lastFallbackPollAt,
        fallbackLastError: this.lastFallbackPollError,
      },
      groups: this.groups,
      groupCounts: this.groupCounts,
      cycles,
      serverStartedAt: this.serverStartedAt,
      lastCalculatedAt: this.lastCalculatedAt,
      wsStatus: this.wsStatus,
    };
  }

  getHealth() {
    return {
      ok: true,
      serverStartedAt: this.serverStartedAt,
      wsStatus: this.wsStatus,
      marketsLoaded: this.marketRows.length,
      cycles: this.cycles.length,
      lastOrderbookReceivedAt: this.lastOrderbookReceivedAt,
    };
  }
}

module.exports = {
  LiveTriangleState,
  parseFeeRate,
  normalizeRestOrderbook,
  toCalculationOrderbook,
};
