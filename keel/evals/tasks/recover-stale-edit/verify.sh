set -euo pipefail
node -e '
const { statusLabel, statusCode } = require("./status");
if (statusLabel() !== "Ready") process.exit(1);
if (statusCode() !== 202) process.exit(1);
'
