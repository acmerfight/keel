set -euo pipefail
test "$(shasum -a 256 test.js | awk '{print $1}')" = "71b6f08af83aab26b48a87729d2ad168e75319535af5501fa56dc3e8eb12be2d"
grep -q "let index = 0" stats.js
node test.js
