const { parseMarket } = require("../../lib/marketGraph");

const DEFAULT_TAKER_FEE_BY_QUOTE_ASSET = Object.freeze({
  KRW: 0.0005,
  BTC: 0.0025,
  USDT: 0.0025,
});

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
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

function defaultTakerFeeRateForMarket(market) {
  const quoteAsset = parseMarket(market).quote;
  return DEFAULT_TAKER_FEE_BY_QUOTE_ASSET[quoteAsset] ?? 0;
}

function defaultFeePolicyForMarket(market) {
  const fee = defaultTakerFeeRateForMarket(market);

  return {
    market,
    bidFee: fee,
    askFee: fee,
    makerBidFee: fee,
    makerAskFee: fee,
    source: "upbit-default",
    loadedAt: null,
    expiresAt: null,
    raw: null,
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
  DEFAULT_TAKER_FEE_BY_QUOTE_ASSET,
  normalizeFeePolicy,
  defaultFeePolicyForMarket,
  defaultTakerFeeRateForMarket,
  loadFeePolicyForMarket,
  resolveLegFee,
  hasCompleteFeePolicy,
  isFeePolicyExpired,
  calculateFeeAdjustedBreakEven,
  marketCodeFromChance,
};
