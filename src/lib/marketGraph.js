function parseMarket(market) {
  if (typeof market !== "string" || market.trim() === "") {
    throw new Error("Market code must be a non-empty string");
  }

  const parts = market.trim().split("-");

  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid Upbit market code: ${market}`);
  }

  return {
    market: market.trim(),
    quote: parts[0],
    base: parts[1],
  };
}

function pairKey(assetA, assetB) {
  if (!assetA || !assetB || assetA === assetB) {
    throw new Error(`Invalid asset pair: ${assetA}, ${assetB}`);
  }

  return [assetA, assetB].sort().join("|");
}

function normalizeMarket(input) {
  if (typeof input === "string") {
    return parseMarket(input);
  }

  if (input && typeof input.market === "string") {
    return {
      ...input,
      ...parseMarket(input.market),
    };
  }

  throw new Error(`Invalid market input: ${JSON.stringify(input)}`);
}

function addUndirectedEdge(graph, assetA, assetB) {
  if (!graph.has(assetA)) {
    graph.set(assetA, new Set());
  }

  if (!graph.has(assetB)) {
    graph.set(assetB, new Set());
  }

  graph.get(assetA).add(assetB);
  graph.get(assetB).add(assetA);
}

function buildGraph(markets) {
  const normalizedMarkets = markets
    .map(normalizeMarket)
    .sort((left, right) => left.market.localeCompare(right.market));

  const graph = new Map();
  const pairMap = new Map();
  const quoteCounts = new Map();

  for (const market of normalizedMarkets) {
    addUndirectedEdge(graph, market.quote, market.base);

    const key = pairKey(market.quote, market.base);
    if (!pairMap.has(key)) {
      pairMap.set(key, market.market);
    }

    quoteCounts.set(market.quote, (quoteCounts.get(market.quote) || 0) + 1);
  }

  return {
    normalizedMarkets,
    graph,
    pairMap,
    quoteCounts,
    assets: [...graph.keys()].sort(),
  };
}

function mapToSortedObject(map) {
  return Object.fromEntries([...map.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

module.exports = {
  parseMarket,
  pairKey,
  buildGraph,
  mapToSortedObject,
};
