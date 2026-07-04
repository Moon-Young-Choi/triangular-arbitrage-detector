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
    executableBreakEvenGross: 1 / feeFactor,
  };
}

function classifyOpportunity(grossMultiplier, feeRate = 0, status = "available", direction = "canonical") {
  if (status !== "available" || grossMultiplier === null || grossMultiplier === undefined) {
    return "unavailable";
  }

  const { executableBreakEvenGross } = computeFeeMetrics(feeRate);

  if (grossMultiplier > executableBreakEvenGross) {
    return direction === "reverse" ? "reverse-profit" : "canonical-profit";
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
    left.triangleId.localeCompare(right.triangleId)
  );
}

function buildStableCycleLayout(cycles) {
  const decorated = cycles
    .map((cycle) => ({
      ...cycle,
      triangleId: cycle.triangleId || cycle.id,
      cycleId: cycle.cycleId || cycle.id,
      groupInfo: assignCycleGroup(cycle),
    }));

  const triangleBuckets = new Map();

  for (const cycle of decorated) {
    if (!triangleBuckets.has(cycle.triangleId)) {
      triangleBuckets.set(cycle.triangleId, []);
    }

    triangleBuckets.get(cycle.triangleId).push(cycle);
  }

  const trianglesForLayout = [...triangleBuckets.entries()]
    .map(([triangleId, triangleCycles]) => {
      const canonical = triangleCycles.find((cycle) => cycle.direction === "canonical") || triangleCycles[0];

      return {
        triangleId,
        canonical,
        cycles: triangleCycles.sort((left, right) => {
          if (left.direction === right.direction) {
            return left.routeLabel.localeCompare(right.routeLabel);
          }

          return left.direction === "canonical" ? -1 : 1;
        }),
      };
    })
    .sort((left, right) => sortCycleForLayout(left.canonical, right.canonical));

  const groupBuckets = new Map(GROUP_ORDER.map((group) => [group, []]));
  trianglesForLayout.forEach((triangle) => {
    groupBuckets.get(triangle.canonical.groupInfo.group).push(triangle);
  });

  const positionedCycles = [];
  const groups = [];
  let x = 1;

  for (const group of GROUP_ORDER) {
    const trianglesInGroup = groupBuckets.get(group);
    const definition = GROUP_DEFINITIONS[group];
    const startX = trianglesInGroup.length > 0 ? x : null;
    let pointCount = 0;

    trianglesInGroup.forEach((triangle, index) => {
      const baseX = x;
      triangle.cycles.forEach((cycle) => {
        const offset = cycle.direction === "reverse" ? 0.15 : -0.15;
        positionedCycles.push({
          ...cycle,
          group: definition.group,
          groupLabel: definition.groupLabel,
          groupIndex: definition.groupIndex,
          allHub: triangle.canonical.groupInfo.allHub,
          thirdAsset: triangle.canonical.groupInfo.thirdAsset,
          baseX,
          x: baseX + offset,
          xOffset: offset,
          xInGroup: index + 1,
          markerSymbol: cycle.direction === "reverse" ? "diamond" : "circle",
        });
        pointCount += 1;
      });
      x += 1;
    });

    const endX = trianglesInGroup.length > 0 ? x - 1 : null;
    groups.push({
      ...definition,
      count: trianglesInGroup.length,
      pointCount,
      startX,
      endX,
      midX: startX === null ? null : (startX + endX) / 2,
      separatorX: endX === null ? null : endX + 0.5,
    });
  }

  const baseXs = positionedCycles.map((cycle) => cycle.baseX).filter((value) => Number.isFinite(value));
  const firstBaseX = baseXs.length > 0 ? Math.min(...baseXs) : 0;
  const lastBaseX = baseXs.length > 0 ? Math.max(...baseXs) : 1;

  return {
    cycles: positionedCycles,
    groups,
    groupCounts: Object.fromEntries(groups.map((group) => [group.group, group.count])),
    xRange: {
      min: firstBaseX - 0.75,
      max: lastBaseX + 0.75,
    },
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
  const ages = [];

  for (const market of cycle.markets) {
    const orderbook = orderbookMap instanceof Map ? orderbookMap.get(market) : orderbookMap[market];

    if (!orderbook) {
      missingMarkets.push(market);
      continue;
    }

    const receivedAt = orderbook.receivedAt || orderbook.timestamp;
    timestamps.push(orderbook.timestamp);
    receivedAts.push(receivedAt);
    ages.push(receivedAt ? Math.max(0, nowMs - receivedAt) : null);

    if (!receivedAt || nowMs - receivedAt > staleOrderbookMs) {
      staleMarkets.push(market);
    }
  }

  const finiteAges = ages.filter((age) => Number.isFinite(age));
  const freshnessStats = {
    legTimestamps: timestamps,
    newestLegAgeMs: finiteAges.length > 0 ? Math.min(...finiteAges) : null,
    oldestLegAgeMs: finiteAges.length > 0 ? Math.max(...finiteAges) : null,
    maxLegAgeMs: finiteAges.length > 0 ? Math.max(...finiteAges) : null,
  };

  if (missingMarkets.length > 0) {
    return {
      ...freshnessStats,
      status: "unavailable",
      unavailableReason: `Missing orderbook for ${missingMarkets.join(", ")}`,
      lastOrderbookTimestamp: timestamps.length > 0 ? Math.max(...timestamps) : null,
      oldestOrderbookReceivedAt: receivedAts.length > 0 ? Math.min(...receivedAts) : null,
    };
  }

  if (staleMarkets.length > 0) {
    return {
      ...freshnessStats,
      status: "stale",
      unavailableReason: `Stale orderbook for ${staleMarkets.join(", ")}`,
      lastOrderbookTimestamp: Math.max(...timestamps),
      oldestOrderbookReceivedAt: Math.min(...receivedAts),
    };
  }

  return {
    ...freshnessStats,
    status: "available",
    unavailableReason: null,
    lastOrderbookTimestamp: Math.max(...timestamps),
    oldestOrderbookReceivedAt: Math.min(...receivedAts),
  };
}

function percentile(sortedValues, percentileValue) {
  if (sortedValues.length === 0) {
    return null;
  }

  const index = Math.ceil((percentileValue / 100) * sortedValues.length) - 1;
  return sortedValues[Math.max(0, Math.min(sortedValues.length - 1, index))];
}

function rollingStats(samples, nowMs = Date.now(), windowMs = 10000, maxSamples = 2000) {
  const cutoff = nowMs - windowMs;
  const windowed = samples
    .filter((sample) => sample.t >= cutoff)
    .slice(-maxSamples)
    .map((sample) => sample.v)
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);

  return {
    count: windowed.length,
    p50: percentile(windowed, 50),
    p95: percentile(windowed, 95),
    p99: percentile(windowed, 99),
  };
}

