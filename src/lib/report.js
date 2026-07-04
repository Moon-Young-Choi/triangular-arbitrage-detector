const fs = require("node:fs/promises");
const path = require("node:path");

function formatNumber(value) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "";
  }

  return Number(value).toPrecision(12);
}

function csvEscape(value) {
  if (value === null || value === undefined) {
    return "";
  }

  const text = String(value);

  if (/[",\n]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }

  return text;
}

function buildMultiplierCsv(rows) {
  const headers = [
    "index",
    "route",
    "markets",
    "available",
    "grossMultiplier",
    "netMultiplier",
    "profitRate",
    "impliedReverseMultiplier",
    "unavailableReason",
  ];

  const lines = [headers.join(",")];

  rows.forEach((row, index) => {
    lines.push(
      [
        index + 1,
        row.routeLabel,
        row.markets.join(" | "),
        row.available,
        formatNumber(row.grossMultiplier),
        formatNumber(row.netMultiplier),
        formatNumber(row.profitRate),
        formatNumber(row.impliedReverseMultiplier),
        row.unavailableReason || "",
      ].map(csvEscape).join(","),
    );
  });

  return `${lines.join("\n")}\n`;
}

function buildHtmlReport(rows, metadata) {
  const dataJson = JSON.stringify(rows);
  const metadataJson = JSON.stringify(metadata);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Upbit Canonical Cycle Multipliers</title>
  <style>
    body {
      margin: 0;
      font-family: Arial, sans-serif;
      color: #15191f;
      background: #f6f7f9;
    }
    main {
      padding: 24px;
    }
    h1 {
      margin: 0 0 8px;
      font-size: 24px;
      font-weight: 700;
    }
    .summary {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      margin: 16px 0 24px;
    }
    .metric {
      min-width: 180px;
      padding: 12px 14px;
      border: 1px solid #d9dde4;
      border-radius: 6px;
      background: #fff;
    }
    .metric strong {
      display: block;
      font-size: 12px;
      color: #5b6472;
      text-transform: uppercase;
    }
    .metric span {
      display: block;
      margin-top: 4px;
      font-size: 20px;
      font-weight: 700;
    }
    .chart-wrap {
      overflow-x: auto;
      border: 1px solid #d9dde4;
      border-radius: 6px;
      background: #fff;
    }
    svg {
      display: block;
      min-width: 1200px;
    }
    .axis {
      stroke: #515866;
      stroke-width: 1;
    }
    .grid {
      stroke: #e3e7ed;
      stroke-width: 1;
    }
    .ref {
      stroke: #d13f31;
      stroke-width: 1.5;
      stroke-dasharray: 6 5;
    }
    .point {
      fill: #1663b7;
      opacity: 0.78;
    }
    .point.loss {
      fill: #7a8798;
    }
    .point.unavailable {
      fill: #c2c8d0;
      opacity: 0.55;
    }
    text {
      fill: #333b47;
      font-size: 12px;
    }
    .note {
      margin-top: 12px;
      color: #5b6472;
      font-size: 13px;
    }
  </style>
</head>
<body>
  <main>
    <h1>Upbit Canonical Cycle Multipliers</h1>
    <div id="summary" class="summary"></div>
    <div class="chart-wrap">
      <svg id="chart" width="1400" height="720" role="img" aria-label="Multiplier scatter plot"></svg>
    </div>
    <p class="note">Each point is one canonical cycle. Reverse cycles are not plotted by default. The red dashed line is multiplier = 1.</p>
  </main>
  <script>
    const rows = ${dataJson};
    const metadata = ${metadataJson};
    const summary = document.querySelector("#summary");
    const chart = document.querySelector("#chart");

    const metrics = [
      ["Markets", metadata.totalMarketsLoaded],
      ["Unique triangles", metadata.uniqueTriangleCount],
      ["Canonical cycles", metadata.canonicalCycleCount],
      ["Available multipliers", rows.filter((row) => row.available).length],
      ["Net fee rate", metadata.netFeeRateLabel],
    ];

    summary.innerHTML = metrics.map(([label, value]) => '<div class="metric"><strong>' + label + '</strong><span>' + value + '</span></div>').join("");

    const width = Number(chart.getAttribute("width"));
    const height = Number(chart.getAttribute("height"));
    const margin = { top: 28, right: 32, bottom: 56, left: 76 };
    const innerWidth = width - margin.left - margin.right;
    const innerHeight = height - margin.top - margin.bottom;
    const availableValues = rows.filter((row) => row.available).map((row) => row.netMultiplier);
    const rawMin = Math.min(1, ...availableValues);
    const rawMax = Math.max(1, ...availableValues);
    const pad = Math.max((rawMax - rawMin) * 0.08, 0.000001);
    const minY = rawMin - pad;
    const maxY = rawMax + pad;
    const xScale = (index) => margin.left + (rows.length <= 1 ? innerWidth / 2 : (index / (rows.length - 1)) * innerWidth);
    const yScale = (value) => margin.top + ((maxY - value) / (maxY - minY)) * innerHeight;
    const svgNs = "http://www.w3.org/2000/svg";

    function el(name, attrs = {}, text = "") {
      const node = document.createElementNS(svgNs, name);
      Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, value));
      if (text) node.textContent = text;
      return node;
    }

    chart.appendChild(el("line", { class: "axis", x1: margin.left, y1: margin.top, x2: margin.left, y2: height - margin.bottom }));
    chart.appendChild(el("line", { class: "axis", x1: margin.left, y1: height - margin.bottom, x2: width - margin.right, y2: height - margin.bottom }));

    const ticks = 6;
    for (let i = 0; i <= ticks; i += 1) {
      const value = minY + ((maxY - minY) * i) / ticks;
      const y = yScale(value);
      chart.appendChild(el("line", { class: "grid", x1: margin.left, y1: y, x2: width - margin.right, y2: y }));
      chart.appendChild(el("text", { x: margin.left - 10, y: y + 4, "text-anchor": "end" }, value.toFixed(6)));
    }

    const refY = yScale(1);
    chart.appendChild(el("line", { class: "ref", x1: margin.left, y1: refY, x2: width - margin.right, y2: refY }));
    chart.appendChild(el("text", { x: width - margin.right, y: refY - 8, "text-anchor": "end" }, "y = 1"));
    chart.appendChild(el("text", { x: margin.left + innerWidth / 2, y: height - 16, "text-anchor": "middle" }, "Canonical cycle index"));
    chart.appendChild(el("text", { x: 18, y: margin.top + innerHeight / 2, transform: "rotate(-90 18 " + (margin.top + innerHeight / 2) + ")", "text-anchor": "middle" }, "Multiplier"));

    rows.forEach((row, index) => {
      const yValue = row.available ? row.netMultiplier : 1;
      const point = el("circle", {
        class: "point " + (!row.available ? "unavailable" : row.netMultiplier < 1 ? "loss" : ""),
        cx: xScale(index),
        cy: yScale(yValue),
        r: rows.length > 700 ? 2.2 : 3.4,
      });
      const title = [
        row.routeLabel,
        "markets: " + row.markets.join(", "),
        "grossMultiplier: " + row.grossMultiplier,
        "netMultiplier: " + row.netMultiplier,
        "profitRate: " + row.profitRate,
        "impliedReverseMultiplier: " + row.impliedReverseMultiplier,
        row.unavailableReason ? "unavailable: " + row.unavailableReason : "",
      ].filter(Boolean).join("\\n");
      point.appendChild(el("title", {}, title));
      chart.appendChild(point);
    });
  </script>
</body>
</html>
`;
}

async function writeReports(outDir, payload) {
  await fs.mkdir(outDir, { recursive: true });

  const trianglesPath = path.join(outDir, "upbit-triangles.json");
  const cyclesPath = path.join(outDir, "upbit-canonical-cycles.json");
  const csvPath = path.join(outDir, "upbit-canonical-cycle-multipliers.csv");
  const htmlPath = path.join(outDir, "upbit-canonical-cycle-multipliers.html");

  await fs.writeFile(trianglesPath, `${JSON.stringify(payload.trianglesJson, null, 2)}\n`);
  await fs.writeFile(cyclesPath, `${JSON.stringify(payload.cyclesJson, null, 2)}\n`);
  await fs.writeFile(csvPath, buildMultiplierCsv(payload.multiplierRows));
  await fs.writeFile(htmlPath, buildHtmlReport(payload.multiplierRows, payload.metadata));

  return {
    trianglesPath,
    cyclesPath,
    csvPath,
    htmlPath,
  };
}

module.exports = {
  buildMultiplierCsv,
  buildHtmlReport,
  writeReports,
};
