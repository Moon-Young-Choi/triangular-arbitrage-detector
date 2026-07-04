const { buildGraph, mapToSortedObject } = require("../lib/marketGraph");
const {
  findUniqueTriangles,
  buildDirectionalCycles,
  getHubBreakdownCounts,
} = require("../lib/triangles");
const { calculateCycleMultiplier } = require("../lib/multiplier");
const { fetchUpbitMarkets, fetchOrderbooks } = require("../lib/upbitApi");
const { RuntimeMetrics } = require("./metrics");
const {
  computeFeeMetrics,
  classifyOpportunity,
  buildStableCycleLayout,
  getCycleFreshness,
  calculateLatencyBreakdown,
} = require("./liveUtils");
const { performance } = require("node:perf_hooks");

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
    streamType: topOfBook.streamType,
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

function markerColorFor(direction, status, isActuallyProfitable) {
  if (status === "stale" || status === "unavailable") {
    return "#aeb8c5";
  }

  if (isActuallyProfitable) {
    return direction === "reverse" ? "#d83f7b" : "#14845f";
  }

  return "#2d6f9f";
}

function compactCycleForDelta(row) {
  return {
    triangleId: row.triangleId,
    cycleId: row.cycleId,
    direction: row.direction,
    directionLabel: row.directionLabel,
    y: row.y,
    grossMultiplier: row.grossMultiplier,
    netMultiplier: row.netMultiplier,
    grossProfitRate: row.grossProfitRate,
    netProfitRate: row.netProfitRate,
    markerColor: row.markerColor,
    markerSymbol: row.markerSymbol,
    status: row.status,
    isActuallyProfitable: row.isActuallyProfitable,
    unavailableReason: row.unavailableReason,
    staleReason: row.staleReason,
    legs: row.legs,
    history: row.history,
    latency: row.latency,
    lastChangedMarket: row.lastChangedMarket,
    lastUpbitTimestampMs: row.lastUpbitTimestampMs,
    calculatedAtEpochMs: row.calculatedAtEpochMs,
    calculatedAtIso: row.calculatedAtIso,
  };
}

class LiveTriangleState {
  constructor(options = {}) {
    this.feeRate = parseFeeRate(options.feeRate, 0);
    this.staleOrderbookMs = options.staleOrderbookMs || 3000;
    this.serverStartedAt = new Date().toISOString();
    this.marketRows = [];
    this.quoteCounts = new Map();
    this.triangles = [];
    this.cycles = [];
    this.cycleIndex = new Map();
    this.cycleRows = new Map();
    this.cycleHistory = new Map();
    this.marketToCycleIds = new Map();
    this.dirtyCycleIds = new Set();
    this.groups = [];
    this.groupCounts = {};
    this.xRange = { min: 0.25, max: 1.75 };
    this.orderbooks = new Map();
    this.wsStatus = {
      stopped: true,
      connections: [],
      openConnectionCount: 0,
    };
    this.metrics = options.metrics || new RuntimeMetrics();
    this.lastCalculatedAt = null;
    this.lastOrderbookReceivedAt = null;
    this.lastFallbackPollAt = null;
    this.lastFallbackPollError = null;
  }

  async initialize() {
    const upbitMarkets = await fetchUpbitMarkets();
    const { normalizedMarkets, graph, pairMap, quoteCounts } = buildGraph(upbitMarkets);
    const triangles = findUniqueTriangles(graph, pairMap);
    const directionalCycles = buildDirectionalCycles(triangles, pairMap);
    const layout = buildStableCycleLayout(directionalCycles);

    this.marketRows = normalizedMarkets;
    this.quoteCounts = quoteCounts;
    this.triangles = triangles;
    this.cycles = layout.cycles;
    this.cycleIndex = new Map(this.cycles.map((cycle) => [cycle.cycleId, cycle]));
    this.groups = layout.groups;
    this.groupCounts = layout.groupCounts;
    this.xRange = layout.xRange;
    this.hubBreakdown = getHubBreakdownCounts(triangles);
    this.requiredMarkets = [...new Set(this.cycles.flatMap((cycle) => cycle.markets))].sort();
    this.marketToCycleIds = this.buildMarketToCycleIds();
    this.recalculateAll({ markDirty: false });
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
      return [];
    }

    const cacheUpdatedPerfMs = performance.now();
    this.orderbooks.set(orderbook.market, orderbook);
    this.lastOrderbookReceivedAt = new Date(orderbook.receivedAt || Date.now()).toISOString();

    if (orderbook.streamType !== "REST") {
      this.metrics.increment("upbitOrderbookMessages");
      this.metrics.increment("parsedMessages");
    }

