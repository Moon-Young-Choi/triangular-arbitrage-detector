const { pairKey } = require("../lib/marketGraph");
const {
  DEFAULT_START_ASSETS,
  assertRouteStartAsset,
  enabledStartAssetsForTriangle,
} = require("./startAssetPolicy");

const HUB_RING = Object.freeze(["KRW", "BTC", "USDT"]);

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

function reverseRouteForCanonicalRoute(route) {
  return [route[0], route[2], route[1], route[0]];
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

function routeVariantIdFor(triangleId, direction, startAsset) {
  return `${triangleId}:${direction}:${startAsset}`;
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

function buildRouteVariant(triangle, route, direction, pairMap) {
  const startAsset = route[0];
  const endAsset = route[route.length - 1];
  const steps = routeSteps(assertRouteStartAsset(route, startAsset), triangle, pairMap);
  const directionLabel = direction === "canonical" ? "정방향" : "역방향";
  const routeVariantId = routeVariantIdFor(triangle.id, direction, startAsset);

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

function buildRouteVariantsForTriangle(triangle, pairMap, options = {}) {
  const canonicalRoute = canonicalRouteForTriangle(triangle);
  const reverseRoute = reverseRouteForCanonicalRoute(canonicalRoute);
  const enabledStartAssets = options.enabledStartAssets || DEFAULT_START_ASSETS;
  const startAssets = enabledStartAssetsForTriangle(triangle, enabledStartAssets);

  return startAssets.flatMap((startAsset) => [
    buildRouteVariant(triangle, rotateClosedRouteToStart(canonicalRoute, startAsset), "canonical", pairMap),
    buildRouteVariant(triangle, rotateClosedRouteToStart(reverseRoute, startAsset), "reverse", pairMap),
  ]);
}

module.exports = {
  HUB_RING,
  buildRouteVariant,
  buildRouteVariantsForTriangle,
  canonicalRouteForTriangle,
  includesAll,
  reverseRouteForCanonicalRoute,
  rotateClosedRouteToStart,
  routeSteps,
  routeVariantIdFor,
};
