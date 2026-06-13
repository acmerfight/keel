set -euo pipefail
node -e '
const { retryDelays } = require("./src/client");
if (retryDelays().length !== 5) process.exit(1);
'
