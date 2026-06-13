set -euo pipefail
node -e '
const fs = require("node:fs");
const text = fs.readFileSync("stats.js", "utf8");
fs.writeFileSync("stats.js", text.replace("let index = 1", "let index = 0"));
'
