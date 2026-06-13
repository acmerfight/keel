set -euo pipefail
test "$(node scripts/greet.js)" = "hello, keel"
