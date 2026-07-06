const test = require("node:test");
const assert = require("node:assert/strict");
const { TimingTrace, diffNsToMs } = require("../src/core/timingTrace");

test("timing trace records perf and cross-clock latency breakdowns", () => {
  const trace = new TimingTrace({
    parseStartPerfNs: "1000000",
    parseDonePerfNs: "2500000",
    calcStartPerfNs: "3000000",
    calcDonePerfNs: "9000000",
    orderSubmitStartPerfNs: "10000000",
    orderAckPerfNs: "12000000",
    reconciliationStartedPerfNs: "13000000",
    reconciliationDonePerfNs: "18000000",
    orderQueryDonePerfNs: "17000000",
    privateWsFillReceivePerfNs: "16000000",
    exchangeTimestampEpochMs: 1000,
    socketReceiveEpochMs: 1012,
    clockSkewSensitive: ["exchangeTimestampEpochMs", "socketReceiveEpochMs"],
  });

  trace.markEpoch("dashboardReceiveEpochMs", 1020, { clockSkewSensitive: true });
  trace.merge({ telemetryPublishEpochMs: 1018 });

  assert.equal(diffNsToMs("2500000", "1000000"), 1.5);
  assert.equal(trace.breakdown().socketParseMs, 1.5);
  assert.equal(trace.breakdown().calcMs, 6);
  assert.equal(trace.breakdown().orderAckMs, 2);
  assert.equal(trace.breakdown().orderReconciliationMs, 5);
  assert.equal(trace.breakdown().orderQueryMs, 4);
  assert.equal(trace.breakdown().privateWsFillMs, 6);
  assert.equal(trace.breakdown().exchangeToSocketMs, 12);
  assert.equal(trace.serialize().clockSkewSensitive.includes("dashboardReceiveEpochMs"), true);
});
