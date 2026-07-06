const { buildGraph, mapToSortedObject } = require("../lib/marketGraph");
const {
  findUniqueTriangles,
  buildDirectionalCycles,
  getHubBreakdownCounts,
} = require("../lib/triangles");
const { calculateCycleMultiplier } = require("../lib/multiplier");
const { fetchUpbitMarkets, fetchOrderbooks } = require("../lib/upbitApi");
const { DEFAULT_RUNTIME_CONFIG, freezeRuntimeConfig } = require("../core/runtimeConfig");
const { TimingTrace, perfNowNs } = require("../core/timingTrace");
const { executionLogMode } = require("../execution/executionPlan");
const { createStrategyRegistry } = require("../strategies/registry");
const { validateDepthAwareCandidate } = require("./candidateValidator");
const {
  ObservationOrderbookStore,
  ValidationOrderbookStore,
} = require("./orderbookStore");
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

  const units = Array.isArray(topOfBook.orderbook_units) && topOfBook.orderbook_units.length > 0
    ? topOfBook.orderbook_units
    : [
        {
          ask_price: topOfBook.askPrice,
          bid_price: topOfBook.bidPrice,
          ask_size: topOfBook.askSize,
          bid_size: topOfBook.bidSize,
        },
      ];

  return {
    market: topOfBook.market,
    timestamp: topOfBook.timestamp,
    exchangeTimestampMs: topOfBook.exchangeTimestampMs ?? topOfBook.timestamp,
    receivedAt: topOfBook.receivedAt,
    serverReceivedAtMs: topOfBook.serverReceivedAtMs ?? topOfBook.receivedAt,
    streamType: topOfBook.streamType,
    traceId: topOfBook.traceId,
    localSequence: topOfBook.localSequence,
    orderbookUnit: topOfBook.orderbookUnit || units.length,
    unit: topOfBook.unit || topOfBook.orderbookUnit || units.length,
    orderbookLevel: topOfBook.orderbookLevel ?? null,
    orderbook_units: units,
    orderbookUnits: units,
  };
}

function orderbookAuditPayload(feedName, orderbook) {
  if (!orderbook) return null;

  const units = Array.isArray(orderbook.orderbook_units)
    ? orderbook.orderbook_units
    : orderbook.orderbookUnits || [];

  return {
    type: "market.orderbook_update",
    mode: null,
    exchange: orderbook.exchange || "upbit",
    feedName,
    market: orderbook.market,
    unit: orderbook.unit || orderbook.orderbookUnit || units.length,
    orderbookUnit: orderbook.orderbookUnit || orderbook.unit || units.length,
    orderbookLevel: orderbook.orderbookLevel ?? null,
    streamType: orderbook.streamType,
    traceId: orderbook.traceId,
    localSequence: orderbook.localSequence,
    exchangeTimestampMs: orderbook.exchangeTimestampMs,
    serverReceivedAtMs: orderbook.serverReceivedAtMs,
    receivedAt: orderbook.serverReceivedAtMs,
    askPrice: orderbook.askPrice,
    bidPrice: orderbook.bidPrice,
    askSize: orderbook.askSize,
    bidSize: orderbook.bidSize,
    orderbook_units: units,
    orderbookUnits: units,
    excludeFromDryRunSummary: true,
    payload: {
      feedName,
      market: orderbook.market,
      unit: orderbook.unit || orderbook.orderbookUnit || units.length,
      traceId: orderbook.traceId,
      localSequence: orderbook.localSequence,
      exchangeTimestampMs: orderbook.exchangeTimestampMs,
      serverReceivedAtMs: orderbook.serverReceivedAtMs,
      orderbookLevel: orderbook.orderbookLevel ?? null,
      bestAskPrice: orderbook.askPrice,
      bestBidPrice: orderbook.bidPrice,
      orderbookUnitCount: units.length,
    },
  };
}

function normalizeRestOrderbook(orderbook, receivedAt = Date.now(), options = {}) {
  const unit = orderbook && Array.isArray(orderbook.orderbook_units) && orderbook.orderbook_units[0];

  if (!orderbook || !unit) {
    return null;
  }

  const orderbookUnit = options.orderbookUnit || orderbook.orderbook_units.length;
  const orderbookUnits = orderbook.orderbook_units.slice(0, orderbookUnit).map((item) => ({
    ask_price: Number(item.ask_price),
    bid_price: Number(item.bid_price),
    ask_size: Number(item.ask_size),
    bid_size: Number(item.bid_size),
  }));

  return {
    market: orderbook.market,
    askPrice: Number(unit.ask_price),
    bidPrice: Number(unit.bid_price),
    askSize: Number(unit.ask_size),
    bidSize: Number(unit.bid_size),
    timestamp: Number(orderbook.timestamp),
    streamType: "REST",
    receivedAt,
    orderbookUnit,
    orderbook_units: orderbookUnits,
  };
}

