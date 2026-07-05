const { pairKey } = require("./marketGraph");

const HUB_RING = ["KRW", "BTC", "USDT"];
const DEFAULT_START_ASSETS = ["KRW", "BTC", "USDT"];

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

function routeSteps(route, triangle, pairMap) {
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

  return steps;
}

function rotateClosedRouteToStart(route, startAsset) {
  const openRoute = route.slice(0, -1);
  const startIndex = openRoute.indexOf(startAsset);

  if (startIndex === -1) {
    throw new Error(`Route ${route.join(" -> ")} does not contain start asset ${startAsset}`);
  }

  return [
    ...openRoute.slice(startIndex),
    ...openRoute.slice(0, startIndex),
    startAsset,
  ];
}

function enabledStartAssetsForTriangle(triangle, enabledStartAssets = DEFAULT_START_ASSETS) {
  return enabledStartAssets
    .filter((asset) => triangle.assets.includes(asset));
}

function buildCycleForRoute(triangle, route, direction, pairMap) {
  const steps = routeSteps(route, triangle, pairMap);
  const directionLabel = direction === "canonical" ? "정방향" : "역방향";
  const startAsset = route[0];
  const endAsset = route[route.length - 1];
  const routeVariantId = `${triangle.id}:${direction}:${startAsset}`;

  // Reverse profitability must be calculated from the actual reverse route using live bid/ask orderbooks. It must not be inferred from 1 / canonicalMultiplier because bid/ask spread and fees break the reciprocal relationship.
  return {
    id: routeVariantId,
    triangleId: triangle.id,
    legacyCycleId: `${triangle.id}:${direction}`,
    cycleId: routeVariantId,
    routeVariantId,
    direction,
    directionLabel,
    startAsset,
    endAsset,
    triangleAssets: triangle.assets,
    assets: triangle.assets,
    route,
    routeLabel: route.join(" -> "),
    markets: steps.map((step) => step.market),
    steps,
  };
}

function buildCanonicalCycle(triangle, pairMap) {
  const route = canonicalRouteForTriangle(triangle);

  return buildCycleForRoute(triangle, route, "canonical", pairMap);
}

function reverseRouteForCanonicalRoute(route) {
  const reverseRoute = [route[0], route[2], route[1], route[0]];

  return reverseRoute;
}

function buildDirectionalCyclesForTriangle(triangle, pairMap) {
  return buildDirectionalCycleVariantsForTriangle(triangle, pairMap);
}

function buildDirectionalCycleVariantsForTriangle(triangle, pairMap, options = {}) {
  const canonicalRoute = canonicalRouteForTriangle(triangle);
  const reverseRoute = reverseRouteForCanonicalRoute(canonicalRoute);
  const enabledStartAssets = options.enabledStartAssets || DEFAULT_START_ASSETS;
  const startAssets = enabledStartAssetsForTriangle(triangle, enabledStartAssets);

  return startAssets.flatMap((startAsset) => [
    buildCycleForRoute(triangle, rotateClosedRouteToStart(canonicalRoute, startAsset), "canonical", pairMap),
    buildCycleForRoute(triangle, rotateClosedRouteToStart(reverseRoute, startAsset), "reverse", pairMap),
  ]);
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
