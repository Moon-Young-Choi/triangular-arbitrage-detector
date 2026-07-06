const test = require("node:test");
const assert = require("node:assert/strict");
const { RiskGuard, TokenBucketRateLimiter } = require("../src/execution/riskGuards");

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
        maxOrderAckMs: 1,
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
  const balanceRejected = guard.evaluatePlan({ startAsset: "KRW", startAmount: 700 }, {
    privateWsConnected: true,
    orderChanceFresh: true,
    accountBalanceFresh: true,
    validationDepthFresh: true,
    availableBalances: { KRW: 600 },
    lockedBalances: { KRW: 400 },
  });
  assert.equal(balanceRejected.rejectionReason, "BALANCE_INSUFFICIENT");
  assert.equal(balanceRejected.availableBalance, 600);
  assert.equal(balanceRejected.lockedBalance, 400);
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
  assert.equal(
    guard.evaluatePlan({ startAsset: "KRW", startAmount: 500 }, {
      privateWsConnected: true,
      orderChanceFresh: true,
      accountBalanceFresh: true,
      validationDepthFresh: true,
      dailyLossByAsset: { KRW: 1000 },
    }).rejectionReason,
    "MAX_DAILY_LOSS",
  );
});

test("risk guard checks per-order private, cache, validation, and rate gates", () => {
  const guard = new RiskGuard({
    config: {
      executionGuards: {
        orderRateLimitPerSecond: 1,
        maxOrderAckMs: 1,
      },
    },
    rateLimiter: new TokenBucketRateLimiter({ limitPerSecond: 1 }),
  });

  assert.equal(guard.evaluateOrderGuards({
    emergencyStopActive: true,
    privateWsConnected: true,
    orderChanceFresh: true,
    accountBalanceFresh: true,
    validationDepthFresh: true,
  }).rejectionReason, "EMERGENCY_STOP_ACTIVE");

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

  assert.equal(guard.evaluateExecutionLatency({
    orderAckMs: 2,
    reconciliationMs: 1,
  }).rejectionReason, "ORDER_ACK_LATENCY");
});

test("token bucket honors an explicit zero per-second limit", () => {
  const limiter = new TokenBucketRateLimiter({ limitPerSecond: 0 });

  assert.equal(limiter.allow(1000), false);
});
