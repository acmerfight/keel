set -euo pipefail
test "$(shasum -a 256 src/client.js | awk '{print $1}')" = "2806059034e323c69d902424d9118607ad123b8fb6ee58d3b5dba310e3b39484"
grep -q "^const MAX_RETRIES = 5;$" src/config.js
! grep -q "^const MAX_RETRIES = 3;$" src/config.js
node -e '
const { retryDelays } = require("./src/client");
if (retryDelays().length !== 5) process.exit(1);
if (retryDelays().join(",") !== "250,500,1000,2000,4000") process.exit(1);
'
