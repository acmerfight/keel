set -euo pipefail
node -e '
const fs = require("node:fs");
const path = "src/config.js";
const text = fs.readFileSync(path, "utf8");
fs.writeFileSync(path, text.replace("MAX_RETRIES = 3", "MAX_RETRIES = 5"));
'
