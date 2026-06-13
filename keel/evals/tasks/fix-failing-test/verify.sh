set -euo pipefail
test "$(shasum -a 256 test.js | awk '{print $1}')" = "71b6f08af83aab26b48a87729d2ad168e75319535af5501fa56dc3e8eb12be2d"
node test.js
node -e '
const assert = require("node:assert");
const { mean } = require("./stats");
assert.strictEqual(mean([1, 2, 3, 4]), 2.5);
assert.strictEqual(mean([-2, 2]), 0);
assert.throws(() => mean([]), /empty/);
'
