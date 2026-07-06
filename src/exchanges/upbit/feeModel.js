function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") {
    return false;
  }

  return Number.isFinite(Number(value));
}

function marketCodeFromChance(chance) {
  if (typeof chance.market === "string") return chance.market;
  if (chance.market && typeof chance.market === "object") {
    return chance.market.id || chance.market.market || chance.market.code || null;
  }

  return chance.marketId || chance.code || null;
}

function normalizeFeePolicy(chance) {
  return {
    market: marketCodeFromChance(chance),
    bidFee: numberOrNull(chance.bidFee ?? chance.bid_fee),
    askFee: numberOrNull(chance.askFee ?? chance.ask_fee),
    makerBidFee: numberOrNull(chance.makerBidFee ?? chance.maker_bid_fee ?? chance.bidFee ?? chance.bid_fee),
    makerAskFee: numberOrNull(chance.makerAskFee ?? chance.maker_ask_fee ?? chance.askFee ?? chance.ask_fee),
    source: chance.source || "orders/chance",
    loadedAt: chance.loadedAt || null,
    expiresAt: chance.expiresAt || null,
    raw: chance.raw || chance,
  };
}

async function loadFeePolicyForMarket(restClient, market) {
  return normalizeFeePolicy(await restClient.getOrderChance(market));
}

function resolveLegFee(policy, side, options = {}) {
  const maker = options.maker === true || options.expectedMaker === true;

  if (side === "bid") {
    return maker ? policy.makerBidFee : policy.bidFee;
  }

  if (side === "ask") {
    return maker ? policy.makerAskFee : policy.askFee;
  }

  throw new Error(`Invalid fee side: ${side}`);
}

function hasCompleteFeePolicy(policy) {
  return Boolean(
    policy &&
    finiteNumber(policy.bidFee) &&
    finiteNumber(policy.askFee) &&
    finiteNumber(policy.makerBidFee) &&
    finiteNumber(policy.makerAskFee),
  );
}

function isFeePolicyExpired(policy, nowMs = Date.now()) {
  if (!policy || !policy.expiresAt) return true;
  const expiresAtMs = Date.parse(policy.expiresAt);
  return !Number.isFinite(expiresAtMs) || nowMs > expiresAtMs;
}

function calculateFeeAdjustedBreakEven(fees) {
  const feeFactor = fees.reduce((factor, fee) => factor * (1 - Number(fee || 0)), 1);

  return 1 / feeFactor;
}

module.exports = {
  normalizeFeePolicy,
  loadFeePolicyForMarket,
  resolveLegFee,
  hasCompleteFeePolicy,
  isFeePolicyExpired,
  calculateFeeAdjustedBreakEven,
  marketCodeFromChance,
};
