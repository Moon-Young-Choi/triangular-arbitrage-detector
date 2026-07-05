const test = require("node:test");
const assert = require("node:assert/strict");
const { RiskGuard, TokenBucketRateLimiter } = require("../src/execution/riskGuard");

test("risk guard rejects machine-readable real-run violations", () => {
  const guard = new RiskGuard({
    config: {
      realRunLimits: {
        maxNotionalPerCycleByAsset: { KRW: 1000 },
        maxOpenOrders: 1,
        maxCyclesPerMinute: 1,
        maxDailyLossByAsset: { KRW: 1000 },
      },
      marketDataGuards: {
        maxOldestLegAgeMs: 100,
        maxLegTimestampSkewMs: 100,
        maxExchangeToServerLatencyMs: 100,
        maxDecisionAgeMs: 100,
      },
      executionGuards: {
        orderRateLimitPerSecond: 1,
      },
    },
    rateLimiter: new TokenBucketRateLimiter({ limitPerSecond: 10 }),
  });

  assert.equal(
    guard.evaluatePlan({ startAsset: "KRW", startAmount: 2000 }, {
      privateWsConnected: true,
      orderChanceFresh: true,
      accountBalanceFresh: true,
      validationDepthFresh: true,
    }).rejectionReason,
    "MAX_NOTIONAL_PER_CYCLE",
  );
  assert.equal(
    guard.evaluatePlan({ startAsset: "KRW", startAmount: 500, oldestLegAgeMs: 200 }, {
      privateWsConnected: true,
      orderChanceFresh: true,
      accountBalanceFresh: true,
      validationDepthFresh: true,
    }).rejectionReason,
    "MARKET_DATA_STALE",
  );
  assert.equal(
    guard.evaluatePrivateWsDisconnect(1).rejectionReason,
    "PRIVATE_WS_DISCONNECT_DURING_ACTIVE_EXECUTION",
  );
});

test("risk guard checks per-order private, cache, validation, and rate gates", () => {
  const guard = new RiskGuard({
    config: {
      executionGuards: {
        orderRateLimitPerSecond: 1,
      },
    },
    rateLimiter: new TokenBucketRateLimiter({ limitPerSecond: 1 }),
  });

  assert.equal(guard.evaluateOrderGuards({
    privateWsConnected: false,
    orderChanceFresh: true,
    accountBalanceFresh: true,
    validationDepthFresh: true,
  }).rejectionReason, "PRIVATE_WS_DISCONNECTED");

  assert.equal(guard.evaluateOrderGuards({
    privateWsConnected: true,
    orderChanceFresh: true,
    accountBalanceFresh: true,
    validationDepthFresh: true,
    nowMs: 1000,
  }).ok, true);

  assert.equal(guard.evaluateOrderGuards({
    privateWsConnected: true,
    orderChanceFresh: true,
    accountBalanceFresh: true,
    validationDepthFresh: true,
    nowMs: 1001,
  }).rejectionReason, "ORDER_RATE_LIMIT");
});
