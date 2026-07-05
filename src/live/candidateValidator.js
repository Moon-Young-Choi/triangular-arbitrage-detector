const { simulateCycleWithDepth } = require("../lib/depthSimulator");

const DEFAULT_VALIDATION_CONFIG = {
  startAmountByAsset: {
    KRW: 10000,
    BTC: 0.0002,
    USDT: 10,
  },
  minOrderAmountByAsset: {
    KRW: 5000,
    BTC: 0.00005,
    USDT: 5,
  },
  maxTouchRatioPerBestLevel: 0.3,
  minResidualRatioPerBestLevel: 0.1,
  minResidualAbsoluteByAsset: {
    KRW: 5000,
    BTC: 0.00005,
    USDT: 5,
  },
  minNetProfitRate: 0,
};

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
  };
}

function maxExecutableStartAmount(startAmount, legs, maxTouchRatio) {
  const candidates = legs
    .filter((leg) => leg.bestLevelTouchRatio > 0)
    .map((leg) => startAmount * (maxTouchRatio / leg.bestLevelTouchRatio))
    .filter((value) => Number.isFinite(value) && value >= 0);

  return candidates.length > 0 ? Math.min(...candidates) : null;
}

function limitingLegFor(legs, maxTouchRatio, minResidualRatio, minResidualAbsoluteByAsset) {
  let limiting = null;

  for (const leg of legs) {
    const touchRatio = Number(leg.bestLevelTouchRatio);
    const residualAfterOrder = Number(leg.residualAfterOrder);
    const minResidualAbsolute = Number(minResidualAbsoluteByAsset[leg.residualAsset] || 0);

    if (
      touchRatio > maxTouchRatio ||
      touchRatio > 1 - minResidualRatio ||
      residualAfterOrder < minResidualAbsolute
    ) {
      if (!limiting || touchRatio > limiting.bestLevelTouchRatio) {
        limiting = leg;
      }
    }
  }

  return limiting;
}

function summarizeAccepted(startAmount, simulated, config) {
  const maxTouch = Math.max(...simulated.legs.map((leg) => leg.bestLevelTouchRatio || 0));
  const maxSlippage = Math.max(...simulated.legs.map((leg) => leg.expectedSlippageBps || 0));
  const limiting = limitingLegFor(
    simulated.legs,
    config.maxTouchRatioPerBestLevel,
    config.minResidualRatioPerBestLevel,
    config.minResidualAbsoluteByAsset,
  );

  if (limiting) {
    return {
      accepted: false,
      validationStatus: "rejected",
      validationReason: "BEST_LEVEL_OVERCONSUMPTION",
      rejectionCode: "BEST_LEVEL_OVERCONSUMPTION",
      executableStartAmount: startAmount,
      maxExecutableStartAmount: maxExecutableStartAmount(startAmount, simulated.legs, config.maxTouchRatioPerBestLevel),
      limitingLeg: limiting.legIndex,
      limitingMarket: limiting.market,
      expectedSlippageBps: maxSlippage,
      bestLevelTouchRatio: maxTouch,
      residualAfterOrder: limiting.residualAfterOrder,
      depthLegs: simulated.legs,
    };
  }

  if (!(simulated.profitRate > config.minNetProfitRate)) {
    return {
      accepted: false,
      validationStatus: "rejected",
      validationReason: "PROFIT_BELOW_THRESHOLD",
      rejectionCode: "PROFIT_BELOW_THRESHOLD",
      executableStartAmount: startAmount,
      maxExecutableStartAmount: maxExecutableStartAmount(startAmount, simulated.legs, config.maxTouchRatioPerBestLevel),
      limitingLeg: null,
      limitingMarket: null,
      expectedSlippageBps: maxSlippage,
      bestLevelTouchRatio: maxTouch,
      residualAfterOrder: null,
      depthLegs: simulated.legs,
    };
  }

  return {
    accepted: true,
    validationStatus: "accepted",
    validationReason: "ACCEPTED",
    rejectionCode: null,
    executableStartAmount: startAmount,
    maxExecutableStartAmount: maxExecutableStartAmount(startAmount, simulated.legs, config.maxTouchRatioPerBestLevel),
    limitingLeg: null,
    limitingMarket: null,
    expectedSlippageBps: maxSlippage,
    bestLevelTouchRatio: maxTouch,
    residualAfterOrder: null,
    depthLegs: simulated.legs,
  };
}

function validateDepthAwareCandidate(cycle, orderbooks, options = {}) {
  const config = mergeValidationConfig(options.config);
  const startAsset = cycle.startAsset || (Array.isArray(cycle.route) ? cycle.route[0] : null);
  const startAmount = Number(options.startAmount || config.startAmountByAsset[startAsset] || 1);
  const minOrderAmount = Number(config.minOrderAmountByAsset[startAsset] || 0);

  if (startAmount < minOrderAmount) {
    return {
      accepted: false,
      validationStatus: "rejected",
      validationReason: "MIN_ORDER_AMOUNT_NOT_MET",
      rejectionCode: "MIN_ORDER_AMOUNT_NOT_MET",
      executableStartAmount: startAmount,
      maxExecutableStartAmount: null,
      limitingLeg: null,
      limitingMarket: null,
      expectedSlippageBps: null,
      bestLevelTouchRatio: null,
      residualAfterOrder: null,
      depthLegs: [],
    };
  }

  const simulated = simulateCycleWithDepth(cycle, orderbooks, startAmount, options.feeRate || 0, {
    nowMs: options.nowMs,
    staleOrderbookMs: options.staleOrderbookMs,
  });

  if (!simulated.available) {
    return {
      accepted: false,
      validationStatus: "rejected",
      validationReason: simulated.rejectionCode || "DEPTH_INSUFFICIENT",
      rejectionCode: simulated.rejectionCode || "DEPTH_INSUFFICIENT",
      executableStartAmount: startAmount,
      maxExecutableStartAmount: null,
      limitingLeg: simulated.limitingLeg || null,
      limitingMarket: simulated.limitingMarket || null,
      expectedSlippageBps: null,
      bestLevelTouchRatio: null,
      residualAfterOrder: null,
      depthLegs: simulated.legs || [],
    };
  }

  return summarizeAccepted(startAmount, simulated, config);
}

module.exports = {
  DEFAULT_VALIDATION_CONFIG,
  mergeValidationConfig,
  validateDepthAwareCandidate,
};