function markerColorFor(direction, status, isActuallyProfitable) {
  if (status === "stale" || status === "unavailable") {
    return "#aeb8c5";
  }

  if (isActuallyProfitable) {
    return "#d83f7b";
  }

  return "#2d6f9f";
}

function normalizeFeePolicyMap(source) {
  if (!source) return new Map();
  if (source instanceof Map) return new Map(source);
  return new Map(Object.entries(source));
}

function compactCycleForDelta(row) {
  return {
    triangleId: row.triangleId,
    cycleId: row.cycleId,
    routeVariantId: row.routeVariantId,
    legacyCycleId: row.legacyCycleId,
    startAsset: row.startAsset,
    endAsset: row.endAsset,
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
    validationStatus: row.validationStatus,
    validationReason: row.validationReason,
    executableStartAmount: row.executableStartAmount,
    maxExecutableStartAmount: row.maxExecutableStartAmount,
    limitingLeg: row.limitingLeg,
    limitingMarket: row.limitingMarket,
    expectedSlippageBps: row.expectedSlippageBps,
    bestLevelTouchRatio: row.bestLevelTouchRatio,
    residualAfterOrder: row.residualAfterOrder,
    observationValidationGapMs: row.observationValidationGapMs,
    observationValidationGapMarket: row.observationValidationGapMarket,
    validationLegTimestampSkewMs: row.validationLegTimestampSkewMs,
    oldestValidationReceivedAgeMs: row.oldestValidationReceivedAgeMs,
    validationOrderbookSources: row.validationOrderbookSources,
    strategyId: row.strategyId,
    strategyVersion: row.strategyVersion,
    strategyAccepted: row.strategyAccepted,
    strategyReason: row.strategyReason,
    executionFeasibility: row.executionFeasibility,
    timingBreakdown: row.timingBreakdown,
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
    this.runtimeConfig = freezeRuntimeConfig(options.runtimeConfig || DEFAULT_RUNTIME_CONFIG);
    this.fetchMarkets = options.fetchMarkets || fetchUpbitMarkets;
    this.fetchOrderbooks = options.fetchOrderbooks || fetchOrderbooks;
    this.serverStartedAt = new Date().toISOString();
    this.engineState = options.engineState || "STOPPED";
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
    this.requiredMarkets = [];
    this.hubBreakdown = {};
    this.metrics = options.metrics || new RuntimeMetrics();
    this.observationStore = options.observationStore || new ObservationOrderbookStore({
      orderbookUnit: this.runtimeConfig.observationOrderbookUnit,
      staleOrderbookMs: this.staleOrderbookMs,
      metrics: this.metrics,
    });
    this.validationStore = options.validationStore || new ValidationOrderbookStore({
      orderbookUnit: this.runtimeConfig.validationOrderbookUnit,
      staleOrderbookMs: this.staleOrderbookMs,
      metrics: this.metrics,
    });
    this.orderbooks = this.observationStore.orderbooks;
    this.wsStatus = {
      stopped: true,
      connections: [],
      openConnectionCount: 0,
    };
    this.validationWsStatus = {
      stopped: true,
      connections: [],
      openConnectionCount: 0,
    };
    this.strategyRegistry = options.strategyRegistry || createStrategyRegistry();
    this.activeStrategy = this.strategyRegistry.get(this.runtimeConfig.activeStrategyId);
    this.runtimeConfig = freezeRuntimeConfig({
      ...this.runtimeConfig,
      activeStrategyId: this.activeStrategy.id,
    });
    this.feePolicyByMarket = normalizeFeePolicyMap(options.feePolicyByMarket);
    this.eventLog = [];
    this.logStore = options.logStore || null;
    this.executionHandler = options.executionHandler || null;
    this.maxEventLogEntries = options.maxEventLogEntries || 1000;
    this.lastCalculatedAt = null;
    this.lastOrderbookReceivedAt = null;
    this.lastFallbackPollAt = null;
    this.lastFallbackPollError = null;
    this.initializationError = null;
  }

  setRuntimeConfig(runtimeConfig) {
    const frozenConfig = freezeRuntimeConfig(runtimeConfig);
    this.activeStrategy = this.strategyRegistry.get(frozenConfig.activeStrategyId);
    this.runtimeConfig = freezeRuntimeConfig({
      ...frozenConfig,
      activeStrategyId: this.activeStrategy.id,
    });
  }

  setFeePolicyByMarket(feePolicyByMarket) {
    this.feePolicyByMarket = normalizeFeePolicyMap(feePolicyByMarket);
  }

  setExecutionHandler(handler) {
    this.executionHandler = typeof handler === "function" ? handler : null;
  }

  async initialize() {
    try {
      const upbitMarkets = await this.fetchMarkets();
      const { normalizedMarkets, graph, pairMap, quoteCounts } = buildGraph(upbitMarkets);
      const triangles = findUniqueTriangles(graph, pairMap);
      const directionalCycles = buildDirectionalCycles(triangles, pairMap, {
        enabledStartAssets: this.runtimeConfig.enabledStartAssets,
      });
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
      this.initializationError = null;
      this.recalculateAll({ markDirty: false });
      return {
        ok: true,
        marketsLoaded: this.marketRows.length,
        cycles: this.cycles.length,
      };
    } catch (error) {
      const message = error && error.message || String(error);

      this.marketRows = [];
      this.quoteCounts = new Map();
      this.triangles = [];
      this.cycles = [];
      this.cycleIndex = new Map();
      this.cycleRows = new Map();
      this.marketToCycleIds = new Map();
      this.groups = [];
      this.groupCounts = {};
      this.xRange = { min: 0.25, max: 1.75 };
      this.hubBreakdown = {};
      this.requiredMarkets = [];
      this.initializationError = {
        source: "upbit-market-discovery",
        message,
        at: new Date().toISOString(),
      };
      this.lastFallbackPollError = this.initializationError;
      this.logEvent("market.initialize_failed", {
        source: this.initializationError.source,
        message,
      });
      return {
        ok: false,
        error: this.initializationError,
      };
    }
  }

  async loadInitialOrderbooks(options = {}) {
    if (!Array.isArray(this.requiredMarkets) || this.requiredMarkets.length === 0) {
      const receivedAt = Date.now();
      const result = {
        orderbookMap: new Map(),
        errors: this.initializationError ? [this.initializationError] : [],
        requestedMarketCount: 0,
        fetchedMarketCount: 0,
      };

      this.lastFallbackPollAt = new Date(receivedAt).toISOString();
      this.lastFallbackPollError = result.errors.length > 0 ? result.errors : null;
      this.recalculateAll({ markDirty: options.markDirty !== false, lastChangedMarket: null });
      return result;
    }

    const result = await this.fetchOrderbooks(this.requiredMarkets, options);
    const receivedAt = Date.now();

    for (const orderbook of result.orderbookMap.values()) {
      const observation = normalizeRestOrderbook(orderbook, receivedAt, {
        orderbookUnit: this.runtimeConfig.observationOrderbookUnit,
      });
      const validation = normalizeRestOrderbook(orderbook, receivedAt, {
        orderbookUnit: this.runtimeConfig.validationOrderbookUnit,
      });

      if (observation) {
        const normalizedObservation = this.observationStore.update(observation, receivedAt);
        this.appendMarketOrderbookUpdate("observation", normalizedObservation);
        this.lastOrderbookReceivedAt = new Date(receivedAt).toISOString();
      }

      if (validation) {
        const normalizedValidation = this.validationStore.update(validation, receivedAt);
        this.appendMarketOrderbookUpdate("validation", normalizedValidation);
      }
    }

    this.lastFallbackPollAt = new Date(receivedAt).toISOString();
    this.lastFallbackPollError = result.errors.length > 0 ? result.errors : null;
    this.recalculateAll({ markDirty: options.markDirty !== false, lastChangedMarket: null });
    return result;
  }

  async fallbackPoll(options = {}) {
    try {
      let marketDiscovery = null;

      if (this.initializationError && (!Array.isArray(this.requiredMarkets) || this.requiredMarkets.length === 0)) {
        marketDiscovery = await this.initialize();

        if (marketDiscovery.ok) {
          this.logEvent("market.initialize_recovered", {
            marketsLoaded: marketDiscovery.marketsLoaded,
            cycles: marketDiscovery.cycles,
          });
        }
      }

      const result = await this.loadInitialOrderbooks(options);
      result.marketDiscovery = marketDiscovery;
      result.marketDiscoveryRecovered = Boolean(marketDiscovery && marketDiscovery.ok);
      this.lastFallbackPollError = result.errors.length > 0 ? result.errors : null;
      return result;
    } catch (error) {
      this.lastFallbackPollError = error.message;
      throw error;
    }
  }

  updateOrderbook(orderbook) {
    return this.updateObservationOrderbook(orderbook);
  }

  updateObservationOrderbook(orderbook) {
    if (!orderbook || !orderbook.market) {
      return [];
    }

    const cacheUpdatedPerfMs = performance.now();
    const cacheWriteStartPerfNs = perfNowNs();
    const normalized = this.observationStore.update(orderbook);

    if (!normalized) {
      return [];
    }
    const cacheWriteDonePerfNs = perfNowNs();
    this.appendMarketOrderbookUpdate("observation", normalized);

    this.lastOrderbookReceivedAt = new Date(normalized.receivedAt || Date.now()).toISOString();

    if (normalized.streamType !== "REST") {
      this.metrics.increment("upbitOrderbookMessages");
      this.metrics.increment("parsedMessages");
    }

    const affectedCycleLookupStartPerfNs = perfNowNs();
    const affectedCycleIds = [...(this.marketToCycleIds.get(normalized.market) || [])];
    const affectedCycleLookupDonePerfNs = perfNowNs();
    const timings = {
      ...(normalized.timings || {}),
      upbitTimestampMs: Number(normalized.timestamp),
      orderbookCacheUpdatedPerfMs: cacheUpdatedPerfMs,
      cacheWriteStartPerfNs,
      cacheWriteDonePerfNs,
      affectedCycleLookupStartPerfNs,
      affectedCycleLookupDonePerfNs,
    };

    this.recalculateCycles(affectedCycleIds, {
      markDirty: true,
      lastChangedMarket: normalized.market,
      lastUpbitTimestampMs: Number(normalized.timestamp),
      timings,
    });

    return affectedCycleIds;
  }

  updateValidationOrderbook(orderbook) {
    if (!orderbook || !orderbook.market) {
      return [];
    }

    const normalized = this.validationStore.update(orderbook);

    if (!normalized) {
      return [];
    }
    this.appendMarketOrderbookUpdate("validation", normalized);

    const affectedCycleIds = [...(this.marketToCycleIds.get(normalized.market) || [])];
    this.recalculateCycles(affectedCycleIds, {
      markDirty: true,
      lastChangedMarket: normalized.market,
      lastUpbitTimestampMs: Number(normalized.timestamp),
    });

    return affectedCycleIds;
  }

  setWsStatus(status, feedName = "observation") {
    if (feedName === "validation") {
      this.validationWsStatus = status;
      return;
    }

    this.wsStatus = status;
  }

  getCalculationOrderbooks() {
    return new Map(
      [...this.observationStore.entries()].map(([market, topOfBook]) => [
        market,
        toCalculationOrderbook(topOfBook),
      ]),
    );
  }

  getValidationOrderbooks() {
    return new Map(
      [...this.validationStore.entries()].map(([market, orderbook]) => [
        market,
        toCalculationOrderbook(orderbook),
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

  selectStrategy(strategyId) {
    if (this.engineState !== "STOPPED") {
      throw new Error("Strategy can only be selected while STOPPED");
    }

    this.activeStrategy = this.strategyRegistry.get(strategyId);
    this.runtimeConfig = freezeRuntimeConfig({
      ...this.runtimeConfig,
      activeStrategyId: this.activeStrategy.id,
    });
    this.logEvent("strategy-selection", {
      strategyId: this.activeStrategy.id,
      requestedStrategyId: strategyId,
      reason: "selected while STOPPED",
    });
    this.recalculateAll({ markDirty: true });
  }

  logEvent(type, payload = {}) {
    const event = {
      sequence: this.eventLog.length + 1,
      timestamp: new Date().toISOString(),
      type,
      ...payload,
    };

    this.eventLog.push(event);

    if (this.eventLog.length > this.maxEventLogEntries) {
      this.eventLog = this.eventLog.slice(-this.maxEventLogEntries);
    }

    if (this.logStore) {
      this.logStore.append("events", event).catch(() => {});

      if (type === "error") {
        this.logStore.append("errors", event).catch(() => {});
      }
    }

    return event;
  }

  appendAuditEvent(type, payload = {}) {
    if (!this.logStore) return;

    this.logStore.append("events", {
      type,
      exchange: "upbit",
      engineState: this.engineState,
      runtimeRunMode: this.runtimeConfig.runMode,
      excludeFromDryRunSummary: true,
      ...payload,
    }).catch(() => {});
  }

  appendMarketOrderbookUpdate(feedName, orderbook) {
    if (!this.logStore) return null;
    const auditPayload = orderbookAuditPayload(feedName, orderbook);

    if (!auditPayload) return null;

    const event = {
      ...auditPayload,
      mode: executionLogMode(this.runtimeConfig.runMode),
      engineState: this.engineState,
      runtimeRunMode: this.runtimeConfig.runMode,
    };

    this.logStore.append("market", event).catch(() => {});
    return event;
  }

  logDecision(row) {
    const mode = executionLogMode(this.runtimeConfig.runMode);
    const expectedNetProfit = row.executableStartAmount === null || row.executableStartAmount === undefined ||
      row.netProfitRate === null || row.netProfitRate === undefined
      ? null
      : Number(row.executableStartAmount) * Number(row.netProfitRate);
    const latencyMs = row.latency && row.latency.estimatedEndToDisplayMs;
    const baseAudit = {
      mode,
      traceId: row.cycleId,
      cycleId: row.cycleId,
      routeVariantId: row.routeVariantId,
      startAsset: row.startAsset,
      direction: row.direction,
      strategyId: row.strategyId,
      strategyVersion: row.strategyVersion,
    };

    this.logEvent("strategy-decision", {
      mode,
      excludeFromDryRunSummary: true,
      cycleId: row.cycleId,
      routeVariantId: row.routeVariantId,
      startAsset: row.startAsset,
      direction: row.direction,
      strategyId: row.strategyId,
      strategyVersion: row.strategyVersion,
      accepted: row.strategyAccepted,
      reason: row.strategyReason,
      validationReason: row.validationReason,
      expectedNetProfit,
      latencyMs,
    });

    this.appendAuditEvent("candidate.detected", {
      ...baseAudit,
      status: row.status,
      opportunityClass: row.opportunityClass,
      grossMultiplier: row.grossMultiplier,
      netMultiplier: row.netMultiplier,
      oldestLegAgeMs: row.oldestLegAgeMs,
      maxLegAgeMs: row.maxLegAgeMs,
      legTimestamps: row.legTimestamps,
    });

    this.appendAuditEvent("candidate.validated", {
      ...baseAudit,
      validationStatus: row.validationStatus,
      validationReason: row.validationReason,
      validationAccepted: row.validationStatus === "accepted",
      executableStartAmount: row.executableStartAmount,
      maxExecutableStartAmount: row.maxExecutableStartAmount,
      limitingLeg: row.limitingLeg,
      limitingMarket: row.limitingMarket,
      expectedSlippageBps: row.expectedSlippageBps,
      bestLevelTouchRatio: row.bestLevelTouchRatio,
      residualAfterOrder: row.residualAfterOrder,
      depthLegs: row.depthLegs,
      observationValidationGapMs: row.observationValidationGapMs,
      observationValidationGapMarket: row.observationValidationGapMarket,
      validationLegTimestampSkewMs: row.validationLegTimestampSkewMs,
      oldestValidationReceivedAgeMs: row.oldestValidationReceivedAgeMs,
      validationOrderbookSources: row.validationOrderbookSources,
      validationOrderbookMetadata: row.validationOrderbookMetadata,
      expectedValidationOrderbookUnit: row.expectedValidationOrderbookUnit,
    });

    if (row.validationStatus !== "accepted") {
      this.appendAuditEvent("risk.rejected", {
        ...baseAudit,
        reason: row.validationReason || row.unavailableReason || row.staleReason || "VALIDATION_REJECTED",
        validationStatus: row.validationStatus,
        validationReason: row.validationReason,
        limitingLeg: row.limitingLeg,
        limitingMarket: row.limitingMarket,
        observationValidationGapMs: row.observationValidationGapMs,
        observationValidationGapMarket: row.observationValidationGapMarket,
        validationLegTimestampSkewMs: row.validationLegTimestampSkewMs,
        oldestValidationReceivedAgeMs: row.oldestValidationReceivedAgeMs,
        validationOrderbookSources: row.validationOrderbookSources,
      });
    }

    this.appendAuditEvent(row.strategyAccepted ? "strategy.accepted" : "strategy.rejected", {
      ...baseAudit,
      strategyAccepted: row.strategyAccepted,
      reason: row.strategyReason,
      validationReason: row.validationReason,
      expectedNetProfit,
      latencyMs,
    });

    if (this.logStore) {
      this.logStore.append("decisions", {
        type: "strategy-decision",
        mode,
        cycleId: row.cycleId,
        routeVariantId: row.routeVariantId,
        startAsset: row.startAsset,
        direction: row.direction,
        strategyId: row.strategyId,
        strategyVersion: row.strategyVersion,
        accepted: row.strategyAccepted,
        reason: row.strategyReason,
        status: row.status,
        marketState: row.status,
        opportunityClass: row.opportunityClass,
        staleReason: row.staleReason,
        unavailableReason: row.unavailableReason,
        validationStatus: row.validationStatus,
        validationReason: row.validationReason,
        grossMultiplier: row.grossMultiplier,
        netMultiplier: row.netMultiplier,
        expectedNetProfit,
        latencyMs,
        executableStartAmount: row.executableStartAmount,
        maxExecutableStartAmount: row.maxExecutableStartAmount,
        limitingLeg: row.limitingLeg,
        limitingMarket: row.limitingMarket,
        expectedSlippageBps: row.expectedSlippageBps,
        bestLevelTouchRatio: row.bestLevelTouchRatio,
        observationValidationGapMs: row.observationValidationGapMs,
        observationValidationGapMarket: row.observationValidationGapMarket,
        validationLegTimestampSkewMs: row.validationLegTimestampSkewMs,
        oldestValidationReceivedAgeMs: row.oldestValidationReceivedAgeMs,
        validationOrderbookSources: row.validationOrderbookSources,
        timingBreakdown: row.timingBreakdown,
      }).catch(() => {});
    }
  }

  enqueueExecutionCandidate(row, cycle, validationOrderbooks) {
    if (!this.executionHandler || !row.strategyAccepted) {
      return;
    }

    if (!["DRY_RUN", "REAL_GUARDED", "REAL_AUTO"].includes(this.runtimeConfig.runMode)) {
      return;
    }

    if (this.engineState !== "RUNNING") {
      return;
    }

    const plan = this.activeStrategy.buildExecutionPlan({
      cycle,
      row,
      validationOrderbooks,
      runtimeConfig: this.runtimeConfig,
      feeRate: this.feeRate,
      feePolicyByMarket: this.feePolicyByMarket,
      staleOrderbookMs: this.staleOrderbookMs,
      engineState: this.engineState,
      depthValidation: {
        validationStatus: row.validationStatus,
        validationReason: row.validationReason,
      },
      decision: {
        strategyId: row.strategyId,
        strategyVersion: row.strategyVersion,
        accepted: row.strategyAccepted,
        reason: row.strategyReason,
      },
    });

    if (!plan) {
      return;
    }

    this.appendAuditEvent("execution.plan_created", {
      mode: plan.mode,
      traceId: plan.planId,
      planId: plan.planId,
      cycleId: plan.cycleId,
      routeVariantId: plan.routeVariantId,
      startAsset: plan.startAsset,
      strategyId: plan.strategyId,
      strategyVersion: plan.strategyVersion,
      executionMode: plan.executionMode,
      startAmount: plan.startAmount,
      expectedOutputAmount: plan.expectedOutputAmount,
      expectedNetProfit: plan.expectedNetProfit,
      validationStatus: plan.validationStatus,
      validationReason: plan.validationReason,
      marketState: plan.marketState,
      opportunityClass: plan.opportunityClass,
      oldestLegAgeMs: plan.oldestLegAgeMs,
      legTimestampSkewMs: plan.legTimestampSkewMs,
      decisionAgeMs: plan.decisionAgeMs,
      bestLevelTouchRatio: plan.bestLevelTouchRatio,
    });

    Promise.resolve()
      .then(() => this.executionHandler(plan, { row }))
      .catch((error) => {
        this.logEvent("error", {
          source: "execution-handler",
          cycleId: row.cycleId,
          message: error.message,
        });
      });
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
    const validationOrderbooks = options.validationOrderbooks || this.getValidationOrderbooks();
    const feeMetrics = computeFeeMetrics(this.feeRate);
    const calculationStartPerfMs = performance.now();
    const calcStartPerfNs = perfNowNs();
    const freshness = getCycleFreshness(cycle, calculationOrderbooks, this.staleOrderbookMs, calculatedAtEpochMs);
    const grossResult = calculateCycleMultiplier(cycle, null, calculationOrderbooks, 0, {
      nowMs: calculatedAtEpochMs,
    });
    const netResult = calculateCycleMultiplier(cycle, null, calculationOrderbooks, this.feeRate, {
      nowMs: calculatedAtEpochMs,
    });
    const calculationEndPerfMs = performance.now();
    const calcDonePerfNs = perfNowNs();
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
    const riskStartPerfNs = perfNowNs();
    const marketDataGuards = this.runtimeConfig.executionPolicy.marketDataGuards || {};
    const depthValidation = validateDepthAwareCandidate(cycle, validationOrderbooks, {
      feeRate: this.feeRate,
      feePolicyByMarket: this.feePolicyByMarket,
      nowMs: calculatedAtEpochMs,
      staleOrderbookMs: this.staleOrderbookMs,
      observationOrderbooks: calculationOrderbooks,
      config: {
        ...this.runtimeConfig.candidateValidation,
        expectedValidationOrderbookUnit: this.runtimeConfig.validationOrderbookUnit,
        maxValidationLegTimestampSkewMs: marketDataGuards.maxLegTimestampSkewMs,
        maxOldestValidationReceivedAgeMs: marketDataGuards.maxOldestLegAgeMs,
      },
    });
    const riskDonePerfNs = perfNowNs();
    const row = {
      triangleId: cycle.triangleId,
      cycleId: cycle.cycleId,
      legacyCycleId: cycle.legacyCycleId,
      routeVariantId: cycle.routeVariantId,
      startAsset: cycle.startAsset,
      endAsset: cycle.endAsset,
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
      validationStatus: depthValidation.validationStatus,
      validationReason: depthValidation.validationReason,
      executableStartAmount: depthValidation.executableStartAmount,
      maxExecutableStartAmount: depthValidation.maxExecutableStartAmount,
      limitingLeg: depthValidation.limitingLeg,
      limitingMarket: depthValidation.limitingMarket,
      expectedSlippageBps: depthValidation.expectedSlippageBps,
      bestLevelTouchRatio: depthValidation.bestLevelTouchRatio,
      residualAfterOrder: depthValidation.residualAfterOrder,
      depthLegs: depthValidation.depthLegs,
      observationValidationGapMs: depthValidation.observationValidationGapMs,
      observationValidationGapMarket: depthValidation.observationValidationGapMarket,
      validationLegTimestampSkewMs: depthValidation.validationLegTimestampSkewMs,
      oldestValidationReceivedAgeMs: depthValidation.oldestValidationReceivedAgeMs,
      validationOrderbookSources: depthValidation.validationOrderbookSources,
      validationOrderbookMetadata: depthValidation.validationOrderbookMetadata,
      expectedValidationOrderbookUnit: depthValidation.expectedValidationOrderbookUnit,
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
    const strategyStartPerfNs = perfNowNs();
    const strategyDecision = this.activeStrategy.evaluate({
      cycle,
      row,
      depthValidation,
      config: this.activeStrategy.defaultConfig,
    });
    const strategyDonePerfNs = perfNowNs();
    const timingTrace = new TimingTrace({
      ...(options.timings || {}),
      exchangeTimestampEpochMs: options.timings && options.timings.exchangeTimestampEpochMs ||
        options.lastUpbitTimestampMs ||
        lastUpbitTimestampMs,
      calcStartPerfNs,
      calcDonePerfNs,
      strategyStartPerfNs,
      strategyDonePerfNs,
      riskStartPerfNs,
      riskDonePerfNs,
      telemetryPublishPerfNs: perfNowNs(),
      telemetryPublishEpochMs: Date.now(),
      clockSkewSensitive: ["exchangeTimestampEpochMs", "socketReceiveEpochMs", "dashboardReceiveEpochMs"],
    });

    row.strategyId = strategyDecision.strategyId;
    row.strategyVersion = strategyDecision.strategyVersion || this.activeStrategy.version;
    row.strategyAccepted = strategyDecision.accepted;
    row.strategyReason = strategyDecision.reason;
    row.executionFeasibility = depthValidation.validationStatus !== "accepted"
      ? depthValidation.validationReason || "VALIDATION_REJECTED"
      : strategyDecision.accepted
        ? "EXECUTABLE_CANDIDATE"
        : strategyDecision.reason || "STRATEGY_REJECTED";
    row.timingTrace = timingTrace.serialize();
    row.timingBreakdown = timingTrace.breakdown();

    this.appendHistory(row);
    this.cycleRows.set(cycle.cycleId, row);
    this.metrics.increment("recalculatedCycles");

    if (latency.upbitToServerMs !== null) {
      this.metrics.addLatencySample(latency.upbitToServerMs, calculatedAtEpochMs);
    }

    if (options.markDirty !== false) {
      this.dirtyCycleIds.add(cycle.cycleId);
    }

    if (options.logDecision !== false) {
      this.logDecision(row);
      this.enqueueExecutionCandidate(row, cycle, validationOrderbooks);
    }

    return row;
  }

  recalculateCycles(cycleIds, options = {}) {
    const calculationOrderbooks = this.getCalculationOrderbooks();
    const validationOrderbooks = this.getValidationOrderbooks();

    return cycleIds
      .map((cycleId) => this.recalculateCycle(cycleId, {
        ...options,
        calculationOrderbooks,
        validationOrderbooks,
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
      logDecision: false,
    });

    return this.cycles.map((cycle) => this.cycleRows.get(cycle.cycleId)).filter(Boolean);
  }

  refreshAgingCycles(now = new Date()) {
    const nowMs = now.getTime();
    const previousRows = new Map(this.cycleRows);
    const rows = this.recalculateAll({
      nowMs,
      markDirty: false,
      logDecision: false,
    });

    for (const row of rows) {
      const previous = previousRows.get(row.cycleId);

      if (
        !previous ||
        previous.status !== row.status ||
        previous.staleReason !== row.staleReason ||
        previous.unavailableReason !== row.unavailableReason ||
        previous.validationStatus !== row.validationStatus ||
        previous.validationReason !== row.validationReason ||
        previous.strategyAccepted !== row.strategyAccepted ||
        previous.strategyReason !== row.strategyReason ||
        previous.executionFeasibility !== row.executionFeasibility
      ) {
        this.dirtyCycleIds.add(row.cycleId);
      }
    }

    return this.dirtyCycleIds.size;
  }

  consumeDelta(now = new Date()) {
    this.lastCalculatedAt = now.toISOString();
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
    const startAssetCounts = cycles.reduce((counts, cycle) => {
      counts[cycle.startAsset] = (counts[cycle.startAsset] || 0) + 1;
      return counts;
    }, {});

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
      marketDiscoveryError: this.initializationError,
      startAssetCounts,
      strategyAcceptedCount: cycles.filter((cycle) => cycle.strategyAccepted).length,
      strategyRejectedCount: cycles.filter((cycle) => cycle.strategyAccepted === false).length,
    };
  }

  getOrderbookStoreStatus(nowMs = Date.now()) {
    return {
      observation: this.observationStore.getStatus(nowMs),
      validation: this.validationStore.getStatus(nowMs),
    };
  }

  getStrategySnapshot() {
    return {
      activeStrategyId: this.activeStrategy.id,
      activeStrategy: {
        id: this.activeStrategy.id,
        name: this.activeStrategy.name,
        version: this.activeStrategy.version,
        hash: this.activeStrategy.hash || null,
        description: this.activeStrategy.description,
        defaultConfig: this.activeStrategy.defaultConfig,
      },
      availableStrategies: this.strategyRegistry.list(),
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
      runtimeConfig: this.runtimeConfig,
      orderbookStores: this.getOrderbookStoreStatus(now.getTime()),
      feedStatus: {
        observation: this.wsStatus,
        validation: this.validationWsStatus,
      },
      strategy: this.getStrategySnapshot(),
      engineState: this.engineState,
      eventLog: this.eventLog.slice(-200),
    };
  }

  getHealth() {
    return {
      ok: true,
      degraded: Boolean(this.initializationError),
      marketDataStatus: {
        initialized: this.initializationError === null,
        initializationError: this.initializationError,
        requiredMarketCount: this.requiredMarkets ? this.requiredMarkets.length : 0,
        fallbackLastError: this.lastFallbackPollError,
      },
      serverStartedAt: this.serverStartedAt,
      wsStatus: this.wsStatus,
      marketsLoaded: this.marketRows.length,
      cycles: this.cycles.length,
      lastOrderbookReceivedAt: this.lastOrderbookReceivedAt,
      metrics: this.metrics.snapshot(this.wsStatus),
      runtimeConfig: this.runtimeConfig,
      orderbookStores: this.getOrderbookStoreStatus(),
      feedStatus: {
        observation: this.wsStatus,
        validation: this.validationWsStatus,
      },
      strategy: this.getStrategySnapshot(),
      engineState: this.engineState,
    };
  }
}

module.exports = {
  LiveTriangleState,
  parseFeeRate,
  normalizeRestOrderbook,
  toCalculationOrderbook,
};
