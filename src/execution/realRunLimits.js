function numberOrZero(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function tradingDayKey(value = Date.now(), timeZone = "Asia/Seoul") {
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return `${byType.year}-${byType.month}-${byType.day}`;
}

class RealRunLimits {
  constructor(options = {}) {
    this.limits = options.limits || {};
    this.timeZone = options.timeZone || "Asia/Seoul";
    this.records = [];
    this.maxRecords = options.maxRecords || 5000;
  }

  recordCycleResult(result = {}) {
    const startAsset = result.startAsset || (result.cycle && result.cycle.startAsset);
    const pnl = numberOrZero(result.pnl);
    const ts = result.ts || result.timestamp || Date.now();
    const record = {
      type: "cycle_result",
      ts,
      tradingDay: tradingDayKey(ts, this.timeZone),
      startAsset,
      startAmount: result.startAmount === undefined ? null : numberOrZero(result.startAmount),
      pnl,
      realizedLoss: Math.max(0, -pnl),
      planId: result.planId || null,
      cycleId: result.cycleId || null,
      outputAmount: result.outputAmount === undefined ? null : numberOrZero(result.outputAmount),
      feeSummary: result.feeSummary || null,
      legCount: Array.isArray(result.legResults) ? result.legResults.length : null,
    };

    if (startAsset) {
      this.records.push(record);
      if (this.records.length > this.maxRecords) {
        this.records = this.records.slice(-this.maxRecords);
      }
    }

    return record;
  }

  dailyLoss(startAsset, nowMs = Date.now()) {
    const day = tradingDayKey(nowMs, this.timeZone);

    return this.records
      .filter((record) => record.startAsset === startAsset && record.tradingDay === day)
      .reduce((sum, record) => sum + record.realizedLoss, 0);
  }

  dailyLossByAsset(nowMs = Date.now()) {
    const assets = new Set([
      ...Object.keys(this.limits.maxDailyLossByAsset || {}),
      ...this.records.map((record) => record.startAsset).filter(Boolean),
    ]);

    return Object.fromEntries(
      [...assets].map((asset) => [asset, this.dailyLoss(asset, nowMs)]),
    );
  }

  evaluateDailyLoss(startAsset, nowMs = Date.now()) {
    const maxLoss = Number(this.limits.maxDailyLossByAsset && this.limits.maxDailyLossByAsset[startAsset]);
    const currentLoss = this.dailyLoss(startAsset, nowMs);

    if (Number.isFinite(maxLoss) && currentLoss > 0 && currentLoss >= maxLoss) {
      return {
        ok: false,
        rejectionReason: "MAX_DAILY_LOSS",
        emergencyStop: true,
        startAsset,
        currentLoss,
        maxLoss,
      };
    }

    return {
      ok: true,
      rejectionReason: null,
      emergencyStop: false,
      startAsset,
      currentLoss,
      maxLoss: Number.isFinite(maxLoss) ? maxLoss : null,
    };
  }

  summaryByStartAsset(nowMs = Date.now()) {
    const day = tradingDayKey(nowMs, this.timeZone);
    const summary = {};

    for (const record of this.records) {
      if (!record.startAsset) continue;
      if (!summary[record.startAsset]) {
        summary[record.startAsset] = {
          startAsset: record.startAsset,
          cycles: 0,
          totalPnl: 0,
          realizedLoss: 0,
          dailyLoss: 0,
          totalPaidFee: 0,
          totalTradeFee: 0,
          lastCycleAt: null,
        };
      }

      const bucket = summary[record.startAsset];
      const feeSummary = record.feeSummary || {};
      bucket.cycles += 1;
      bucket.totalPnl += numberOrZero(record.pnl);
      bucket.realizedLoss += numberOrZero(record.realizedLoss);
      bucket.totalPaidFee += numberOrZero(feeSummary.totalPaidFee);
      bucket.totalTradeFee += numberOrZero(feeSummary.totalTradeFee);
      const recordTs = Number(record.ts);
      if (Number.isFinite(recordTs)) {
        bucket.lastCycleAt = bucket.lastCycleAt === null
          ? recordTs
          : Math.max(Number(bucket.lastCycleAt), recordTs);
      }

      if (record.tradingDay === day) {
        bucket.dailyLoss += numberOrZero(record.realizedLoss);
      }
    }

    return summary;
  }

  snapshot(nowMs = Date.now()) {
    return {
      tradingDay: tradingDayKey(nowMs, this.timeZone),
      timeZone: this.timeZone,
      dailyLossByAsset: this.dailyLossByAsset(nowMs),
      summaryByStartAsset: this.summaryByStartAsset(nowMs),
      limits: this.limits,
      recentResults: this.records.slice(-50),
    };
  }
}

module.exports = {
  RealRunLimits,
  tradingDayKey,
};
