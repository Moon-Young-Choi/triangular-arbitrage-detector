function numberOrZero(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function residualFromFill(input = {}) {
  const {
    step = {},
    submittedOrder = {},
  } = input;
  const executedVolume = numberOrZero(input.executedVolume);
  const requestedVolume = numberOrZero(input.requestedVolume);
  const remainingVolume = numberOrZero(input.remainingVolume);
  const avgPrice = numberOrZero(input.avgPrice);
  const unsubmittedInputAmount = Math.max(0, numberOrZero(submittedOrder.unsubmittedInputAmount));
  const feeRate = Math.max(0, numberOrZero(submittedOrder.feeRate));
  const isPartial = remainingVolume > 0 ||
    (requestedVolume > 0 && executedVolume > 0 && executedVolume < requestedVolume);
  const orderResidualAmount = isPartial && submittedOrder.side === "bid"
    ? remainingVolume * numberOrZero(submittedOrder.observedBestPrice || avgPrice) * (1 + feeRate)
    : remainingVolume;
  const residualAmount = Math.max(0, unsubmittedInputAmount + orderResidualAmount);

  return {
    isPartial,
    isLiquidityCapped: submittedOrder.liquidityCapped === true || unsubmittedInputAmount > 0,
    hasResidual: isPartial || residualAmount > 0,
    residualAsset: step.fromAsset || null,
    residualAmount,
    orderResidualAmount,
    unsubmittedInputAmount,
  };
}

function residualFromInterruptedLeg(step = {}, amount, details = {}) {
  const residualAmount = numberOrZero(amount);

  return {
    residualAsset: details.residualAsset || step.fromAsset || null,
    residualAmount,
    actualAmount: residualAmount,
    reason: details.reason || null,
  };
}

module.exports = {
  residualFromFill,
  residualFromInterruptedLeg,
};
