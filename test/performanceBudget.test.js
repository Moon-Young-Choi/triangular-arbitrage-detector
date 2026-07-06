const test = require("node:test");
const assert = require("node:assert/strict");
const {
  summarizeLatency,
  evaluateExecutionLatencyBudget,
  evaluateTradingLatencyBudget,
  summarizeLatencyPercentiles,
} = require("../src/core/performanceBudget");

test("performance budget separates latency domains and marks cross-clock metrics", () => {
  const summary = summarizeLatency({
    latency: {
      upbitToServerMs: 12,
      serverToClientMs: 4,
      estimatedEndToDisplayMs: 30,
    },
    execution: {
      orderAckMs: 8,
      reconciliationMs: 20,
      source: "rest-query",
    },
  });

  assert.equal(summary.marketData.exchangeToSocketMs.valueMs, 12);
  assert.equal(summary.marketData.exchangeToSocketMs.clockSkewSensitive, true);
  assert.equal(summary.execution.orderAckMs.valueMs, 8);
  assert.equal(summary.execution.source, "rest-query");
  assert.equal(summary.display.estimatedEndToDisplayMs.clockSkewSensitive, true);
});

test("performance budget rejects slow execution latency with machine reasons", () => {
  assert.equal(evaluateExecutionLatencyBudget({
    orderAckMs: 501,
    reconciliationMs: 100,
  }, {
    maxOrderAckMs: 500,
    maxReconciliationMs: 3000,
  }).rejectionReason, "ORDER_ACK_LATENCY");

  assert.equal(evaluateExecutionLatencyBudget({
    orderAckMs: 100,
    reconciliationMs: 3001,
  }, {
    maxOrderAckMs: 500,
    maxReconciliationMs: 3000,
  }).rejectionReason, "ORDER_RECONCILIATION_LATENCY");
});

test("performance budget reports p50 p95 p99 by latency domain", () => {
  const report = summarizeLatencyPercentiles([
    summarizeLatency({
      latency: {
        upbitToServerMs: 10,
        serverCalcMs: 2,
        serverToClientMs: 100,
        estimatedEndToDisplayMs: 200,
      },
      execution: {
        orderAckMs: 20,
        reconciliationMs: 30,
      },
    }),
    summarizeLatency({
      latency: {
        upbitToServerMs: 20,
        serverCalcMs: 4,
        serverToClientMs: 200,
        estimatedEndToDisplayMs: 300,
      },
      execution: {
        orderAckMs: 30,
        reconciliationMs: 40,
      },
    }),
    summarizeLatency({
      latency: {
        upbitToServerMs: 30,
        serverCalcMs: 6,
        serverToClientMs: 300,
        estimatedEndToDisplayMs: 400,
      },
      execution: {
        orderAckMs: 40,
        reconciliationMs: 50,
      },
    }),
  ]);

  assert.deepEqual(report.tradingLatencyDomains, ["marketData", "decision", "execution"]);
  assert.equal(report.displayLatencyAffectsTrading, false);
  assert.equal(report.marketData.exchangeToSocketMs.p50Ms, 20);
  assert.equal(report.marketData.exchangeToSocketMs.p95Ms, 30);
  assert.equal(report.decision.calcMs.p99Ms, 6);
  assert.equal(report.execution.orderAckMs.p50Ms, 30);
  assert.equal(report.display.serverToClientMs.p95Ms, 300);
  assert.equal(report.display.serverToClientMs.tradingDecisionInput, false);
  assert.equal(report.marketData.exchangeToSocketMs.clockSkewSensitive, true);
});

test("trading latency budget ignores display render latency", () => {
  const ok = evaluateTradingLatencyBudget({
    marketData: {
      exchangeToSocketMs: { valueMs: 50 },
      orderbookAgeMs: { valueMs: 80 },
      legTimestampSkewMs: { valueMs: 10 },
    },
    decision: {
      decisionAgeMs: { valueMs: 40 },
    },
    execution: {
      orderAckMs: { valueMs: 20 },
      reconciliationMs: { valueMs: 30 },
    },
    display: {
      clientRenderMs: { valueMs: 10000 },
      estimatedEndToDisplayMs: { valueMs: 20000 },
    },
  }, {
    marketData: {
      maxExchangeToServerLatencyMs: 100,
      maxOldestLegAgeMs: 100,
      maxLegTimestampSkewMs: 100,
    },
    decision: {
      maxDecisionAgeMs: 100,
    },
    execution: {
      maxOrderAckMs: 100,
      maxReconciliationMs: 100,
    },
    display: {
      maxClientRenderMs: 1,
    },
  });

  assert.equal(ok.ok, true);
  assert.equal(ok.displayLatencyAffectsTrading, false);
  assert.deepEqual(ok.ignoredDomains, ["display"]);

  const rejected = evaluateTradingLatencyBudget({
    latency: {
      upbitToServerMs: 150,
      oldestLegAgeMs: 50,
      legTimestampSkewMs: 10,
      decisionAgeMs: 40,
      clientRenderMs: 1,
    },
    execution: {
      orderAckMs: 20,
      reconciliationMs: 30,
    },
  }, {
    marketData: {
      maxExchangeToServerLatencyMs: 100,
      maxOldestLegAgeMs: 100,
      maxLegTimestampSkewMs: 100,
    },
    decision: {
      maxDecisionAgeMs: 100,
    },
    execution: {
      maxOrderAckMs: 100,
      maxReconciliationMs: 100,
    },
  });

  assert.equal(rejected.ok, false);
  assert.equal(rejected.rejectionReason, "EXCHANGE_TO_SERVER_LATENCY");
  assert.equal(rejected.domain, "marketData");
  assert.equal(rejected.metric, "exchangeToSocketMs");
});
