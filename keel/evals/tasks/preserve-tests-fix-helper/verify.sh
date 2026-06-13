set -euo pipefail
node -e '
const crypto = require("node:crypto");
const fs = require("node:fs");
const actual = crypto.createHash("sha256").update(fs.readFileSync("test.js")).digest("hex");
if (actual !== "e03c4c15300164d703904422bbd8e9bfd166bba09853ff84788e82264fca21d3") process.exit(1);
'
node test.js