    const affectedCycleIds = [...(this.marketToCycleIds.get(orderbook.market) || [])];
    const timings = {
      ...(orderbook.timings || {}),
      upbitTimestampMs: Number(orderbook.timestamp),
      orderbookCacheUpdatedPerfMs: cacheUpdatedPerfMs,
    };

    this.recalculateCycles(affectedCycleIds, {
      markDirty: true,
      lastChangedMarket: orderbook.market,
      lastUpbitTimestampMs: Number(orderbook.timestamp),
      timings,
    });

    return affectedCycleIds;
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

  buildMarketToCycleIds() {
    const index = new Map();

    for (const cycle of this.cycles) {
      for (const market of cycle.markets) {
        if (!index.has(market)) {
          index.set(market, new Set());
        }

        index.get(market).add(cycle.cycleId);
      }
    }

    return index;
  }

  setFeeRate(value) {
    this.feeRate = parseFeeRate(value, this.feeRate);
    this.recalculateAll({ markDirty: true });
  }

  appendHistory(row) {
    if (row.grossMultiplier === null) {
      row.history = this.cycleHistory.get(row.cycleId) || [];
      return;
    }

    const history = this.cycleHistory.get(row.cycleId) || [];
    history.push({
      timestamp: row.calculatedAtIso,
      grossMultiplier: row.grossMultiplier,
      netMultiplier: row.netMultiplier,
      latency: row.latency,
    });

    const trimmed = history.slice(-20);
    this.cycleHistory.set(row.cycleId, trimmed);
    row.history = trimmed;
  }

  recalculateCycle(cycleId, options = {}) {
    const cycle = this.cycleIndex.get(cycleId);

    if (!cycle) {
      return null;
    }

    const calculatedAtEpochMs = options.nowMs || Date.now();
    const calculatedAtIso = new Date(calculatedAtEpochMs).toISOString();
    const calculationOrderbooks = options.calculationOrderbooks || this.getCalculationOrderbooks();
    const feeMetrics = computeFeeMetrics(this.feeRate);
    const calculationStartPerfMs = performance.now();
    const freshness = getCycleFreshness(cycle, calculationOrderbooks, this.staleOrderbookMs, calculatedAtEpochMs);
    const grossResult = calculateCycleMultiplier(cycle, null, calculationOrderbooks, 0, {
      nowMs: calculatedAtEpochMs,
    });
    const netResult = calculateCycleMultiplier(cycle, null, calculationOrderbooks, this.feeRate, {
      nowMs: calculatedAtEpochMs,
    });
    const calculationEndPerfMs = performance.now();
    const grossMultiplier = grossResult.available ? grossResult.multiplier : null;
    const netMultiplier = netResult.available ? netResult.multiplier : null;
    const status = freshness.status === "available" && (!grossResult.available || !netResult.available)
      ? "unavailable"
      : freshness.status;
    const unavailableReason = freshness.unavailableReason ||
      grossResult.unavailableReason ||
      netResult.unavailableReason ||
      null;
    const grossProfitRate = grossMultiplier === null ? null : grossMultiplier - 1;
    const netProfitRate = netMultiplier === null ? null : netMultiplier - 1;
    const isActuallyProfitable = status === "available" &&
      grossMultiplier !== null &&
      grossMultiplier > feeMetrics.executableBreakEvenGross;
    const latency = calculateLatencyBreakdown({
      ...(options.timings || {}),
      calculationStartPerfMs,
      calculationEndPerfMs,
    });
    const legTimestamps = freshness.legTimestamps || [];
    const lastUpbitTimestampMs = options.lastUpbitTimestampMs ||
      (legTimestamps.length > 0 ? Math.max(...legTimestamps) : null);
    const row = {
      triangleId: cycle.triangleId,
      cycleId: cycle.cycleId,
      direction: cycle.direction,
      directionLabel: cycle.directionLabel,
      group: cycle.group,
      groupLabel: cycle.groupLabel,
      groupIndex: cycle.groupIndex,
      allHub: cycle.allHub,
      baseX: cycle.baseX,
      x: cycle.x,
      xOffset: cycle.xOffset,
      y: grossMultiplier,
      markerSymbol: cycle.markerSymbol,
      markerColor: markerColorFor(cycle.direction, status, isActuallyProfitable),
      assets: cycle.triangleAssets,
      route: cycle.route,
      routeLabel: cycle.routeLabel,
      markets: cycle.markets,
      legs: netResult.available ? netResult.conversions : grossResult.conversions,
      grossMultiplier,
      netMultiplier,
      grossProfitRate,
      netProfitRate,
      feeRate: this.feeRate,
      executableBreakEvenGross: feeMetrics.executableBreakEvenGross,
      isActuallyProfitable,
      status,
      opportunityClass: classifyOpportunity(grossMultiplier, this.feeRate, status, cycle.direction),
      staleReason: status === "stale" ? unavailableReason : null,
      unavailableReason: status === "unavailable" ? unavailableReason : null,
      legTimestamps,
      newestLegAgeMs: freshness.newestLegAgeMs,
      oldestLegAgeMs: freshness.oldestLegAgeMs,
      maxLegAgeMs: freshness.maxLegAgeMs,
      lastChangedMarket: options.lastChangedMarket || null,
      lastUpbitTimestampMs,
      lastOrderbookTimestamp: freshness.lastOrderbookTimestamp,
      oldestOrderbookReceivedAt: freshness.oldestOrderbookReceivedAt,
      calculatedAtEpochMs,
      calculatedAtIso,
      latency,
    };

    this.appendHistory(row);
    this.cycleRows.set(cycle.cycleId, row);
    this.metrics.increment("recalculatedCycles");

    if (latency.upbitToServerMs !== null) {
      this.metrics.addLatencySample(latency.upbitToServerMs, calculatedAtEpochMs);
    }

    if (options.markDirty !== false) {
      this.dirtyCycleIds.add(cycle.cycleId);
    }

    return row;
  }

