const DEFAULT_PARTIAL_FILL_POLICY = "CONTINUE_IF_ABOVE_MIN";
const ABORT_ON_PARTIAL = "ABORT_ON_PARTIAL";
const PARTIAL_FILL_POLICY_IDS = Object.freeze([
  DEFAULT_PARTIAL_FILL_POLICY,
  ABORT_ON_PARTIAL,
]);
const PARTIAL_FILL_POLICY_SET = new Set(PARTIAL_FILL_POLICY_IDS);

function normalizePartialFillPolicy(value = DEFAULT_PARTIAL_FILL_POLICY) {
  const policy = value || DEFAULT_PARTIAL_FILL_POLICY;

  if (!PARTIAL_FILL_POLICY_SET.has(policy)) {
    throw new Error(`Invalid partial fill policy: ${policy}`);
  }

  return policy;
}

function resolvePartialFillPolicy(options = {}) {
  return normalizePartialFillPolicy(
    options.partialFillPolicy ||
      (options.runtimeConfig &&
        options.runtimeConfig.executionPolicy &&
        options.runtimeConfig.executionPolicy.partialFillPolicy) ||
      DEFAULT_PARTIAL_FILL_POLICY,
  );
}

function evaluatePartialFillPolicy(input = {}) {
  const {
    fill = {},
    isLastLeg = false,
    minNextOrderAmount = 0,
    nextAsset = null,
  } = input;
  const policy = normalizePartialFillPolicy(input.policy);
  const actualAmount = Number(input.actualAmount ?? fill.amount ?? 0);

  if (fill.isPartial && policy === ABORT_ON_PARTIAL) {
    return {
      ok: false,
      rejectionReason: "PARTIAL_FILL_ABORTED_BY_POLICY",
      residualAsset: fill.residualAsset,
      residualAmount: fill.residualAmount,
      actualAmount,
      partialFillPolicy: policy,
    };
  }

  if (!isLastLeg && actualAmount < Number(minNextOrderAmount || 0)) {
    return {
      ok: false,
      rejectionReason: "PARTIAL_FILL_BELOW_MIN_THRESHOLD",
      residualAsset: nextAsset,
      actualAmount,
      minNextOrderAmount: Number(minNextOrderAmount || 0),
      partialFillPolicy: policy,
    };
  }

  return {
    ok: true,
    rejectionReason: null,
    partialFillPolicy: policy,
  };
}

module.exports = {
  ABORT_ON_PARTIAL,
  DEFAULT_PARTIAL_FILL_POLICY,
  PARTIAL_FILL_POLICY_IDS,
  PARTIAL_FILL_POLICY_SET,
  evaluatePartialFillPolicy,
  normalizePartialFillPolicy,
  resolvePartialFillPolicy,
};