function calculateLatencyBreakdown(timings = {}) {
  const diff = (end, start) => (
    Number.isFinite(end) && Number.isFinite(start) ? end - start : null
  );

  return {
    upbitToServerMs: diff(timings.serverReceiveEpochMs, timings.upbitTimestampMs),
    serverParseMs: diff(timings.parseDonePerfMs, timings.serverReceivePerfMs),
    serverCalcMs: diff(timings.calculationEndPerfMs, timings.calculationStartPerfMs),
    serverQueueMs: diff(timings.serverBroadcastSentPerfMs, timings.serverBroadcastQueuedPerfMs),
    serverToClientMs: diff(timings.clientReceivedEpochMs, timings.serverBroadcastSentEpochMs),
    clientRenderMs: diff(timings.clientPlotUpdatedPerfMs, timings.clientApplyStartPerfMs),
    estimatedEndToDisplayMs: diff(timings.clientPlotUpdatedEpochMs, timings.upbitTimestampMs),
  };
}

function clampRange(range, xMin, xMax) {
  if (!Array.isArray(range) || range.length !== 2) {
    return [xMin, xMax];
  }

  let [left, right] = range.map(Number);
  const width = right - left;
  const allowedWidth = xMax - xMin;

  if (!Number.isFinite(left) || !Number.isFinite(right) || width <= 0) {
    return [xMin, xMax];
  }

  if (width >= allowedWidth) {
    return [xMin, xMax];
  }

  if (left < xMin) {
    right += xMin - left;
    left = xMin;
  }

  if (right > xMax) {
    left -= right - xMax;
    right = xMax;
  }

  return [Math.max(xMin, left), Math.min(xMax, right)];
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
  rollingStats,
  calculateLatencyBreakdown,
  clampRange,
};
