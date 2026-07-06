const { diffNsToMs } = require("./timingTrace");

const TRADING_LATENCY_DOMAINS = Object.freeze(["marketData", "decision", "execution"]);
const DASHBOARD_LATENCY_DOMAIN = "dashboard";

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveLimit(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : Infinity;
}

function metric(value, options = {}) {
  const parsed = numberOrNull(value);

  return {
    valueMs: parsed,
    clockSkewSensitive: options.clockSkewSensitive === true,
    source: options.source || null,
  };
}

function metricValue(value) {
  if (value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "valueMs")) {
    return numberOrNull(value.valueMs);
  }

  return numberOrNull(value);
}

function percentile(values, p) {
  const finite = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (finite.length === 0) return null;
  const index = Math.ceil((p / 100) * finite.length) - 1;
  return finite[Math.max(0, Math.min(finite.length - 1, index))];
}

function metricDistribution(values) {
  const finite = values.filter(Number.isFinite);

  return {
    count: finite.length,
    p50Ms: percentile(finite, 50),
    p95Ms: percentile(finite, 95),
    p99Ms: percentile(finite, 99),
    minMs: finite.length > 0 ? Math.min(...finite) : null,
    maxMs: finite.length > 0 ? Math.max(...finite) : null,
  };
}

function summarizeLatency({ trace = {}, latency = {}, execution = {} } = {}) {
  const orderAckMs = numberOrNull(execution.orderAckMs) ??
    diffNsToMs(trace.orderAckPerfNs, trace.orderSubmitStartPerfNs);
  const reconciliationMs = numberOrNull(execution.reconciliationMs) ??
    diffNsToMs(trace.reconciliationDonePerfNs, trace.reconciliationStartedPerfNs);
  const orderQueryMs = numberOrNull(execution.orderQueryMs) ??
    diffNsToMs(trace.orderQueryDonePerfNs, trace.reconciliationStartedPerfNs);
  const privateWsFillMs = numberOrNull(execution.privateWsFillMs) ??
    diffNsToMs(trace.privateWsFillReceivePerfNs, trace.orderSubmitStartPerfNs);

  return {
    marketData: {
      exchangeToSocketMs: metric(latency.upbitToServerMs ?? latency.exchangeToSocketMs, {
        clockSkewSensitive: true,
        source: "exchange/server clocks",
      }),
      socketParseMs: metric(latency.serverParseMs ?? trace.socketParseMs),
      cacheWriteMs: metric(trace.cacheWriteMs),
      orderbookAgeMs: metric(latency.oldestLegAgeMs),
      legTimestampSkewMs: metric(latency.legTimestampSkewMs),
    },
    decision: {
      calcMs: metric(trace.calcMs ?? latency.serverCalcMs),
      strategyMs: metric(trace.strategyMs),
      riskMs: metric(trace.riskMs),
      decisionAgeMs: metric(latency.decisionAgeMs),
    },
    execution: {
      orderAckMs: metric(orderAckMs),
      reconciliationMs: metric(reconciliationMs),
      orderQueryMs: metric(orderQueryMs),
      privateWsFillMs: metric(privateWsFillMs),
      source: execution.source || null,
    },
    dashboard: {
      serverToClientMs: metric(latency.serverToClientMs),
      clientRenderMs: metric(latency.clientRenderMs),
      browserApplyToRenderMs: metric(trace.browserApplyToRenderMs),
      dashboardReceiveLagMs: metric(latency.dashboardReceiveLagMs ?? trace.dashboardReceiveLagMs, {
        clockSkewSensitive: true,
        source: "server/browser clocks",
      }),
      estimatedEndToDisplayMs: metric(latency.estimatedEndToDisplayMs, {
        clockSkewSensitive: true,
        source: "exchange/server/browser clocks",
      }),
    },
  };
}

function normalizeLatencySummary(sample = {}) {
  if (sample.trace || sample.latency) {
    return summarizeLatency(sample);
  }

  if (sample.marketData || sample.decision || sample.execution || sample.dashboard) {
    return sample;
  }

  return summarizeLatency(sample);
}

