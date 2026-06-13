set -euo pipefail
node -e '
const fs = require("node:fs");
for (const path of ["lib/cart.js", "lib/checkout.js"]) {
  const text = fs.readFileSync(path, "utf8");
  fs.writeFileSync(path, text.replaceAll("calcTotal", "calculateTotal"));
}
'
