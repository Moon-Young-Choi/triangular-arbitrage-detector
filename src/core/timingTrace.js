function perfNowNs() {
  return process.hrtime.bigint().toString();
}

function diffNsToMs(endNs, startNs) {
  if (endNs === null || endNs === undefined || startNs === null || startNs === undefined) {
    return null;
  }

  const end = BigInt(endNs);
  const start = BigInt(startNs);

  return Number(end - start) / 1e6;
}

class TimingTrace {
  constructor(initial = {}) {
    this.points = { ...initial };
    this.clockSkewSensitive = new Set(initial.clockSkewSensitive || []);
  }

  markEpoch(name, value = Date.now(), options = {}) {
    this.points[name] = value;

    if (options.clockSkewSensitive) {
      this.clockSkewSensitive.add(name);
    }

    return value;
  }

  markPerfNs(name, value = perfNowNs()) {
    this.points[name] = value;
    return value;
  }

  merge(values = {}) {
    Object.assign(this.points, values);

    if (Array.isArray(values.clockSkewSensitive)) {
      values.clockSkewSensitive.forEach((name) => this.clockSkewSensitive.add(name));
    }

    return this;
  }

  serialize() {
    return {
      ...this.points,
      clockSkewSensitive: [...this.clockSkewSensitive],
    };
  }

  breakdown() {
    const p = this.points;

    return {
      socketParseMs: diffNsToMs(p.parseDonePerfNs, p.parseStartPerfNs),
      normalizeMs: diffNsToMs(p.normalizeDonePerfNs, p.normalizeStartPerfNs),
      cacheWriteMs: diffNsToMs(p.cacheWriteDonePerfNs, p.cacheWriteStartPerfNs),
      affectedCycleLookupMs: diffNsToMs(p.affectedCycleLookupDonePerfNs, p.affectedCycleLookupStartPerfNs),
      calcMs: diffNsToMs(p.calcDonePerfNs, p.calcStartPerfNs),
      strategyMs: diffNsToMs(p.strategyDonePerfNs, p.strategyStartPerfNs),
      riskMs: diffNsToMs(p.riskDonePerfNs, p.riskStartPerfNs),
      orderAckMs: diffNsToMs(p.orderAckPerfNs, p.orderSubmitStartPerfNs),
      browserApplyToRenderMs: p.browserRenderDonePerfMs !== undefined && p.browserApplyStartPerfMs !== undefined
        ? p.browserRenderDonePerfMs - p.browserApplyStartPerfMs
        : null,
      exchangeToSocketMs: p.socketReceiveEpochMs !== undefined && p.exchangeTimestampEpochMs !== undefined
        ? p.socketReceiveEpochMs - p.exchangeTimestampEpochMs
        : null,
      dashboardReceiveLagMs: p.dashboardReceiveEpochMs !== undefined && p.telemetryPublishEpochMs !== undefined
        ? p.dashboardReceiveEpochMs - p.telemetryPublishEpochMs
        : null,
      clockSkewSensitive: [...this.clockSkewSensitive],
    };
  }
}

module.exports = {
  TimingTrace,
  perfNowNs,
  diffNsToMs,
};
