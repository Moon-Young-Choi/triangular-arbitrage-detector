function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeFeePolicy(chance) {
  return {
    bidFee: numberOrNull(chance.bidFee ?? chance.bid_fee),
    askFee: numberOrNull(chance.askFee ?? chance.ask_fee),
    makerBidFee: numberOrNull(chance.makerBidFee ?? chance.maker_bid_fee ?? chance.bidFee ?? chance.bid_fee),
    makerAskFee: numberOrNull(chance.makerAskFee ?? chance.maker_ask_fee ?? chance.askFee ?? chance.ask_fee),
    raw: chance.raw || chance,
  };
}

async function loadFeePolicyForMarket(restClient, market) {
  return normalizeFeePolicy(await restClient.getOrderChance(market));
}

function resolveLegFee(policy, side, options = {}) {
  const maker = options.maker === true;

  if (side === "bid") {
    return maker ? policy.makerBidFee : policy.bidFee;
  }

  if (side === "ask") {
    return maker ? policy.makerAskFee : policy.askFee;
  }

  throw new Error(`Invalid fee side: ${side}`);
}

function calculateFeeAdjustedBreakEven(fees) {
  const feeFactor = fees.reduce((factor, fee) => factor * (1 - Number(fee || 0)), 1);

  return 1 / feeFactor;
}

module.exports = {
  normalizeFeePolicy,
  loadFeePolicyForMarket,
  resolveLegFee,
  calculateFeeAdjustedBreakEven,
};
