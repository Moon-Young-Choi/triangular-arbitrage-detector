(function () {
  const COLORS = {
    canonical: "#14845f",
    reverse: "#d83f7b",
    neutral: "#2d6f9f",
    unavailable: "#aeb8c5",
    orange: "#e08a17",
  };
  const GROUP_LABELS = {
    KRW_BTC: "KRW -> BTC",
    BTC_USDT: "BTC -> USDT",
    USDT_KRW: "USDT -> KRW",
    OTHER: "Other",
  };

  const chart = document.getElementById("chart");
  const summaryCards = document.getElementById("summaryCards");
  const performanceCards = document.getElementById("performanceCards");
  const connectionLine = document.getElementById("connectionLine");
  const detailBody = document.getElementById("detailBody");
  const pauseButton = document.getElementById("pauseButton");
  const resyncButton = document.getElementById("resyncButton");
  const captureButton = document.getElementById("captureButton");
  const unpinButton = document.getElementById("unpinButton");
  const feeInput = document.getElementById("feeInput");
  const staleInput = document.getElementById("staleInput");
  const autoScaleInput = document.getElementById("autoScaleInput");
  const showUnavailableInput = document.getElementById("showUnavailableInput");
  const groupFilters = document.getElementById("groupFilters");
  const toast = document.getElementById("toast");

  const hoverTooltip = document.createElement("div");
  hoverTooltip.className = "hover-tooltip";
  document.body.appendChild(hoverTooltip);

  let latestState = null;
  let chartRows = [];
  let cycleIdToStateIndex = new Map();
  let cycleIdToPointIndex = new Map();
  let paused = false;
  let pinned = false;
  let chartInitialized = false;
  let eventsBound = false;
  let clampRelayout = false;
  let toastTimer = null;
  let settingsTimer = null;
  let liveSocket = null;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let sseFallbackStarted = false;
  let pendingFrame = false;
  let pendingChangedCycleIds = new Set();
  let activeDetailCycleId = null;
  let renderedFrames = 0;
  let renderFramesPerSec = 0;
  let lastRenderDurationMs = 0;
  let lastFrameReportAt = performance.now();
  const enabledGroups = new Set(Object.keys(GROUP_LABELS));

  function parseNumber(value, fallback) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function feeMetrics(feeRate) {
    const safeFeeRate = Math.max(0, Math.min(feeRate, 0.999999));
    const feeFactor = (1 - safeFeeRate) ** 3;

    return {
      feeRate: safeFeeRate,
      feeFactor,
      executableBreakEvenGross: 1 / feeFactor,
    };
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function formatNumber(value, digits = 8) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return "n/a";
    return Number(value).toLocaleString(undefined, {
      maximumFractionDigits: Math.max(digits, 8),
      minimumFractionDigits: digits,
    });
  }

  function formatCompact(value, digits = 2) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return "n/a";
    return Number(value).toLocaleString(undefined, {
      maximumFractionDigits: digits,
      minimumFractionDigits: digits,
    });
  }

  function formatPercent(value) {
    return value === null || value === undefined ? "n/a" : `${(Number(value) * 100).toFixed(4)}%`;
  }

  function formatMs(value) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return "n/a";
    return `${Number(value).toFixed(Math.abs(value) < 10 ? 3 : 1)} ms`;
  }

  function formatBytes(value) {
    if (!(value > 0)) return "n/a";
    const mib = value / 1024 / 1024;
    return `${mib.toFixed(1)} MiB`;
  }

  function formatTime(value) {
    if (!value) return "n/a";
    const date = typeof value === "number" ? new Date(value) : new Date(value);
    return Number.isNaN(date.getTime()) ? "n/a" : date.toLocaleString();
  }

  function formatLocalTimestamp(date = new Date()) {
    const pad = (value) => String(value).padStart(2, "0");
    return (
      `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
      `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
    );
  }

  function showToast(message) {
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.add("show");
    toastTimer = setTimeout(() => {
      toast.classList.remove("show");
    }, 3600);
  }

  function metric(label, value) {
    return `<div class="metric-card"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(value)}</span></div>`;
  }

  function rebuildStateIndex() {
    cycleIdToStateIndex = new Map();
    (latestState.cycles || []).forEach((row, index) => {
      cycleIdToStateIndex.set(row.cycleId, index);
    });
  }

  function classify(row, metrics, staleThresholdMs) {
    if (row.status === "unavailable" || row.status === "stale" || row.grossMultiplier === null) {
      return "unavailable";
    }

    if (row.maxLegAgeMs !== null && row.maxLegAgeMs !== undefined && row.maxLegAgeMs > staleThresholdMs) {
      return "unavailable";
    }

    if (row.grossMultiplier > metrics.executableBreakEvenGross) {
      return row.direction === "reverse" ? "reverse-profit" : "canonical-profit";
    }

    return "neutral";
  }

  function decorateRow(row) {
    const metrics = feeMetrics(parseNumber(feeInput.value, 0));
    const staleThresholdMs = parseNumber(staleInput.value, 3000);
    const gross = row.grossMultiplier;
    const net = gross === null ? null : gross * metrics.feeFactor;
    const statusClass = classify({ ...row, grossMultiplier: gross }, metrics, staleThresholdMs);

    return {
      ...row,
      y: gross,
      netMultiplier: net,
      grossProfitRate: gross === null ? null : gross - 1,
      netProfitRate: net === null ? null : net - 1,
      feeRate: metrics.feeRate,
      executableBreakEvenGross: metrics.executableBreakEvenGross,
      isActuallyProfitable: statusClass === "canonical-profit" || statusClass === "reverse-profit",
      statusClass,
      markerColor: rowColor({ ...row, statusClass }),
      markerSymbol: row.direction === "reverse" ? "diamond" : "circle",
    };
  }

  function rowColor(row) {
    if (row.statusClass === "canonical-profit") return COLORS.canonical;
    if (row.statusClass === "reverse-profit") return COLORS.reverse;
    if (row.statusClass === "unavailable") return COLORS.unavailable;
    return COLORS.neutral;
  }

  function buildCustomData(row) {
    return {
      triangleId: row.triangleId,
      cycleId: row.cycleId,
      direction: row.direction,
      directionLabel: row.directionLabel,
      route: row.route,
      routeLabel: row.routeLabel,
      group: row.group,
      groupLabel: row.groupLabel,
      grossMultiplier: row.grossMultiplier,
      netMultiplier: row.netMultiplier,
      grossProfitRate: row.grossProfitRate,
      netProfitRate: row.netProfitRate,
      feeRate: row.feeRate,
      executableBreakEvenGross: row.executableBreakEvenGross,
      status: row.statusClass,
      assets: row.assets,
      markets: row.markets,
      legs: row.legs,
      latency: row.latency,
      history: row.history,
      calculatedAtEpochMs: row.calculatedAtEpochMs,
    };
  }

  function updateSummary(rows) {
    if (!latestState) return;
    const available = rows.filter((row) => row.statusClass !== "unavailable").length;
    const unavailable = rows.length - available;
    const metrics = feeMetrics(parseNumber(feeInput.value, 0));
    const ws = latestState.wsStatus || {};
    const wsLabel = `${ws.openConnectionCount || 0}/${ws.connectionCount || 0} open`;

    summaryCards.innerHTML = [
      metric("Markets", latestState.summary.marketsLoaded),
      metric("Triangles", latestState.summary.uniqueTriangleCount || latestState.summary.uniqueTriangles),
      metric("Plotted points", latestState.summary.plottedCycleCount || rows.length),
      metric("Visible", rows.length),
      metric("Available", available),
      metric("Unavailable", unavailable),
      metric("Fee rate", String(metrics.feeRate)),
      metric("Break-even", formatNumber(metrics.executableBreakEvenGross)),
      metric("WebSocket", wsLabel),
    ].join("");

    connectionLine.textContent =
      `Last update ${formatTime(latestState.summary.lastUpdateTime)} | ` +
      `Calculated ${formatTime(latestState.lastCalculatedAt)}`;
  }

  function updatePerformanceCards() {
    const metrics = latestState && latestState.metrics;
    if (!metrics) {
      performanceCards.innerHTML = "";
      return;
    }

    const cpu = metrics.cpu || {};
    const memory = metrics.memory || {};
    const eventLoop = metrics.eventLoop || {};
    const rates = metrics.rates || {};
    const latency = metrics.latency || {};
    const mhzSuffix = cpu.currentMHzFallback ? " fallback" : "";

    performanceCards.innerHTML = [
      metric("CPU", cpu.model || "n/a"),
      metric("Cores", cpu.logicalCores || "n/a"),
      metric("CPU MHz", `${formatCompact(cpu.currentMHz, 0)}${mhzSuffix}`),
      metric("Process CPU", `${formatCompact(cpu.processCpuPercent, 2)}%`),
      metric("Load avg", Array.isArray(cpu.loadAverage) ? cpu.loadAverage.map((v) => v.toFixed(2)).join(" / ") : "n/a"),
      metric("Memory", `${formatBytes(memory.rss)} RSS`),
      metric("Heap", formatBytes(memory.heapUsed)),
      metric("ELU", formatCompact(eventLoop.utilization, 4)),
      metric("Loop p95", formatMs(eventLoop.delay && eventLoop.delay.p95Ms)),
      metric("Upbit msg/s", formatCompact(rates.upbitOrderbookMessagesPerSec, 1)),
      metric("Parsed msg/s", formatCompact(rates.parsedMessagesPerSec, 1)),
      metric("Recalc/s", formatCompact(rates.recalculatedCyclesPerSec, 1)),
      metric("Pushed/s", formatCompact(rates.pushedPointUpdatesPerSec, 1)),
      metric("Render FPS", formatCompact(renderFramesPerSec, 1)),
      metric("Render ms", formatMs(lastRenderDurationMs)),
      metric("Latency p95", formatMs(latency.p95)),
    ].join("");
  }

  function renderGroupFilters() {
    const groups = latestState.groups || [];
    groupFilters.innerHTML = groups
      .map((group) => {
        const checked = enabledGroups.has(group.group) ? "checked" : "";
        const label = GROUP_LABELS[group.group] || group.groupLabel;
        return (
          `<label><input type="checkbox" data-group="${group.group}" ${checked}> ` +
          `${escapeHtml(label)} (${group.count || 0} / ${group.pointCount || 0})</label>`
        );
      })
      .join("");
  }

  function xBounds() {
    if (latestState && latestState.xRange) {
      return [latestState.xRange.min, latestState.xRange.max];
    }

    const xs = (latestState && latestState.cycles || []).map((row) => row.baseX || row.x).filter(Number.isFinite);
    if (xs.length === 0) return [0.25, 1.75];
    return [Math.min(...xs) - 0.75, Math.max(...xs) + 0.75];
  }

  function buildShapes(metrics) {
    const shapes = [
      {
        type: "line",
        xref: "paper",
        x0: 0,
        x1: 1,
        yref: "y",
        y0: 1,
        y1: 1,
        line: { color: "rgba(80,90,105,0.35)", width: 1, dash: "dot" },
      },
      {
        type: "line",
        xref: "paper",
        x0: 0,
        x1: 1,
        yref: "y",
        y0: metrics.executableBreakEvenGross,
        y1: metrics.executableBreakEvenGross,
        line: { color: COLORS.orange, width: 2, dash: "dash" },
      },
    ];

    (latestState.groups || []).forEach((group, index, groups) => {
      if (group.separatorX && index < groups.length - 1) {
        shapes.push({
          type: "line",
          xref: "x",
          x0: group.separatorX,
          x1: group.separatorX,
          yref: "paper",
          y0: 0,
          y1: 1,
          line: { color: "rgba(80,90,105,0.22)", width: 1 },
        });
      }
    });

    return shapes;
  }

  function buildAnnotations(metrics) {
    const annotations = [
      {
        xref: "paper",
        x: 1,
        yref: "y",
        y: 1,
        text: "y = 1",
        showarrow: false,
        xanchor: "right",
        yanchor: "bottom",
        font: { size: 11, color: "#6b7280" },
      },
      {
        xref: "paper",
        x: 0.99,
        yref: "y",
        y: metrics.executableBreakEvenGross,
        text: "실제 방향별 수익분기선: gross > 1 / (1 - fee)^3",
        showarrow: false,
        xanchor: "right",
        yanchor: "bottom",
        font: { size: 12, color: COLORS.orange },
      },
    ];

    (latestState.groups || []).forEach((group) => {
      if (group.midX !== null) {
        annotations.push({
          xref: "x",
          x: group.midX,
          yref: "paper",
          y: 1.06,
          text: `${group.groupLabel}: ${group.count} triangles / ${group.pointCount} points`,
          showarrow: false,
          font: { size: 12, color: "#394150" },
        });
      }
    });

    return annotations;
  }

  function visibleDecoratedRows() {
    return (latestState.cycles || [])
      .map(decorateRow)
      .filter((row) => {
        if (!enabledGroups.has(row.group)) return false;
        if (!showUnavailableInput.checked && row.statusClass === "unavailable") return false;
        return true;
      });
  }

  function rebuildPointIndex() {
    cycleIdToPointIndex = new Map();
    chartRows.forEach((row, index) => {
      cycleIdToPointIndex.set(row.cycleId, index);
    });
  }

  function renderChart() {
    if (!latestState) return;

    const metrics = feeMetrics(parseNumber(feeInput.value, 0));
    chartRows = visibleDecoratedRows();
    rebuildPointIndex();
    updateSummary(chartRows);
    updatePerformanceCards();

    const yValues = chartRows
      .map((row) => row.y)
      .filter((value) => value !== null && Number.isFinite(value));
    const yExtents = [metrics.executableBreakEvenGross, 1, ...yValues];
    const yMin = Math.min(...yExtents);
    const yMax = Math.max(...yExtents);
    const yPad = Math.max((yMax - yMin) * 0.08, 0.000001);
    const [xMin, xMax] = xBounds();

    const trace = {
      type: "scattergl",
      mode: "markers",
      x: chartRows.map((row) => row.x),
      y: chartRows.map((row) => row.y),
      ids: chartRows.map((row) => row.cycleId),
      text: chartRows.map((row) => `${row.directionLabel} ${row.routeLabel}`),
      customdata: chartRows.map(buildCustomData),
      marker: {
        size: 8,
        symbol: chartRows.map((row) => row.markerSymbol),
        color: chartRows.map((row) => row.markerColor),
        opacity: 0.86,
        line: {
          width: chartRows.map((row) => (row.direction === "reverse" ? 1.2 : 0)),
          color: chartRows.map((row) => (row.direction === "reverse" ? "#7a2346" : "rgba(0,0,0,0)")),
        },
      },
      hovertemplate: "<b>%{text}</b><extra></extra>",
    };

    const layout = {
      margin: { l: 68, r: 28, t: 66, b: 54 },
      paper_bgcolor: "#ffffff",
      plot_bgcolor: "#ffffff",
      dragmode: "zoom",
      uirevision: "q-gagarin-live",
      hovermode: "closest",
      xaxis: {
        title: "Triangle cycle index",
        type: "linear",
        zeroline: false,
        showgrid: false,
        range: [xMin, xMax],
        minallowed: xMin,
        maxallowed: xMax,
      },
      yaxis: {
        title: "grossMultiplier",
        zeroline: false,
        showgrid: true,
        gridcolor: "#e6eaf0",
        autorange: autoScaleInput.checked,
      },
      shapes: buildShapes(metrics),
      annotations: buildAnnotations(metrics),
      showlegend: false,
    };

    if (autoScaleInput.checked) {
      layout.yaxis.range = [yMin - yPad, yMax + yPad];
    }

    const started = performance.now();
    Plotly.react(chart, [trace], layout, {
      responsive: true,
      scrollZoom: true,
      displaylogo: false,
      modeBarButtonsToAdd: ["pan2d", "zoom2d", "resetScale2d", "autoScale2d"],
    }).then(() => {
      chartInitialized = true;
      lastRenderDurationMs = performance.now() - started;
      renderedFrames += 1;
      clampCurrentXRange();
    });
  }

  function clampRange(range) {
    const [xMin, xMax] = xBounds();
    if (!Array.isArray(range) || range.length !== 2) return [xMin, xMax];
    let [left, right] = range.map(Number);
    const width = right - left;
    const allowed = xMax - xMin;

    if (!Number.isFinite(left) || !Number.isFinite(right) || width <= 0 || width >= allowed) {
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

  function clampCurrentXRange() {
    if (!chart.layout || !chart.layout.xaxis || clampRelayout) return;
    const current = chart.layout.xaxis.range;
    const clamped = clampRange(current);

    if (!current || Math.abs(current[0] - clamped[0]) > 1e-9 || Math.abs(current[1] - clamped[1]) > 1e-9) {
      clampRelayout = true;
      Plotly.relayout(chart, { "xaxis.range": clamped }).finally(() => {
        clampRelayout = false;
      });
    }
  }

  function priceCell(leg, side) {
    const value = side === "ask" ? leg.askPrice : leg.bidPrice;
    const className = leg.usedSide === side ? " class=\"used-price\"" : "";
    return `<td${className}>${escapeHtml(formatNumber(value, 8))}</td>`;
  }

  function legTable(legs = []) {
    if (!Array.isArray(legs) || legs.length === 0) {
      return "<div class=\"detail-row\"><strong>Legs</strong><span>n/a</span></div>";
    }

    const rows = legs.map((leg) => (
      `<tr>` +
      `<td>${escapeHtml(leg.legIndex)}</td>` +
      `<td>${escapeHtml(leg.fromAsset)} -> ${escapeHtml(leg.toAsset)}</td>` +
      `<td>${escapeHtml(leg.marketCode || leg.market)}</td>` +
      `<td>${escapeHtml(leg.action)}</td>` +
      `<td>${escapeHtml(leg.usedSide)}</td>` +
      priceCell(leg, "ask") +
      priceCell(leg, "bid") +
      `<td>${escapeHtml(formatNumber(leg.askSize, 8))}</td>` +
      `<td>${escapeHtml(formatNumber(leg.bidSize, 8))}</td>` +
      `<td>${escapeHtml(formatNumber(leg.inputAmount, 10))}</td>` +
      `<td>${escapeHtml(formatNumber(leg.outputAmount, 10))}</td>` +
      `<td>${escapeHtml(formatTime(leg.orderbookTimestampMs))}</td>` +
      `<td>${escapeHtml(formatMs(leg.orderbookAgeMs))}</td>` +
      `</tr>`
    )).join("");

    return (
      `<div class="table-wrap"><table>` +
      `<thead><tr>` +
      `<th>#</th><th>From -> To</th><th>Market</th><th>Action</th><th>Used</th>` +
      `<th>Ask price</th><th>Bid price</th><th>Ask size</th><th>Bid size</th>` +
      `<th>Input</th><th>Output</th><th>Orderbook timestamp</th><th>Age</th>` +
      `</tr></thead><tbody>${rows}</tbody></table></div>`
    );
  }

  function historyTable(history = []) {
    if (!Array.isArray(history) || history.length === 0) return "";

    const rows = history.slice(-20).reverse().map((item) => (
      `<tr>` +
      `<td>${escapeHtml(formatTime(item.timestamp))}</td>` +
      `<td>${escapeHtml(formatNumber(item.grossMultiplier, 8))}</td>` +
      `<td>${escapeHtml(formatNumber(item.netMultiplier, 8))}</td>` +
      `<td>${escapeHtml(formatMs(item.latency && item.latency.upbitToServerMs))}</td>` +
      `</tr>`
    )).join("");

    return (
      `<div class="detail-section"><div class="detail-title">Recent multiplier history</div>` +
      `<div class="table-wrap"><table><thead><tr>` +
      `<th>Timestamp</th><th>Gross</th><th>Net</th><th>Upbit -> server</th>` +
      `</tr></thead><tbody>${rows}</tbody></table></div></div>`
    );
  }

  function latencyRows(row) {
    const latency = row.latency || {};
    const items = [
      ["Upbit -> server", `${formatMs(latency.upbitToServerMs)} clock-skew sensitive`],
      ["Server parse", formatMs(latency.serverParseMs)],
      ["Server calc", formatMs(latency.serverCalcMs)],
      ["Server queue", formatMs(latency.serverQueueMs)],
      ["Server -> client", formatMs(latency.serverToClientMs)],
      ["Client render", formatMs(latency.clientRenderMs)],
      ["End -> display", `${formatMs(latency.estimatedEndToDisplayMs)} clock-skew sensitive`],
    ];

    return items
      .map(([label, value]) => `<div class="detail-row"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(value)}</span></div>`)
      .join("");
  }

  function detailRows(row) {
    const route = Array.isArray(row.route) ? row.route.join(" -> ") : row.routeLabel;
    const items = [
      ["Triangle", (row.assets || []).join(" / ")],
      ["Direction", `${row.directionLabel} ${row.direction}`],
      ["Route", route],
      ["Group", row.groupLabel],
      ["Gross", formatNumber(row.grossMultiplier, 8)],
      ["Net", formatNumber(row.netMultiplier, 8)],
      ["Gross profit", formatPercent(row.grossProfitRate)],
      ["Net profit", formatPercent(row.netProfitRate)],
      ["Fee rate", String(row.feeRate)],
      ["Break-even", formatNumber(row.executableBreakEvenGross, 8)],
      ["Status", row.statusClass || row.status],
      ["Reason", row.unavailableReason || row.staleReason || "n/a"],
      ["Freshness", `newest ${formatMs(row.newestLegAgeMs)} / oldest ${formatMs(row.oldestLegAgeMs)}`],
      ["Calculated", formatTime(row.calculatedAtEpochMs || row.calculatedAtIso)],
    ];

    return (
      `<div class="detail-section">` +
      `<div class="detail-title">${escapeHtml(row.directionLabel)} ${escapeHtml(row.direction)} | ${escapeHtml(route)}</div>` +
      items.map(([label, value]) => `<div class="detail-row"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(value)}</span></div>`).join("") +
      `</div>` +
      `<div class="detail-section"><div class="detail-title">Leg orderbooks</div>${legTable(row.legs)}</div>` +
      `<div class="detail-section"><div class="detail-title">Latency</div>${latencyRows(row)}</div>` +
      historyTable(row.history)
    );
  }

  function setDetail(row) {
    if (!row) return;
    activeDetailCycleId = row.cycleId;
    detailBody.innerHTML = detailRows(row);
  }

  function showHover(row, event) {
    if (!row) return;
    const pointer = event || { clientX: 16, clientY: 16 };
    hoverTooltip.innerHTML = detailRows(row);
    hoverTooltip.classList.add("show");
    const margin = 14;
    const rect = hoverTooltip.getBoundingClientRect();
    const left = Math.min(window.innerWidth - rect.width - margin, pointer.clientX + margin);
    const top = Math.min(window.innerHeight - rect.height - margin, pointer.clientY + margin);
    hoverTooltip.style.left = `${Math.max(margin, left)}px`;
    hoverTooltip.style.top = `${Math.max(margin, top)}px`;
  }

  function hideHover() {
    hoverTooltip.classList.remove("show");
  }

  function bindPlotlyEvents() {
    if (eventsBound) return;
    eventsBound = true;

    chart.on("plotly_hover", (event) => {
      if (!event.points || !event.points[0]) return;
      const row = chartRows[event.points[0].pointIndex];
      showHover(row, event.event);
      if (!pinned) setDetail(row);
    });

    chart.on("plotly_unhover", hideHover);

    chart.on("plotly_click", (event) => {
      if (!event.points || !event.points[0]) return;
      pinned = true;
      setDetail(chartRows[event.points[0].pointIndex]);
    });

    chart.on("plotly_relayout", (event) => {
      if (clampRelayout || !event) return;
      if (
        event["xaxis.autorange"] ||
        event["xaxis.range[0]"] !== undefined ||
        event["xaxis.range[1]"] !== undefined
      ) {
        clampCurrentXRange();
      }
    });
  }

  function applyState(state) {
    latestState = state;
    rebuildStateIndex();
    if (!feeInput.dataset.initialized) {
      feeInput.value = String(state.summary.feeRate || 0);
      staleInput.value = String(state.summary.staleOrderbookMs || 3000);
      feeInput.dataset.initialized = "true";
    }
    renderGroupFilters();
    renderChart();
    bindPlotlyEvents();
  }

  function mergeChangedCycles(changedCycles, deltaMeta = {}) {
    for (const changed of changedCycles || []) {
      const index = cycleIdToStateIndex.get(changed.cycleId);
      if (index === undefined) continue;
      const latency = {
        ...(latestState.cycles[index].latency || {}),
        ...(changed.latency || {}),
      };

      if (Number.isFinite(deltaMeta.clientReceivedEpochMs) && Number.isFinite(deltaMeta.sentAtEpochMs)) {
        latency.serverToClientMs = deltaMeta.clientReceivedEpochMs - deltaMeta.sentAtEpochMs;
      }

      latestState.cycles[index] = {
        ...latestState.cycles[index],
        ...changed,
        latency,
      };
      pendingChangedCycleIds.add(changed.cycleId);
    }
  }

  function restyleChart() {
    pendingFrame = false;
    const applyingCycleIds = new Set(pendingChangedCycleIds);
    pendingChangedCycleIds.clear();
    if (!latestState || !chartInitialized) {
      renderChart();
      return;
    }

    const started = performance.now();
    const applyStartEpochMs = Date.now();
    chartRows = visibleDecoratedRows();
    rebuildPointIndex();

    const update = {
      x: [chartRows.map((row) => row.x)],
      y: [chartRows.map((row) => row.y)],
      ids: [chartRows.map((row) => row.cycleId)],
      text: [chartRows.map((row) => `${row.directionLabel} ${row.routeLabel}`)],
      customdata: [chartRows.map(buildCustomData)],
      "marker.color": [chartRows.map((row) => row.markerColor)],
      "marker.symbol": [chartRows.map((row) => row.markerSymbol)],
      "marker.line.width": [chartRows.map((row) => (row.direction === "reverse" ? 1.2 : 0))],
      "marker.line.color": [chartRows.map((row) => (row.direction === "reverse" ? "#7a2346" : "rgba(0,0,0,0)"))],
    };

    Plotly.restyle(chart, update, [0]).then(() => {
      const plotUpdatedEpochMs = Date.now();
      lastRenderDurationMs = performance.now() - started;
      for (const cycleId of applyingCycleIds) {
        const index = cycleIdToStateIndex.get(cycleId);
        if (index === undefined) continue;
        const row = latestState.cycles[index];
        const latency = {
          ...(row.latency || {}),
          clientRenderMs: lastRenderDurationMs,
          estimatedEndToDisplayMs: Number.isFinite(row.lastUpbitTimestampMs)
            ? plotUpdatedEpochMs - row.lastUpbitTimestampMs
            : null,
          clientApplyStartEpochMs: applyStartEpochMs,
          clientPlotUpdatedEpochMs: plotUpdatedEpochMs,
        };
        latestState.cycles[index] = {
          ...row,
          latency,
        };
      }

      chartRows = visibleDecoratedRows();
      rebuildPointIndex();
      renderedFrames += 1;
      updateSummary(chartRows);
      updatePerformanceCards();
      clampCurrentXRange();

      if (activeDetailCycleId) {
        const row = chartRows.find((item) => item.cycleId === activeDetailCycleId);
        if (row) setDetail(row);
      }
    });
  }

  function scheduleRestyle() {
    if (pendingFrame || paused) return;
    pendingFrame = true;
    requestAnimationFrame(restyleChart);
  }

  function applyDelta(delta) {
    if (!latestState) return;
    const clientReceivedEpochMs = Date.now();
    if (delta.summaryDelta) {
      latestState.summary = {
        ...latestState.summary,
        ...delta.summaryDelta,
      };
    }
    if (delta.metrics) {
      latestState.metrics = delta.metrics;
    }
    mergeChangedCycles(delta.changedCycles, {
      clientReceivedEpochMs,
      sentAtEpochMs: delta.sentAtEpochMs,
    });

    if (paused) {
      connectionLine.textContent = `Paused | latest server update ${formatTime(latestState.summary.lastUpdateTime)}`;
      updatePerformanceCards();
      return;
    }

    if (pendingChangedCycleIds.size > 0 || delta.metrics) {
      scheduleRestyle();
    }
  }

  function connectSseFallback() {
    if (sseFallbackStarted) return;
    sseFallbackStarted = true;
    if (!window.EventSource) return;
    const events = new EventSource("/api/events");

    events.addEventListener("state", (event) => {
      applyState(JSON.parse(event.data));
    });

    events.addEventListener("status", (event) => {
      const status = JSON.parse(event.data);
      if (latestState) {
        latestState.wsStatus = status;
      }
    });

    events.addEventListener("error", (event) => {
      showToast(event.data || "Live stream error");
    });

    events.onerror = () => {
      connectionLine.textContent = "SSE disconnected. Browser will retry.";
    };
  }

  function connectLiveSocket() {
    clearTimeout(reconnectTimer);
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    liveSocket = new WebSocket(`${protocol}//${window.location.host}/ws/live`);

    liveSocket.addEventListener("open", () => {
      reconnectAttempt = 0;
      connectionLine.textContent = "WebSocket connected.";
    });

    liveSocket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);

      if (message.type === "hello") {
        return;
      }

      if (message.type === "full-state") {
        applyState(message);
        return;
      }

      if (message.type === "delta" || message.type === "metrics") {
        applyDelta(message);
        return;
      }

      if (message.type === "status") {
        if (latestState) latestState.wsStatus = message.status;
        return;
      }

      if (message.type === "error") {
        showToast(message.message || (message.error && message.error.message) || "Live stream error");
      }
    });

    liveSocket.addEventListener("close", () => {
      const delay = Math.min(1000 * 2 ** reconnectAttempt, 15000);
      reconnectAttempt += 1;
      connectionLine.textContent = `WebSocket disconnected. Reconnecting in ${Math.round(delay / 1000)}s.`;
      if (reconnectAttempt >= 2) {
        connectSseFallback();
      }
      reconnectTimer = setTimeout(connectLiveSocket, delay);
    });

    liveSocket.addEventListener("error", () => {
      showToast("WebSocket error; falling back if needed.");
    });
  }

  async function fetchFullState() {
    const response = await fetch("/api/state");
    applyState(await response.json());
  }

  function sendSettingsSoon() {
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(async () => {
      try {
        const response = await fetch("/api/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            feeRate: parseNumber(feeInput.value, 0),
            staleOrderbookMs: parseNumber(staleInput.value, 3000),
          }),
        });
        if (response.ok) {
          applyState(await response.json());
        }
      } catch (error) {
        showToast(error.message);
      }
    }, 250);
  }

  async function capture() {
    if (!latestState) return;
    const now = new Date();
    const stamp = formatLocalTimestamp(now);
    const snapshot = {
      ...latestState,
      clientFeeRate: parseNumber(feeInput.value, 0),
      clientStaleThresholdMs: parseNumber(staleInput.value, 3000),
      renderedCycles: chartRows,
      chartRange: {
        x: chart.layout && chart.layout.xaxis ? chart.layout.xaxis.range : null,
        y: chart.layout && chart.layout.yaxis ? chart.layout.yaxis.range : null,
      },
      visibleFilters: {
        groups: [...enabledGroups],
        showUnavailable: showUnavailableInput.checked,
        autoScaleY: autoScaleInput.checked,
      },
      renderMetrics: {
        renderFramesPerSec,
        lastRenderDurationMs,
      },
    };

    try {
      const imageDataUrl = await Plotly.toImage(chart, {
        format: "png",
        width: chart.clientWidth || 1400,
        height: chart.clientHeight || 720,
        scale: 2,
      });
      const response = await fetch("/api/capture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageDataUrl,
          snapshot,
          timestamp: now.toISOString(),
        }),
      });
      const result = await response.json();

      if (!response.ok || !result.ok) {
        throw new Error(result.error || "Server-side capture failed");
      }

      showToast(`Saved ${result.pngPath} and ${result.jsonPath}`);
    } catch (error) {
      showToast(`${error.message}. Downloading locally instead.`);
      const imageDataUrl = await Plotly.toImage(chart, { format: "png", scale: 2 });
      const pngLink = document.createElement("a");
      pngLink.href = imageDataUrl;
      pngLink.download = `upbit-triangle-live-${stamp}.png`;
      pngLink.click();

      const jsonLink = document.createElement("a");
      jsonLink.href = URL.createObjectURL(
        new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" }),
      );
      jsonLink.download = `upbit-triangle-live-${stamp}.json`;
      jsonLink.click();
    }
  }

  function bindControls() {
    feeInput.addEventListener("input", () => {
      renderChart();
      sendSettingsSoon();
    });
    staleInput.addEventListener("input", () => {
      renderChart();
      sendSettingsSoon();
    });
    autoScaleInput.addEventListener("change", renderChart);
    showUnavailableInput.addEventListener("change", renderChart);
    pauseButton.addEventListener("click", () => {
      paused = !paused;
      pauseButton.textContent = paused ? "Resume" : "Pause";

      if (!paused && latestState) {
        renderChart();
      }
    });
    resyncButton.addEventListener("click", fetchFullState);
    captureButton.addEventListener("click", capture);
    unpinButton.addEventListener("click", () => {
      pinned = false;
      activeDetailCycleId = null;
      detailBody.textContent = "Hover or click a point.";
    });
    groupFilters.addEventListener("change", (event) => {
      const group = event.target.dataset.group;
      if (!group) return;
      if (event.target.checked) {
        enabledGroups.add(group);
      } else {
        enabledGroups.delete(group);
      }
      renderChart();
    });
  }

  function updateFrameRate() {
    const now = performance.now();
    const elapsedSec = (now - lastFrameReportAt) / 1000;
    if (elapsedSec >= 1) {
      renderFramesPerSec = renderedFrames / elapsedSec;
      renderedFrames = 0;
      lastFrameReportAt = now;
      updatePerformanceCards();

      if (liveSocket && liveSocket.readyState === WebSocket.OPEN) {
        liveSocket.send(JSON.stringify({
          type: "client-metrics",
          renderedFrames: Math.round(renderFramesPerSec),
        }));
      }
    }
    requestAnimationFrame(updateFrameRate);
  }

  async function init() {
    bindControls();
    await fetchFullState();
    if (window.WebSocket) {
      connectLiveSocket();
    } else {
      connectSseFallback();
    }
    requestAnimationFrame(updateFrameRate);
  }

  init().catch((error) => {
    showToast(error.message);
    connectionLine.textContent = error.message;
  });
})();
