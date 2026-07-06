const DEFAULT_START_ASSETS = Object.freeze(["KRW", "BTC", "USDT"]);
const START_ASSET_GROUPS = Object.freeze({
  KRW: "KRW_START",
  BTC: "BTC_START",
  USDT: "USDT_START",
});

function normalizeStartAsset(asset) {
  const normalized = String(asset || "").trim().toUpperCase();

  if (!DEFAULT_START_ASSETS.includes(normalized)) {
    throw new Error(`Unsupported start asset: ${asset}`);
  }

  return normalized;
}

function normalizeEnabledStartAssets(enabledStartAssets = DEFAULT_START_ASSETS) {
  if (!Array.isArray(enabledStartAssets) || enabledStartAssets.length === 0) {
    throw new Error("enabledStartAssets must be a non-empty array");
  }

  const seen = new Set();

  return enabledStartAssets.map(normalizeStartAsset).filter((asset) => {
    if (seen.has(asset)) {
      throw new Error(`Duplicate enabled start asset: ${asset}`);
    }

    seen.add(asset);
    return true;
  });
}

function enabledStartAssetsForTriangle(triangle, enabledStartAssets = DEFAULT_START_ASSETS) {
  const triangleAssets = new Set((triangle && triangle.assets) || []);

  return normalizeEnabledStartAssets(enabledStartAssets)
    .filter((asset) => triangleAssets.has(asset));
}

function startAssetGroup(startAsset) {
  const asset = normalizeStartAsset(startAsset);
  return START_ASSET_GROUPS[asset];
}

function assertRouteStartAsset(route, startAsset) {
  const asset = normalizeStartAsset(startAsset);

  if (!Array.isArray(route) || route.length < 2) {
    throw new Error("Route must contain at least a start and end asset");
  }

  if (route[0] !== asset || route[route.length - 1] !== asset) {
    throw new Error(`Route must start and end with ${asset}`);
  }

  return route;
}

module.exports = {
  DEFAULT_START_ASSETS,
  START_ASSET_GROUPS,
  assertRouteStartAsset,
  enabledStartAssetsForTriangle,
  normalizeEnabledStartAssets,
  normalizeStartAsset,
  startAssetGroup,
};
