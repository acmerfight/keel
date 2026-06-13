set -euo pipefail
node -e '
const fs = require("node:fs");
const path = "config.ini";
const text = fs.readFileSync(path, "utf8");
fs.writeFileSync(path, text.replace("[server]\nhost = localhost\ntimeout = 10", "[server]\nhost = localhost\ntimeout = 30"));
'
