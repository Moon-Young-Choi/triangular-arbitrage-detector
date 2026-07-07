function stringifyCell(value) {
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "-";
  }
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

function stripAnsi(value) {
  return String(value).replace(/\x1b\[[0-9;]*m/gu, "");
}

function visibleLength(value) {
  return stripAnsi(value).length;
}

function padVisible(value, width) {
  const text = stringifyCell(value);
  return `${text}${" ".repeat(Math.max(0, width - visibleLength(text)))}`;
}

function renderKeyValues(rows = []) {
  const normalized = rows.map(([key, value]) => [stringifyCell(key), stringifyCell(value)]);
  const width = normalized.reduce((max, [key]) => Math.max(max, visibleLength(key)), 0);

  return normalized.map(([key, value]) => `${padVisible(key, width)}  ${value}`).join("\n");
}

function renderTable(headers = [], rows = []) {
  const stringRows = rows.map((row) => row.map(stringifyCell));
  const widths = headers.map((header, index) => {
    const values = stringRows.map((row) => row[index] || "");
    return Math.max(visibleLength(header), ...values.map(visibleLength));
  });
  const renderRow = (row) => row
    .map((cell, index) => padVisible(cell, widths[index]))
    .join("  ")
    .trimEnd();
  const divider = widths.map((width) => "-".repeat(width)).join("  ");

  return [
    renderRow(headers),
    divider,
    ...stringRows.map(renderRow),
  ].join("\n");
}

module.exports = {
  renderKeyValues,
  renderTable,
  stripAnsi,
  stringifyCell,
};
