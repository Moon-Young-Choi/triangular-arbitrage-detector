const test = require("node:test");
const assert = require("node:assert/strict");
const {
  BEST_IOC_EXECUTION_MODE,
  DEFAULT_EXECUTION_MODE,
  assertExecutionModeEnabled,
  normalizeExecutionMode,
  orderKindForExecutionMode,
} = require("../src/execution/executionModes");
const {
  DEFAULT_PARTIAL_FILL_POLICY,
  evaluatePartialFillPolicy,
  normalizePartialFillPolicy,
} = require("../src/execution/partialFillPolicy");
const {
  residualFromFill,
  residualFromInterruptedLeg,
} = require("../src/execution/residualAssetPolicy");
const readinessCheck = require("../src/execution/readinessCheck");
const coreReadiness = require("../src/core/readinessChecker");
const riskGuards = require("../src/execution/riskGuards");
const riskGuard = require("../src/execution/riskGuard");

test("execution mode contract defaults to limit IOC and gates BEST_IOC opt-in", () => {
  assert.equal(normalizeExecutionMode(), DEFAULT_EXECUTION_MODE);
  assert.equal(orderKindForExecutionMode(DEFAULT_EXECUTION_MODE), "limit");
  assert.equal(orderKindForExecutionMode(BEST_IOC_EXECUTION_MODE), "best");
  assert.equal(assertExecutionModeEnabled(DEFAULT_EXECUTION_MODE, [DEFAULT_EXECUTION_MODE]), DEFAULT_EXECUTION_MODE);
  assert.throws(
    () => assertExecutionModeEnabled(BEST_IOC_EXECUTION_MODE, [DEFAULT_EXECUTION_MODE]),
    /BEST_IOC requires explicit enabledExecutionModes opt-in/,
  );
  assert.throws(() => normalizeExecutionMode("MARKET_IOC"), /Invalid execution mode/);
});

test("partial fill policy decides continue, abort, and below-min residual paths", () => {
  assert.equal(normalizePartialFillPolicy(), DEFAULT_PARTIAL_FILL_POLICY);

  const partialFill = {
    isPartial: true,
    amount: 0.001,
    residualAsset: "KRW",
    residualAmount: 5000,
  };

  assert.equal(evaluatePartialFillPolicy({
    policy: DEFAULT_PARTIAL_FILL_POLICY,
    fill: partialFill,
    actualAmount: 0.001,
    nextAsset: "BTC",
    minNextOrderAmount: 0.0005,
  }).ok, true);

  const aborted = evaluatePartialFillPolicy({
    policy: "ABORT_ON_PARTIAL",
    fill: partialFill,
    actualAmount: 0.001,
    nextAsset: "BTC",
  });
  assert.equal(aborted.ok, false);
  assert.equal(aborted.rejectionReason, "PARTIAL_FILL_ABORTED_BY_POLICY");
  assert.equal(aborted.residualAsset, "KRW");
  assert.equal(aborted.residualAmount, 5000);

  const belowMin = evaluatePartialFillPolicy({
    policy: DEFAULT_PARTIAL_FILL_POLICY,
    fill: { isPartial: false, amount: 0.0001 },
    actualAmount: 0.0001,
    nextAsset: "BTC",
    minNextOrderAmount: 0.0005,
    isLastLeg: false,
  });
  assert.equal(belowMin.ok, false);
  assert.equal(belowMin.rejectionReason, "PARTIAL_FILL_BELOW_MIN_THRESHOLD");
  assert.equal(belowMin.residualAsset, "BTC");
});

test("residual asset policy accounts for unsubmitted and remaining order amounts", () => {
  const bidResidual = residualFromFill({
    step: { fromAsset: "KRW" },
    submittedOrder: {
      side: "bid",
      observedBestPrice: 100,
      unsubmittedInputAmount: 20,
      liquidityCapped: true,
    },
    executedVolume: 0.5,
    requestedVolume: 1,
    remainingVolume: 0.5,
    avgPrice: 100,
  });

  assert.equal(bidResidual.isPartial, true);
  assert.equal(bidResidual.isLiquidityCapped, true);
  assert.equal(bidResidual.residualAsset, "KRW");
  assert.equal(bidResidual.orderResidualAmount, 50);
  assert.equal(bidResidual.residualAmount, 70);

  const interrupted = residualFromInterruptedLeg(
    { fromAsset: "BTC" },
    0.002,
    { reason: "PRIVATE_WS_DISCONNECTED" },
  );
  assert.equal(interrupted.residualAsset, "BTC");
  assert.equal(interrupted.actualAmount, 0.002);
  assert.equal(interrupted.reason, "PRIVATE_WS_DISCONNECTED");
});

test("phase L compatibility modules expose risk guards and readiness checks", () => {
  assert.equal(riskGuards.RiskGuard, riskGuard.RiskGuard);
  assert.equal(readinessCheck.checkRealRunReadiness, coreReadiness.checkRealRunReadiness);
  assert.equal(readinessCheck.checkExecutionReadiness, coreReadiness.checkRealRunReadiness);
});
