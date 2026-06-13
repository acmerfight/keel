set -euo pipefail
node -e '
const fs = require("node:fs");
const path = "status.js";
const text = fs.readFileSync(path, "utf8");
fs.writeFileSync(path, text.replace("\"Queued\"", "\"Ready\""));
'
