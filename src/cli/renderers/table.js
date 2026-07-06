function stringifyCell(value) {
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "-";
  }
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

function renderKeyValues(rows = []) {
  const normalized = rows.map(([key, value]) => [stringifyCell(key), stringifyCell(value)]);
  const width = normalized.reduce((max, [key]) => Math.max(max, key.length), 0);

  return normalized.map(([key, value]) => `${key.padEnd(width)}  ${value}`).join("\n");
}

function renderTable(headers = [], rows = []) {
  const stringRows = rows.map((row) => row.map(stringifyCell));
  const widths = headers.map((header, index) => {
    const values = stringRows.map((row) => row[index] || "");
    return Math.max(String(header).length, ...values.map((value) => value.length));
  });
  const renderRow = (row) => row
    .map((cell, index) => stringifyCell(cell).padEnd(widths[index]))
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
  stringifyCell,
};
