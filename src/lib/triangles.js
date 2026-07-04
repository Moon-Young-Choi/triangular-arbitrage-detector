const { pairKey } = require("./marketGraph");

const HUB_RING = ["KRW", "BTC", "USDT"];

function hasEdge(graph, assetA, assetB) {
  return graph.has(assetA) && graph.get(assetA).has(assetB);
}

function edgeMarketsForAssets(assets, pairMap) {
  const edgeMarkets = {};

  for (let leftIndex = 0; leftIndex < assets.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < assets.length; rightIndex += 1) {
      const key = pairKey(assets[leftIndex], assets[rightIndex]);
      edgeMarkets[key] = pairMap.get(key);
    }
  }

  return Object.fromEntries(
    Object.entries(edgeMarkets).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function findUniqueTriangles(graph, pairMap) {
  const assets = [...graph.keys()].sort();
  const triangles = [];

  for (let first = 0; first < assets.length - 2; first += 1) {
    for (let second = first + 1; second < assets.length - 1; second += 1) {
      for (let third = second + 1; third < assets.length; third += 1) {
        const triangleAssets = [assets[first], assets[second], assets[third]];
        const [assetA, assetB, assetC] = triangleAssets;

        if (
          hasEdge(graph, assetA, assetB) &&
          hasEdge(graph, assetA, assetC) &&
          hasEdge(graph, assetB, assetC)
        ) {
          const edgeMarkets = edgeMarketsForAssets(triangleAssets, pairMap);

          triangles.push({
            id: triangleAssets.join("|"),
            assets: triangleAssets,
            markets: Object.values(edgeMarkets).sort(),
            edgeMarkets,
          });
        }
      }
    }
  }

  return triangles;
}

function includesAll(assets, requiredAssets) {
  return requiredAssets.every((asset) => assets.includes(asset));
}

function canonicalRouteForTriangle(triangle) {
  const assets = [...triangle.assets].sort();
  const hubsInTriangle = HUB_RING.filter((hub) => assets.includes(hub));

  if (hubsInTriangle.length === 3) {
    return ["KRW", "BTC", "USDT", "KRW"];
  }

  if (hubsInTriangle.length === 2) {
    const [thirdAsset] = assets.filter((asset) => !HUB_RING.includes(asset));

    if (includesAll(assets, ["KRW", "BTC"])) {
      return ["KRW", "BTC", thirdAsset, "KRW"];
    }

    if (includesAll(assets, ["BTC", "USDT"])) {
      return ["BTC", "USDT", thirdAsset, "BTC"];
    }

    if (includesAll(assets, ["KRW", "USDT"])) {
      return ["USDT", "KRW", thirdAsset, "USDT"];
    }
  }

  return [assets[0], assets[1], assets[2], assets[0]];
}

function marketForRouteStep(fromAsset, toAsset, triangle, pairMap) {
  const key = pairKey(fromAsset, toAsset);
  const marketCode = pairMap ? pairMap.get(key) : triangle.edgeMarkets[key];

  if (!marketCode) {
    throw new Error(`Missing market for route step ${fromAsset} -> ${toAsset}`);
  }

  return marketCode;
}

function buildCanonicalCycle(triangle, pairMap) {
  const route = canonicalRouteForTriangle(triangle);
  const steps = [];

  for (let index = 0; index < route.length - 1; index += 1) {
    const fromAsset = route[index];
    const toAsset = route[index + 1];

    steps.push({
      index,
      fromAsset,
      toAsset,
      market: marketForRouteStep(fromAsset, toAsset, triangle, pairMap),
    });
  }

  const reverseRoute = [route[0], route[2], route[1], route[0]];
  // The reverse direction is not plotted by default. With zero spread and zero fees it is approximately the reciprocal of the canonical multiplier, but with real bid/ask orderbooks and fees it must be recalculated before execution.
  return {
    id: triangle.id,
    triangleAssets: triangle.assets,
    route,
    routeLabel: route.join(" -> "),
    reverseRoute,
    reverseRouteLabel: reverseRoute.join(" -> "),
    markets: steps.map((step) => step.market),
    steps,
  };
}

function buildCanonicalCycles(triangles, pairMap) {
  return triangles
    .map((triangle) => buildCanonicalCycle(triangle, pairMap))
    .sort((left, right) => left.routeLabel.localeCompare(right.routeLabel));
}

function getHubBreakdownCounts(triangles) {
  const counts = {
    "KRW-BTC-X": 0,
    "BTC-USDT-X": 0,
    "KRW-USDT-X": 0,
    "KRW-BTC-USDT": 0,
  };

  for (const triangle of triangles) {
    const assets = triangle.assets;
    const isAllHub = includesAll(assets, ["KRW", "BTC", "USDT"]);

    if (isAllHub) {
      counts["KRW-BTC-USDT"] += 1;
    } else if (includesAll(assets, ["KRW", "BTC"])) {
      counts["KRW-BTC-X"] += 1;
    } else if (includesAll(assets, ["BTC", "USDT"])) {
      counts["BTC-USDT-X"] += 1;
    } else if (includesAll(assets, ["KRW", "USDT"])) {
      counts["KRW-USDT-X"] += 1;
    }
  }

  return counts;
}

module.exports = {
  findUniqueTriangles,
  buildCanonicalCycle,
  buildCanonicalCycles,
  getHubBreakdownCounts,
  canonicalRouteForTriangle,
};
