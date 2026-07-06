const { parseMarket } = require("../../lib/marketGraph");

const MIN_TOTAL_BY_QUOTE_ASSET = {
  KRW: 5000,
  BTC: 0.00005,
  USDT: 0.5,
};

const KRW_PRICE_UNITS = [
  { min: 2000000, unit: 1000 },
  { min: 1000000, unit: 1000 },
  { min: 500000, unit: 500 },
  { min: 100000, unit: 100 },
  { min: 50000, unit: 50 },
  { min: 10000, unit: 10 },
  { min: 5000, unit: 5 },
  { min: 1000, unit: 1 },
  { min: 100, unit: 1 },
  { min: 10, unit: 0.1 },
  { min: 1, unit: 0.01 },
  { min: 0.1, unit: 0.001 },
  { min: 0.01, unit: 0.0001 },
  { min: 0.001, unit: 0.00001 },
  { min: 0.0001, unit: 0.000001 },
  { min: 0.00001, unit: 0.0000001 },
  { min: 0, unit: 0.00000001 },
];

const USDT_PRICE_UNITS = [
  { min: 10, unit: 0.01 },
  { min: 1, unit: 0.001 },
  { min: 0.1, unit: 0.0001 },
  { min: 0.01, unit: 0.00001 },
  { min: 0.001, unit: 0.000001 },
  { min: 0.0001, unit: 0.0000001 },
  { min: 0, unit: 0.00000001 },
];

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") {
    return false;
  }

  return Number.isFinite(Number(value));
}

function decimalPlaces(value) {
  const text = String(value).toLowerCase();
  if (text.includes("e-")) {
    const [mantissa, exponent] = text.split("e-");
    return decimalPlaces(mantissa) + Number(exponent);
  }

  if (text.includes("e+")) {
    const [mantissa, exponent] = text.split("e+");
    return Math.max(0, decimalPlaces(mantissa) - Number(exponent));
  }

  if (!text.includes(".")) return 0;
  return text.split(".")[1].length;
}

function numericString(value, digits = 12) {
  return Number(value).toFixed(digits).replace(/\.?0+$/u, "");
}

function priceUnitForQuoteAsset(quoteAsset, price) {
  const normalizedQuote = String(quoteAsset || "").toUpperCase();
  const numericPrice = Number(price);

  if (!Number.isFinite(numericPrice) || numericPrice < 0) {
    throw new Error(`Invalid price for Upbit price unit: ${price}`);
  }

  if (normalizedQuote === "BTC") return 0.00000001;

  const table = normalizedQuote === "KRW"
    ? KRW_PRICE_UNITS
    : normalizedQuote === "USDT"
      ? USDT_PRICE_UNITS
      : null;

  if (!table) return null;
  return table.find((entry) => numericPrice >= entry.min).unit;
}

function priceUnitForMarket(market, price) {
  return priceUnitForQuoteAsset(parseMarket(market).quote, price);
}

function roundPriceToUnit(price, unit, side) {
  const numericPrice = Number(price);
  const numericUnit = Number(unit);

  if (!Number.isFinite(numericPrice) || numericPrice <= 0) {
    throw new Error(`Invalid limit price: ${price}`);
  }

  if (!Number.isFinite(numericUnit) || numericUnit <= 0) {
    return numericPrice;
  }

  const scale = 10 ** Math.min(12, Math.max(decimalPlaces(numericUnit), decimalPlaces(numericPrice)));
  const scaledPrice = Math.round(numericPrice * scale);
  const scaledUnit = Math.round(numericUnit * scale);
  const quotient = scaledPrice / scaledUnit;
  const roundedUnits = side === "ask" ? Math.ceil(quotient) : Math.floor(quotient);

  return roundedUnits * scaledUnit / scale;
}

function normalizeLimitPrice({ market, price, side, priceUnit }) {
  const unit = numberOrNull(priceUnit) || priceUnitForMarket(market, price);
  const normalizedPrice = roundPriceToUnit(price, unit, side);

  return {
    price: numericString(normalizedPrice),
    numericPrice: normalizedPrice,
    priceUnit: unit,
    priceWasRounded: Math.abs(Number(price) - normalizedPrice) > Number.EPSILON,
  };
}

function minTotalForQuoteAsset(quoteAsset) {
  return MIN_TOTAL_BY_QUOTE_ASSET[String(quoteAsset || "").toUpperCase()] || null;
}

function minTotalFromChanceMarket(chanceMarket = {}, side) {
  const sideMin = side === "ask"
    ? chanceMarket.ask && chanceMarket.ask.minTotal
    : chanceMarket.bid && chanceMarket.bid.minTotal;
  return numberOrNull(
    sideMin ??
    chanceMarket.minTotal ??
    chanceMarket.min_total ??
    (side === "ask"
      ? chanceMarket.ask && chanceMarket.ask.min_total
      : chanceMarket.bid && chanceMarket.bid.min_total),
  );
}

