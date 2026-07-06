const { pairKey } = require("./marketGraph");
const {
  HUB_RING,
  buildRouteVariant,
  buildRouteVariantsForTriangle,
  canonicalRouteForTriangle,
  includesAll,
  reverseRouteForCanonicalRoute,
  rotateClosedRouteToStart,
} = require("../core/routeVariants");
const {
  DEFAULT_START_ASSETS,
  enabledStartAssetsForTriangle,
} = require("../core/startAssetPolicy");

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

function buildCycleForRoute(triangle, route, direction, pairMap) {
  return buildRouteVariant(triangle, route, direction, pairMap);
}

function buildCanonicalCycle(triangle, pairMap) {
  const route = canonicalRouteForTriangle(triangle);

  return buildCycleForRoute(triangle, route, "canonical", pairMap);
}

function buildDirectionalCyclesForTriangle(triangle, pairMap) {
  return buildDirectionalCycleVariantsForTriangle(triangle, pairMap);
}

function buildDirectionalCycleVariantsForTriangle(triangle, pairMap, options = {}) {
  return buildRouteVariantsForTriangle(triangle, pairMap, options);
}

function buildCanonicalCycles(triangles, pairMap) {
  return triangles
    .map((triangle) => buildCanonicalCycle(triangle, pairMap))
    .sort((left, right) => left.routeLabel.localeCompare(right.routeLabel));
}

function buildDirectionalCycles(triangles, pairMap, options = {}) {
  return triangles
    .flatMap((triangle) => buildDirectionalCycleVariantsForTriangle(triangle, pairMap, options))
    .sort((left, right) => (
      left.triangleId.localeCompare(right.triangleId) ||
      left.startAsset.localeCompare(right.startAsset) ||
      left.direction.localeCompare(right.direction)
    ));
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
  buildDirectionalCyclesForTriangle,
  buildDirectionalCycleVariantsForTriangle,
  buildDirectionalCycles,
  getHubBreakdownCounts,
  canonicalRouteForTriangle,
  reverseRouteForCanonicalRoute,
  rotateClosedRouteToStart,
  enabledStartAssetsForTriangle,
};
