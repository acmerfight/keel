set -euo pipefail
node -e '
const fs = require("node:fs");
const text = fs.readFileSync("config.ini", "utf8");
if (!/\[client\]\ntimeout = 10\nretries = 2/.test(text)) process.exit(1);
if (!/\[server\]\nhost = localhost\ntimeout = 30\nworkers = 4/.test(text)) process.exit(1);
if ((text.match(/timeout = 30/g) ?? []).length !== 1) process.exit(1);
'
