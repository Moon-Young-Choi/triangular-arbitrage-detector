const DEFAULT_VALIDATION_CONFIG = Object.freeze({
  sizingMode: "configured",
  startAmountByAsset: Object.freeze({
    KRW: 10000,
    BTC: 0.0002,
    USDT: 10,
  }),
  minOrderAmountByAsset: Object.freeze({
    KRW: 5000,
    BTC: 0.00005,
    USDT: 0.5,
  }),
  maxTouchRatioPerBestLevel: 0.3,
  minResidualRatioPerBestLevel: 0.1,
  minResidualAbsoluteByAsset: Object.freeze({
    KRW: 0,
    BTC: 0,
    USDT: 0,
  }),
  minNetProfitRate: 0,
  maxObservationValidationGapMs: 500,
  maxValidationLegTimestampSkewMs: null,
  maxOldestValidationReceivedAgeMs: null,
  expectedValidationOrderbookUnit: null,
  requireDefaultOrderbookLevel: true,
});

function mergeValidationConfig(config = {}) {
  return {
    ...DEFAULT_VALIDATION_CONFIG,
    ...config,
    startAmountByAsset: {
      ...DEFAULT_VALIDATION_CONFIG.startAmountByAsset,
      ...(config.startAmountByAsset || {}),
    },
    minOrderAmountByAsset: {
      ...DEFAULT_VALIDATION_CONFIG.minOrderAmountByAsset,
      ...(config.minOrderAmountByAsset || {}),
    },
    minResidualAbsoluteByAsset: {
      ...DEFAULT_VALIDATION_CONFIG.minResidualAbsoluteByAsset,
      ...(config.minResidualAbsoluteByAsset || {}),
    },
    maxStartAmountByAsset: {
      ...(config.maxStartAmountByAsset || {}),
    },
  };
}

function maxExecutableStartAmount(startAmount, legs, maxTouchRatio) {
  const candidates = legs
    .filter((leg) => leg.bestLevelTouchRatio > 0)
    .map((leg) => startAmount * (maxTouchRatio / leg.bestLevelTouchRatio))
    .filter((value) => Number.isFinite(value) && value >= 0);

  return candidates.length > 0 ? Math.min(...candidates) : null;
}

function limitingLegFor(legs, policy) {
  const maxTouchRatio = Number(policy.maxTouchRatioPerBestLevel);
  const minResidualRatio = Number(policy.minResidualRatioPerBestLevel);
  let limiting = null;

  for (const leg of legs) {
    const touchRatio = Number(leg.bestLevelTouchRatio);

    if (
      touchRatio > maxTouchRatio ||
      touchRatio > 1 - minResidualRatio
    ) {
      if (!limiting || touchRatio > limiting.bestLevelTouchRatio) {
        limiting = leg;
      }
    }
  }

  return limiting;
}

module.exports = {
  DEFAULT_VALIDATION_CONFIG,
  limitingLegFor,
  maxExecutableStartAmount,
  mergeValidationConfig,
};
