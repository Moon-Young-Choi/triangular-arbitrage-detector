const test = require("node:test");
const assert = require("node:assert/strict");
const { RealRunLimits, tradingDayKey } = require("../src/execution/realRunLimits");

test("real run limits track daily realized loss by start asset", () => {
  const limits = new RealRunLimits({
    limits: {
      maxDailyLossByAsset: { KRW: 10, BTC: 0.01 },
    },
    timeZone: "Asia/Seoul",
  });
  const now = Date.UTC(2026, 6, 5, 15, 0, 0);

  assert.equal(tradingDayKey(now, "Asia/Seoul"), "2026-07-06");

  limits.recordCycleResult({
    startAsset: "KRW",
    pnl: -4,
    startAmount: 100,
    outputAmount: 96,
    feeSummary: { totalPaidFee: 1, totalTradeFee: 1.2, legs: 3 },
    legResults: [{ legIndex: 1 }, { legIndex: 2 }, { legIndex: 3 }],
    planId: "p1",
    cycleId: "c1",
    ts: now,
  });
  limits.recordCycleResult({
    startAsset: "KRW",
    pnl: 2,
    planId: "p2",
    cycleId: "c2",
    ts: now,
  });
  limits.recordCycleResult({
    startAsset: "KRW",
    pnl: -6,
    planId: "p3",
    cycleId: "c3",
    ts: now,
  });
  limits.recordCycleResult({
    startAsset: "BTC",
    pnl: 0.002,
    feeSummary: { totalPaidFee: 0.0001, totalTradeFee: 0.0002, legs: 3 },
    planId: "p4",
    cycleId: "c4",
    ts: now,
  });

  assert.equal(limits.dailyLoss("KRW", now), 10);
  assert.equal(limits.evaluateDailyLoss("KRW", now).ok, false);
  assert.equal(limits.evaluateDailyLoss("KRW", now).rejectionReason, "MAX_DAILY_LOSS");
  assert.equal(limits.evaluateDailyLoss("BTC", now).ok, true);
  assert.equal(limits.snapshot(now).recentResults[0].startAmount, 100);
  assert.equal(limits.snapshot(now).recentResults[0].feeSummary.totalPaidFee, 1);
  assert.equal(limits.snapshot(now).recentResults[0].legCount, 3);
  assert.equal(limits.snapshot(now).summaryByStartAsset.KRW.cycles, 3);
  assert.equal(limits.snapshot(now).summaryByStartAsset.KRW.totalPnl, -8);
  assert.equal(limits.snapshot(now).summaryByStartAsset.KRW.realizedLoss, 10);
  assert.equal(limits.snapshot(now).summaryByStartAsset.KRW.totalPaidFee, 1);
  assert.equal(limits.snapshot(now).summaryByStartAsset.BTC.cycles, 1);
  assert.equal(limits.snapshot(now).summaryByStartAsset.BTC.totalPnl, 0.002);
  assert.equal(limits.snapshot(now).summaryByStartAsset.BTC.totalTradeFee, 0.0002);
});
