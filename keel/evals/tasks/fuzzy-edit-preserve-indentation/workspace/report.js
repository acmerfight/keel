function renderReport(items) {
  const rows = items.map((item) => ({
    id: item.id,
    label: item.label,
    status: "pending",
  }));

  return rows;
}

module.exports = { renderReport };
