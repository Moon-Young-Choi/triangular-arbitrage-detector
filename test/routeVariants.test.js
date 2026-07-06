const test = require("node:test");
const assert = require("node:assert/strict");
const { buildGraph } = require("../src/lib/marketGraph");
const { findUniqueTriangles } = require("../src/lib/triangles");
const {
  buildRouteVariantsForTriangle,
  canonicalRouteForTriangle,
  routeVariantIdFor,
} = require("../src/core/routeVariants");
const {
  enabledStartAssetsForTriangle,
  normalizeEnabledStartAssets,
  startAssetGroup,
} = require("../src/core/startAssetPolicy");

function triangleFor(markets) {
  const { graph, pairMap } = buildGraph(markets);
  const [triangle] = findUniqueTriangles(graph, pairMap);

  return { triangle, pairMap };
}

test("route variants include start asset in cycle identity and route boundaries", () => {
  const { triangle, pairMap } = triangleFor(["KRW-BTC", "BTC-ETH", "KRW-ETH"]);
  const variants = buildRouteVariantsForTriangle(triangle, pairMap, {
    enabledStartAssets: ["KRW", "BTC", "USDT"],
  });

  assert.deepEqual(variants.map((variant) => variant.cycleId), [
    "BTC|ETH|KRW:canonical:KRW",
    "BTC|ETH|KRW:reverse:KRW",
    "BTC|ETH|KRW:canonical:BTC",
    "BTC|ETH|KRW:reverse:BTC",
  ]);
  assert.equal(variants.every((variant) => variant.cycleId === variant.routeVariantId), true);
  assert.equal(variants.every((variant) => variant.route[0] === variant.startAsset), true);
  assert.equal(variants.every((variant) => variant.route.at(-1) === variant.startAsset), true);
  assert.equal(variants.every((variant) => variant.startAsset === variant.endAsset), true);
  assert.deepEqual(
    variants.find((variant) => variant.direction === "reverse" && variant.startAsset === "KRW").route,
    ["KRW", "ETH", "BTC", "KRW"],
  );
  assert.deepEqual(
    variants.find((variant) => variant.direction === "canonical" && variant.startAsset === "BTC").markets,
    ["BTC-ETH", "KRW-ETH", "KRW-BTC"],
  );
});

test("start asset policy filters unsupported triangle assets while preserving configured order", () => {
  const { triangle, pairMap } = triangleFor(["KRW-BTC", "BTC-ETH", "KRW-ETH"]);

  assert.deepEqual(enabledStartAssetsForTriangle(triangle, ["USDT", "KRW", "BTC"]), ["KRW", "BTC"]);
  assert.deepEqual(normalizeEnabledStartAssets(["krw", "btc", "usdt"]), ["KRW", "BTC", "USDT"]);
  assert.equal(startAssetGroup("krw"), "KRW_START");

  const variants = buildRouteVariantsForTriangle(triangle, pairMap, {
    enabledStartAssets: ["BTC"],
  });

  assert.deepEqual(variants.map((variant) => variant.startAsset), ["BTC", "BTC"]);
  assert.deepEqual(variants.map((variant) => variant.direction), ["canonical", "reverse"]);
});

test("all-hub route variants cover KRW BTC and USDT start buckets", () => {
  const { triangle, pairMap } = triangleFor(["KRW-BTC", "KRW-USDT", "BTC-USDT"]);
  const variants = buildRouteVariantsForTriangle(triangle, pairMap);

  assert.deepEqual(canonicalRouteForTriangle(triangle), ["KRW", "BTC", "USDT", "KRW"]);
  assert.equal(variants.length, 6);
  assert.deepEqual(
    variants.map((variant) => `${variant.startAsset}:${variant.direction}`),
    [
      "KRW:canonical",
      "KRW:reverse",
      "BTC:canonical",
      "BTC:reverse",
      "USDT:canonical",
      "USDT:reverse",
    ],
  );
  assert.equal(routeVariantIdFor(triangle.id, "canonical", "USDT"), "BTC|KRW|USDT:canonical:USDT");
});

test("start asset policy rejects invalid and duplicate configured assets", () => {
  assert.throws(
    () => normalizeEnabledStartAssets(["KRW", "KRW"]),
    /Duplicate enabled start asset: KRW/,
  );
  assert.throws(
    () => normalizeEnabledStartAssets(["ETH"]),
    /Unsupported start asset: ETH/,
  );
  assert.throws(
    () => normalizeEnabledStartAssets([]),
    /enabledStartAssets must be a non-empty array/,
  );
});
