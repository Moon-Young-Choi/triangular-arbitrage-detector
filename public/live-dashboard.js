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
  const connectionLine = document.getElementById("connectionLine");
  const detailBody = document.getElementById("detailBody");
  const pauseButton = document.getElementById("pauseButton");
  const captureButton = document.getElementById("captureButton");
  const unpinButton = document.getElementById("unpinButton");
  const feeInput = document.getElementById("feeInput");
  const staleInput = document.getElementById("staleInput");
  const autoScaleInput = document.getElementById("autoScaleInput");
  const showUnavailableInput = document.getElementById("showUnavailableInput");
  const groupFilters = document.getElementById("groupFilters");
  const toast = document.getElementById("toast");

  let latestState = null;
  let chartRows = [];
  let paused = false;
  let pinned = false;
  let toastTimer = null;
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
      upperBreakEven: 1 / feeFactor,
      lowerBreakEven: feeFactor,
    };
  }

  function formatMultiplier(value) {
    return value === null || value === undefined ? "n/a" : Number(value).toFixed(8);
  }

  function formatPercent(value) {
    return value === null || value === undefined ? "n/a" : `${(Number(value) * 100).toFixed(4)}%`;
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

  function classify(row, metrics, staleThresholdMs) {
    if (row.status === "unavailable" || row.grossCanonicalMultiplier === null) {
      return "unavailable";
    }

    if (
      row.status === "stale" ||
      !row.oldestOrderbookReceivedAt ||
      Date.now() - row.oldestOrderbookReceivedAt > staleThresholdMs
    ) {
      return "unavailable";
    }

    if (row.grossCanonicalMultiplier > metrics.upperBreakEven) {
      return "canonical-profit";
    }

    if (row.grossCanonicalMultiplier < metrics.lowerBreakEven) {
      return "implied-reverse-profit";
    }

    return "neutral";
  }

  function decorateRows() {
    const metrics = feeMetrics(parseNumber(feeInput.value, 0));
    const staleThresholdMs = parseNumber(staleInput.value, 5000);

    return latestState.cycles.map((row) => {
      const statusClass = classify(row, metrics, staleThresholdMs);
      const gross = row.grossCanonicalMultiplier;
      const net = gross === null ? null : gross * metrics.feeFactor;
      const reverseGross = gross === null ? null : 1 / gross;
      const reverseNet = reverseGross === null ? null : reverseGross * metrics.feeFactor;

      return {
        ...row,
        y: gross,
        netCanonicalMultiplier: net,
        grossProfitRate: gross === null ? null : gross - 1,
        netProfitRate: net === null ? null : net - 1,
        impliedReverseGrossMultiplier: reverseGross,
        impliedReverseNetMultiplier: reverseNet,
        feeRate: metrics.feeRate,
        upperBreakEven: metrics.upperBreakEven,
        lowerBreakEven: metrics.lowerBreakEven,
        statusClass,
      };
    });
  }

  function rowColor(row) {
    if (row.statusClass === "canonical-profit") return COLORS.canonical;
    if (row.statusClass === "implied-reverse-profit") return COLORS.reverse;
    if (row.statusClass === "unavailable") return COLORS.unavailable;
    return COLORS.neutral;
  }

  function buildCustomData(row) {
    return [
      row.assets.join(" / "),
      row.routeLabel,
      row.markets.join(", "),
      row.groupLabel,
      formatMultiplier(row.grossCanonicalMultiplier),
      formatMultiplier(row.netCanonicalMultiplier),
      formatPercent(row.grossProfitRate),
      formatPercent(row.netProfitRate),
      formatMultiplier(row.impliedReverseGrossMultiplier),
      formatMultiplier(row.impliedReverseNetMultiplier),
      String(row.feeRate),
      formatMultiplier(row.upperBreakEven),
      formatMultiplier(row.lowerBreakEven),
      row.statusClass,
      row.unavailableReason || "",
      formatTime(row.lastOrderbookTimestamp),
      formatTime(row.calculatedAt),
    ];
  }

  function metric(label, value) {
    return `<div class="metric-card"><strong>${label}</strong><span>${value}</span></div>`;
  }

  function updateSummary(rows) {
    const available = rows.filter((row) => row.statusClass !== "unavailable").length;
    const unavailable = rows.length - available;
    const metrics = feeMetrics(parseNumber(feeInput.value, 0));
    const ws = latestState.wsStatus || {};
    const wsLabel = `${ws.openConnectionCount || 0}/${ws.connectionCount || 0} open`;

    summaryCards.innerHTML = [
      metric("Markets", latestState.summary.marketsLoaded),
      metric("Triangles", latestState.summary.uniqueTriangles),
      metric("Cycles", latestState.summary.canonicalCycles),
      metric("Available", available),
      metric("Unavailable", unavailable),
      metric("Fee rate", String(metrics.feeRate)),
      metric("Upper break-even", formatMultiplier(metrics.upperBreakEven)),
      metric("Lower break-even", formatMultiplier(metrics.lowerBreakEven)),
      metric("WebSocket", wsLabel),
    ].join("");

    connectionLine.textContent = `Last update ${formatTime(latestState.summary.lastUpdateTime)} | Calculated ${formatTime(latestState.lastCalculatedAt)}`;
  }

  function renderGroupFilters() {
    const counts = latestState.groupCounts || {};
    groupFilters.innerHTML = Object.entries(GROUP_LABELS)
      .map(([group, label]) => {
        const checked = enabledGroups.has(group) ? "checked" : "";
        return `<label><input type="checkbox" data-group="${group}" ${checked}> ${label} (${counts[group] || 0})</label>`;
      })
      .join("");
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
    ];

    const feeIsZero = metrics.feeRate === 0;
    const feeLines = feeIsZero
      ? [metrics.upperBreakEven]
      : [metrics.upperBreakEven, metrics.lowerBreakEven];

    feeLines.forEach((value) => {
      shapes.push({
        type: "line",
        xref: "paper",
        x0: 0,
        x1: 1,
        yref: "y",
        y0: value,
        y1: value,
        line: { color: COLORS.orange, width: 2, dash: "dash" },
      });
    });

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
    ];

    if (metrics.feeRate === 0) {
      annotations.push({
        xref: "paper",
        x: 0.99,
        yref: "y",
        y: 1,
        text: "fee = 0",
        showarrow: false,
        xanchor: "right",
        yanchor: "top",
        font: { size: 12, color: COLORS.orange },
      });
    } else {
      annotations.push(
        {
          xref: "paper",
          x: 0.99,
          yref: "y",
          y: metrics.upperBreakEven,
          text: "canonical fee break-even",
          showarrow: false,
          xanchor: "right",
          yanchor: "bottom",
          font: { size: 12, color: COLORS.orange },
        },
        {
          xref: "paper",
          x: 0.99,
          yref: "y",
          y: metrics.lowerBreakEven,
          text: "implied reverse fee break-even",
          showarrow: false,
          xanchor: "right",
          yanchor: "top",
          font: { size: 12, color: COLORS.orange },
        },
      );
    }

    (latestState.groups || []).forEach((group) => {
      if (group.midX !== null) {
        annotations.push({
          xref: "x",
          x: group.midX,
          yref: "paper",
          y: 1.06,
          text: `${group.groupLabel} (${group.count})`,
          showarrow: false,
          font: { size: 12, color: "#394150" },
        });
      }
    });

    return annotations;
  }

  function renderChart() {
    if (!latestState) return;

    const metrics = feeMetrics(parseNumber(feeInput.value, 0));
    const decorated = decorateRows();
    updateSummary(decorated);

    chartRows = decorated.filter((row) => {
      if (!enabledGroups.has(row.group)) return false;
      if (!showUnavailableInput.checked && row.statusClass === "unavailable") return false;
      return true;
    });

    const yValues = chartRows
      .map((row) => row.y)
      .filter((value) => value !== null && Number.isFinite(value));
    const yExtents = [metrics.upperBreakEven, metrics.lowerBreakEven, 1, ...yValues];
    const yMin = Math.min(...yExtents);
    const yMax = Math.max(...yExtents);
    const yPad = Math.max((yMax - yMin) * 0.08, 0.000001);

    const trace = {
      type: "scattergl",
      mode: "markers",
      x: chartRows.map((row) => row.x),
      y: chartRows.map((row) => row.y),
      ids: chartRows.map((row) => row.cycleId),
      customdata: chartRows.map(buildCustomData),
      marker: {
        size: 8,
        color: chartRows.map(rowColor),
        opacity: 0.82,
        line: { width: 0 },
      },
      hovertemplate:
        "<b>%{customdata[1]}</b><br>" +
        "Assets: %{customdata[0]}<br>" +
        "Markets: %{customdata[2]}<br>" +
        "Group: %{customdata[3]}<br>" +
        "Gross: %{customdata[4]}<br>" +
        "Net: %{customdata[5]}<br>" +
        "Gross profit: %{customdata[6]}<br>" +
        "Net profit: %{customdata[7]}<br>" +
        "Implied reverse gross: %{customdata[8]}<br>" +
        "Implied reverse net: %{customdata[9]}<br>" +
        "Fee: %{customdata[10]}<br>" +
        "Upper break-even: %{customdata[11]}<br>" +
        "Lower break-even: %{customdata[12]}<br>" +
        "Status: %{customdata[13]}<br>" +
        "Last orderbook: %{customdata[15]}<br>" +
        "Calculated: %{customdata[16]}<extra></extra>",
    };

    const layout = {
      margin: { l: 68, r: 28, t: 58, b: 54 },
      paper_bgcolor: "#ffffff",
      plot_bgcolor: "#ffffff",
      dragmode: "zoom",
      uirevision: "q-gagarin-live",
      hovermode: "closest",
      xaxis: {
        title: "Canonical cycle index",
        type: "linear",
        zeroline: false,
        showgrid: false,
        range: [0, Math.max(...latestState.cycles.map((row) => row.x)) + 1],
      },
      yaxis: {
        title: "grossCanonicalMultiplier",
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

    Plotly.react(chart, [trace], layout, {
      responsive: true,
      scrollZoom: true,
      displaylogo: false,
      modeBarButtonsToAdd: ["pan2d", "zoom2d", "resetScale2d", "autoScale2d"],
    });
  }

  function detailRows(row) {
    const items = [
      ["Assets", row.assets.join(" / ")],
      ["Route", row.routeLabel],
      ["Markets", row.markets.join(", ")],
      ["Group", row.groupLabel],
      ["Gross", formatMultiplier(row.grossCanonicalMultiplier)],
      ["Net", formatMultiplier(row.netCanonicalMultiplier)],
      ["Gross profit", formatPercent(row.grossProfitRate)],
      ["Net profit", formatPercent(row.netProfitRate)],
      ["Implied reverse gross", formatMultiplier(row.impliedReverseGrossMultiplier)],
      ["Implied reverse net", formatMultiplier(row.impliedReverseNetMultiplier)],
      ["Fee rate", String(row.feeRate)],
      ["Upper break-even", formatMultiplier(row.upperBreakEven)],
      ["Lower break-even", formatMultiplier(row.lowerBreakEven)],
      ["Status", row.statusClass],
      ["Reason", row.unavailableReason || "n/a"],
      ["Last orderbook", formatTime(row.lastOrderbookTimestamp)],
      ["Calculated", formatTime(row.calculatedAt)],
    ];

    return items
      .map(([label, value]) => `<div class="detail-row"><strong>${label}</strong><span>${value}</span></div>`)
      .join("");
  }

  function setDetail(row) {
    detailBody.innerHTML = detailRows(row);
  }

  function bindPlotlyEvents() {
    chart.on("plotly_hover", (event) => {
      if (pinned || !event.points || !event.points[0]) return;
      setDetail(chartRows[event.points[0].pointIndex]);
    });

    chart.on("plotly_click", (event) => {
      if (!event.points || !event.points[0]) return;
      pinned = true;
      setDetail(chartRows[event.points[0].pointIndex]);
    });
  }

  function applyState(state) {
    latestState = state;
    if (!feeInput.dataset.initialized) {
      feeInput.value = String(state.summary.feeRate || 0);
      staleInput.value = String(state.summary.staleOrderbookMs || 5000);
      feeInput.dataset.initialized = "true";
      renderGroupFilters();
    }
    renderChart();
  }

  function connectEvents() {
    const events = new EventSource("/api/events");

    events.addEventListener("state", (event) => {
      latestState = JSON.parse(event.data);

      if (!paused) {
        renderChart();
      } else {
        connectionLine.textContent = `Paused | latest server update ${formatTime(latestState.summary.lastUpdateTime)}`;
      }
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

  async function capture() {
    if (!latestState) return;
    const now = new Date();
    const stamp = formatLocalTimestamp(now);
    const snapshot = {
      ...latestState,
      clientFeeRate: parseNumber(feeInput.value, 0),
      clientStaleThresholdMs: parseNumber(staleInput.value, 5000),
      renderedCycles: chartRows,
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
      pngLink.download = `upbit-canonical-cycles-${stamp}.png`;
      pngLink.click();

      const jsonLink = document.createElement("a");
      jsonLink.href = URL.createObjectURL(
        new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" }),
      );
      jsonLink.download = `upbit-canonical-cycles-${stamp}.json`;
      jsonLink.click();
    }
  }

  function bindControls() {
    feeInput.addEventListener("input", renderChart);
    staleInput.addEventListener("input", renderChart);
    autoScaleInput.addEventListener("change", renderChart);
    showUnavailableInput.addEventListener("change", renderChart);
    pauseButton.addEventListener("click", () => {
      paused = !paused;
      pauseButton.textContent = paused ? "Resume" : "Pause";

      if (!paused && latestState) {
        renderChart();
      }
    });
    captureButton.addEventListener("click", capture);
    unpinButton.addEventListener("click", () => {
      pinned = false;
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

  async function init() {
    bindControls();
    const response = await fetch("/api/state");
    const state = await response.json();
    applyState(state);
    bindPlotlyEvents();
    connectEvents();
  }

  init().catch((error) => {
    showToast(error.message);
    connectionLine.textContent = error.message;
  });
})();