function summarizeLatencyPercentiles(samples = []) {
  const summaries = samples.map(normalizeLatencySummary);
  const domains = {
    marketData: {},
    decision: {},
    execution: {},
    dashboard: {},
  };

  for (const domain of Object.keys(domains)) {
    const metricNames = new Set();

    for (const summary of summaries) {
      const domainMetrics = summary[domain] || {};
      Object.keys(domainMetrics)
        .filter((name) => name !== "source")
        .forEach((name) => metricNames.add(name));
    }

    for (const name of metricNames) {
      const metricSamples = summaries
        .map((summary) => summary[domain] && summary[domain][name])
        .filter((entry) => entry !== undefined);
      const values = metricSamples.map(metricValue).filter(Number.isFinite);
      const clockSkewSensitive = metricSamples.some((entry) => entry && entry.clockSkewSensitive === true);
      const sources = [...new Set(metricSamples
        .map((entry) => entry && entry.source)
        .filter(Boolean))];

      domains[domain][name] = {
        ...metricDistribution(values),
        clockSkewSensitive,
        tradingDecisionInput: domain !== DASHBOARD_LATENCY_DOMAIN,
        sources,
      };
    }
  }

  return {
    ...domains,
    tradingLatencyDomains: TRADING_LATENCY_DOMAINS.slice(),
    dashboardLatencyAffectsTrading: false,
  };
}

function evaluateExecutionLatencyBudget(execution = {}, budget = {}) {
  const orderAckMs = numberOrNull(execution.orderAckMs);
  const reconciliationMs = numberOrNull(execution.reconciliationMs);
  const maxOrderAckMs = positiveLimit(budget.maxOrderAckMs);
  const maxReconciliationMs = positiveLimit(budget.maxReconciliationMs);

  if (orderAckMs !== null && orderAckMs > maxOrderAckMs) {
    return {
      ok: false,
      rejectionReason: "ORDER_ACK_LATENCY",
      metric: "orderAckMs",
      observedMs: orderAckMs,
      limitMs: maxOrderAckMs,
      emergencyStop: false,
    };
  }

  if (reconciliationMs !== null && reconciliationMs > maxReconciliationMs) {
    return {
      ok: false,
      rejectionReason: "ORDER_RECONCILIATION_LATENCY",
      metric: "reconciliationMs",
      observedMs: reconciliationMs,
      limitMs: maxReconciliationMs,
      emergencyStop: false,
    };
  }

  return {
    ok: true,
    rejectionReason: null,
    emergencyStop: false,
  };
}

function checkLimit(summary, domain, metricName, limit, reason) {
  const observedMs = metricValue(summary[domain] && summary[domain][metricName]);
  const limitMs = positiveLimit(limit);

  if (observedMs !== null && observedMs > limitMs) {
    return {
      ok: false,
      rejectionReason: reason,
      machineReason: reason,
      domain,
      metric: metricName,
      observedMs,
      limitMs,
      emergencyStop: false,
    };
  }

  return null;
}

function evaluateTradingLatencyBudget(input = {}, budget = {}) {
  const summary = normalizeLatencySummary(input);
  const marketDataBudget = budget.marketData || budget.marketDataGuards || {};
  const decisionBudget = budget.decision || budget.decisionGuards || marketDataBudget;
  const executionBudget = budget.execution || budget.executionGuards || {};
  const checks = [
    checkLimit(
      summary,
      "marketData",
      "exchangeToSocketMs",
      marketDataBudget.maxExchangeToServerLatencyMs,
      "EXCHANGE_TO_SERVER_LATENCY",
    ),
    checkLimit(
      summary,
      "marketData",
      "orderbookAgeMs",
      marketDataBudget.maxOldestLegAgeMs,
      "MARKET_DATA_STALE",
    ),
    checkLimit(
      summary,
      "marketData",
      "legTimestampSkewMs",
      marketDataBudget.maxLegTimestampSkewMs,
      "LEG_TIMESTAMP_SKEW",
    ),
    checkLimit(
      summary,
      "decision",
      "decisionAgeMs",
      decisionBudget.maxDecisionAgeMs,
      "DECISION_STALE",
    ),
    checkLimit(
      summary,
      "execution",
      "orderAckMs",
      executionBudget.maxOrderAckMs,
      "ORDER_ACK_LATENCY",
    ),
    checkLimit(
      summary,
      "execution",
      "reconciliationMs",
      executionBudget.maxReconciliationMs,
      "ORDER_RECONCILIATION_LATENCY",
    ),
  ].filter(Boolean);

  if (checks.length > 0) {
    return {
      ...checks[0],
      dashboardLatencyAffectsTrading: false,
      ignoredDomains: [DASHBOARD_LATENCY_DOMAIN],
    };
  }

  return {
    ok: true,
    rejectionReason: null,
    emergencyStop: false,
    dashboardLatencyAffectsTrading: false,
    ignoredDomains: [DASHBOARD_LATENCY_DOMAIN],
  };
}

module.exports = {
  evaluateExecutionLatencyBudget,
  evaluateTradingLatencyBudget,
  summarizeLatency,
  summarizeLatencyPercentiles,
  TRADING_LATENCY_DOMAINS,
  DASHBOARD_LATENCY_DOMAIN,
};
