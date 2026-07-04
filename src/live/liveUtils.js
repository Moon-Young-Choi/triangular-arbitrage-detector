const GROUP_ORDER = ["KRW_BTC", "BTC_USDT", "USDT_KRW", "OTHER"];

const GROUP_DEFINITIONS = {
  KRW_BTC: { group: "KRW_BTC", groupLabel: "KRW -> BTC", groupIndex: 0 },
  BTC_USDT: { group: "BTC_USDT", groupLabel: "BTC -> USDT", groupIndex: 1 },
  USDT_KRW: { group: "USDT_KRW", groupLabel: "USDT -> KRW", groupIndex: 2 },
  OTHER: { group: "OTHER", groupLabel: "Other", groupIndex: 3 },
};

function includesAll(assets, requiredAssets) {
  return requiredAssets.every((asset) => assets.includes(asset));
}

function computeFeeMetrics(feeRate = 0) {
  if (!Number.isFinite(feeRate) || feeRate < 0 || feeRate >= 1) {
    throw new Error(`Invalid fee rate: ${feeRate}`);
  }

  const feeFactor = (1 - feeRate) ** 3;

  return {
    feeRate,
    feeFactor,
    upperBreakEven: 1 / feeFactor,
    lowerBreakEven: feeFactor,
  };
}

function classifyOpportunity(grossCanonicalMultiplier, feeRate = 0, status = "available") {
  if (status !== "available" || grossCanonicalMultiplier === null || grossCanonicalMultiplier === undefined) {
    return "unavailable";
  }

  const { upperBreakEven, lowerBreakEven } = computeFeeMetrics(feeRate);

  if (grossCanonicalMultiplier > upperBreakEven) {
    return "canonical-profit";
  }

  if (grossCanonicalMultiplier < lowerBreakEven) {
    return "implied-reverse-profit";
  }

  return "neutral";
}

function assignCycleGroup(cycle) {
  const assets = [...cycle.triangleAssets].sort();
  const allHub = includesAll(assets, ["KRW", "BTC", "USDT"]);
  let definition = GROUP_DEFINITIONS.OTHER;
  let thirdAsset = assets.join("/");

  if (allHub || includesAll(assets, ["KRW", "BTC"])) {
    definition = GROUP_DEFINITIONS.KRW_BTC;
    thirdAsset = allHub ? "" : assets.find((asset) => !["KRW", "BTC"].includes(asset));
  } else if (includesAll(assets, ["BTC", "USDT"])) {
    definition = GROUP_DEFINITIONS.BTC_USDT;
    thirdAsset = assets.find((asset) => !["BTC", "USDT"].includes(asset));
  } else if (includesAll(assets, ["KRW", "USDT"])) {
    definition = GROUP_DEFINITIONS.USDT_KRW;
    thirdAsset = assets.find((asset) => !["KRW", "USDT"].includes(asset));
  }

  return {
    ...definition,
    allHub,
    thirdAsset: thirdAsset || "",
  };
}

function sortCycleForLayout(left, right) {
  if (left.groupInfo.groupIndex !== right.groupInfo.groupIndex) {
    return left.groupInfo.groupIndex - right.groupInfo.groupIndex;
  }

  if (left.groupInfo.allHub !== right.groupInfo.allHub) {
    return left.groupInfo.allHub ? -1 : 1;
  }

  return (
    left.groupInfo.thirdAsset.localeCompare(right.groupInfo.thirdAsset) ||
    left.routeLabel.localeCompare(right.routeLabel) ||
    left.id.localeCompare(right.id)
  );
}

function buildStableCycleLayout(cycles) {
  const decorated = cycles
    .map((cycle) => ({
      ...cycle,
      cycleId: cycle.id,
      groupInfo: assignCycleGroup(cycle),
    }))
    .sort(sortCycleForLayout);

  const groupBuckets = new Map(GROUP_ORDER.map((group) => [group, []]));
  decorated.forEach((cycle) => {
    groupBuckets.get(cycle.groupInfo.group).push(cycle);
  });

  const positionedCycles = [];
  const groups = [];
  let x = 1;

  for (const group of GROUP_ORDER) {
    const cyclesInGroup = groupBuckets.get(group);
    const definition = GROUP_DEFINITIONS[group];
    const startX = cyclesInGroup.length > 0 ? x : null;

    cyclesInGroup.forEach((cycle, index) => {
      positionedCycles.push({
        ...cycle,
        group: definition.group,
        groupLabel: definition.groupLabel,
        groupIndex: definition.groupIndex,
        allHub: cycle.groupInfo.allHub,
        thirdAsset: cycle.groupInfo.thirdAsset,
        x,
        xInGroup: index + 1,
      });
      x += 1;
    });

    const endX = cyclesInGroup.length > 0 ? x - 1 : null;
    groups.push({
      ...definition,
      count: cyclesInGroup.length,
      startX,
      endX,
      midX: startX === null ? null : (startX + endX) / 2,
      separatorX: endX === null ? null : endX + 0.5,
    });
  }

  return {
    cycles: positionedCycles,
    groups,
    groupCounts: Object.fromEntries(groups.map((group) => [group.group, group.count])),
  };
}

function formatLocalTimestampForFilename(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");

  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

function getCycleFreshness(cycle, orderbookMap, staleOrderbookMs, nowMs = Date.now()) {
  const missingMarkets = [];
  const staleMarkets = [];
  const timestamps = [];
  const receivedAts = [];

  for (const market of cycle.markets) {
    const orderbook = orderbookMap instanceof Map ? orderbookMap.get(market) : orderbookMap[market];

    if (!orderbook) {
      missingMarkets.push(market);
      continue;
    }

    const receivedAt = orderbook.receivedAt || orderbook.timestamp;
    timestamps.push(orderbook.timestamp);
    receivedAts.push(receivedAt);

    if (!receivedAt || nowMs - receivedAt > staleOrderbookMs) {
      staleMarkets.push(market);
    }
  }

  if (missingMarkets.length > 0) {
    return {
      status: "unavailable",
      unavailableReason: `Missing orderbook for ${missingMarkets.join(", ")}`,
      lastOrderbookTimestamp: timestamps.length > 0 ? Math.max(...timestamps) : null,
      oldestOrderbookReceivedAt: receivedAts.length > 0 ? Math.min(...receivedAts) : null,
    };
  }

  if (staleMarkets.length > 0) {
    return {
      status: "stale",
      unavailableReason: `Stale orderbook for ${staleMarkets.join(", ")}`,
      lastOrderbookTimestamp: Math.max(...timestamps),
      oldestOrderbookReceivedAt: Math.min(...receivedAts),
    };
  }

  return {
    status: "available",
    unavailableReason: null,
    lastOrderbookTimestamp: Math.max(...timestamps),
    oldestOrderbookReceivedAt: Math.min(...receivedAts),
  };
}

module.exports = {
  GROUP_ORDER,
  GROUP_DEFINITIONS,
  computeFeeMetrics,
  classifyOpportunity,
  assignCycleGroup,
  buildStableCycleLayout,
  formatLocalTimestampForFilename,
  getCycleFreshness,
};
