set -euo pipefail
test "$(node index.js)" = "total: 30"
! grep -r "calcTotal" --include="*.js" .
grep -q "calculateTotal" lib/cart.js
grep -q "calculateTotal" lib/checkout.js
