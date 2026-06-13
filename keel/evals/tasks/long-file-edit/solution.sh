set -euo pipefail
node -e '
const fs = require("node:fs");
const text = fs.readFileSync("settings.ini", "utf8");
fs.writeFileSync(
  "settings.ini",
  text.replace("timeout_seconds = 10", "timeout_seconds = 30"),
);
'