  recalculateCycles(cycleIds, options = {}) {
    const calculationOrderbooks = this.getCalculationOrderbooks();

    return cycleIds
      .map((cycleId) => this.recalculateCycle(cycleId, {
        ...options,
        calculationOrderbooks,
      }))
      .filter(Boolean);
  }

  recalculateAll(options = {}) {
    return this.recalculateCycles(this.cycles.map((cycle) => cycle.cycleId), options);
  }

  buildCycleRows(now = new Date()) {
    this.recalculateAll({
      nowMs: now.getTime(),
      markDirty: false,
    });

    return this.cycles.map((cycle) => this.cycleRows.get(cycle.cycleId)).filter(Boolean);
  }

  consumeDelta(now = new Date()) {
    const dirtyIds = [...this.dirtyCycleIds];
    this.dirtyCycleIds.clear();
    const changedCycles = dirtyIds
      .map((cycleId) => this.cycleRows.get(cycleId))
      .filter(Boolean)
      .map(compactCycleForDelta);

    if (changedCycles.length > 0) {
      this.metrics.increment("pushedPointUpdates", changedCycles.length);
    }

    const metrics = this.metrics.snapshot(this.wsStatus, now.getTime());

    return {
      type: "delta",
      sentAtEpochMs: now.getTime(),
      changedCycles,
      summaryDelta: this.getSummary(this.cycles.map((cycle) => this.cycleRows.get(cycle.cycleId)).filter(Boolean)),
      metrics,
    };
  }

  getSummary(cycles) {
    const availableCount = cycles.filter((cycle) => cycle.status === "available").length;
    const unavailableCount = cycles.length - availableCount;
    const feeMetrics = computeFeeMetrics(this.feeRate);

    return {
      marketsLoaded: this.marketRows.length,
      quoteCounts: mapToSortedObject(this.quoteCounts),
      uniqueTriangles: this.triangles.length,
      uniqueTriangleCount: this.triangles.length,
      plottedCycleCount: this.cycles.length,
      canonicalCycleCount: this.cycles.filter((cycle) => cycle.direction === "canonical").length,
      reverseCycleCount: this.cycles.filter((cycle) => cycle.direction === "reverse").length,
      availableLiveMultipliers: availableCount,
      unavailableOrStaleCycles: unavailableCount,
      feeRate: this.feeRate,
      executableBreakEvenGross: feeMetrics.executableBreakEvenGross,
      lastUpdateTime: this.lastOrderbookReceivedAt,
      staleOrderbookMs: this.staleOrderbookMs,
      requiredMarketCount: this.requiredMarkets ? this.requiredMarkets.length : 0,
      fallbackLastPolledAt: this.lastFallbackPollAt,
      fallbackLastError: this.lastFallbackPollError,
    };
  }

  getSnapshot(now = new Date()) {
    const cycles = this.buildCycleRows(now);

    this.lastCalculatedAt = now.toISOString();

    return {
      type: "full-state",
      summary: this.getSummary(cycles),
      groups: this.groups,
      groupCounts: this.groupCounts,
      xRange: this.xRange,
      cycles,
      serverStartedAt: this.serverStartedAt,
      lastCalculatedAt: this.lastCalculatedAt,
      wsStatus: this.wsStatus,
      metrics: this.metrics.snapshot(this.wsStatus, now.getTime()),
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
      metrics: this.metrics.snapshot(this.wsStatus),
    };
  }
}

module.exports = {
  LiveTriangleState,
  parseFeeRate,
  normalizeRestOrderbook,
  toCalculationOrderbook,
};
