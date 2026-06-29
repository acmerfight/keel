set -euo pipefail
node -e '
const fs = require("node:fs");
const expected = `function renderReport(items) {
  const rows = items.map((item) => ({
    id: item.id,
    label: item.label,
    status: "ready",
  }));

  return rows;
}

module.exports = { renderReport };
`;
const actual = fs.readFileSync("report.js", "utf8");
if (!actual.includes(`status: "ready"`)) process.exit(1);
if (actual.includes(`status: "pending"`)) process.exit(1);
if (actual !== expected) {
  console.error("report.js did not preserve the expected source formatting");
  process.exit(1);
}
'
