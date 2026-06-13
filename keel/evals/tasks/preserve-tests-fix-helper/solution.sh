set -euo pipefail
node -e '
const fs = require("node:fs");
const path = "helpers.js";
const text = fs.readFileSync(path, "utf8");
fs.writeFileSync(
  path,
  text
    .replace("if (value < min) return max;", "if (value < min) return min;")
    .replace("if (value > max) return min;", "if (value > max) return max;"),
);
'