function normalizeMarketPolicy(input = {}) {
  const raw = input.raw || input;
  const market = input.market && input.market.id
    ? input.market.id
    : input.id || raw.market && raw.market.id || raw.market;
  const parsed = market ? parseMarket(market) : { quote: input.quoteAsset || input.quote, base: input.baseAsset || input.base };
  const chanceMarket = input.market || raw.market || {};

  return {
    market,
    quoteAsset: parsed.quote,
    baseAsset: parsed.base,
    bid: {
      minTotal: minTotalFromChanceMarket(chanceMarket, "bid"),
      maxTotal: numberOrNull(chanceMarket.bid && (chanceMarket.bid.maxTotal ?? chanceMarket.bid.max_total)),
    },
    ask: {
      minTotal: minTotalFromChanceMarket(chanceMarket, "ask"),
      maxTotal: numberOrNull(chanceMarket.ask && (chanceMarket.ask.maxTotal ?? chanceMarket.ask.max_total)),
    },
    minTotal: numberOrNull(chanceMarket.minTotal ?? chanceMarket.min_total),
    maxTotal: numberOrNull(chanceMarket.maxTotal ?? chanceMarket.max_total),
    priceUnit: numberOrNull(input.priceUnit ?? chanceMarket.priceUnit ?? chanceMarket.price_unit),
    state: chanceMarket.state,
    source: input.source || (input.raw ? "orders/chance" : "fallback"),
    raw,
  };
}

function policyForMarket(market, input = null) {
  const parsed = parseMarket(market);
  const normalized = input ? normalizeMarketPolicy(input) : {
    market,
    quoteAsset: parsed.quote,
    baseAsset: parsed.base,
    bid: {},
    ask: {},
    minTotal: null,
    maxTotal: null,
    priceUnit: null,
    state: null,
    source: "fallback",
    raw: null,
  };
  const fallbackMinTotal = minTotalForQuoteAsset(parsed.quote);

  return {
    ...normalized,
    market,
    quoteAsset: parsed.quote,
    baseAsset: parsed.base,
    bid: {
      ...(normalized.bid || {}),
      minTotal: numberOrNull(normalized.bid && normalized.bid.minTotal) ?? numberOrNull(normalized.minTotal) ?? fallbackMinTotal,
    },
    ask: {
      ...(normalized.ask || {}),
      minTotal: numberOrNull(normalized.ask && normalized.ask.minTotal) ?? numberOrNull(normalized.minTotal) ?? fallbackMinTotal,
    },
  };
}

async function loadMarketPolicy(restClient, market) {
  if (!restClient || typeof restClient.getOrderChance !== "function") {
    return policyForMarket(market);
  }

  return policyForMarket(market, await restClient.getOrderChance(market));
}

function minimumTotalForOrder(policy, side) {
  if (!policy) return null;
  const sidePolicy = side === "ask" ? policy.ask : policy.bid;
  return numberOrNull(sidePolicy && sidePolicy.minTotal) ??
    numberOrNull(policy.minTotal) ??
    minTotalForQuoteAsset(policy.quoteAsset);
}

function orderTotal(order) {
  if (!order) return null;

  if (order.ord_type === "best" && order.side === "bid") {
    return numberOrNull(order.price);
  }

  const volume = numberOrNull(order.volume);
  const price = numberOrNull(order.price ?? order.observedBestPrice);
  if (volume === null || price === null) return null;
  return volume * price;
}

function validateOrderMinimum(order, policy) {
  const minTotal = minimumTotalForOrder(policy, order && order.side);
  const total = orderTotal(order);

  if (minTotal === null || total === null) {
    return {
      ok: true,
      total,
      minTotal,
    };
  }

  return {
    ok: total + 1e-12 >= minTotal,
    total,
    minTotal,
    rejectionReason: "MIN_ORDER_TOTAL",
  };
}

function hasCompleteMarketPolicy(policy) {
  return Boolean(
    policy &&
    finiteNumber(minimumTotalForOrder(policy, "bid")) &&
    finiteNumber(minimumTotalForOrder(policy, "ask")),
  );
}

module.exports = {
  MIN_TOTAL_BY_QUOTE_ASSET,
  priceUnitForQuoteAsset,
  priceUnitForMarket,
  normalizeLimitPrice,
  roundPriceToUnit,
  minTotalForQuoteAsset,
  normalizeMarketPolicy,
  policyForMarket,
  loadMarketPolicy,
  minimumTotalForOrder,
  orderTotal,
  validateOrderMinimum,
  hasCompleteMarketPolicy,
};
