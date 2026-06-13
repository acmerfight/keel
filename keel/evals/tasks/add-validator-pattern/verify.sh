set -euo pipefail
node test.js
grep -q "isSlug" test.js
node -e '
const { isSlug } = require("./validators");
if (typeof isSlug !== "function") process.exit(1);
if (!isSlug("docs-v2")) process.exit(1);
if (isSlug("Docs")) process.exit(1);
if (isSlug("docs--v2")) process.exit(1);
if (isSlug("docs_2")) process.exit(1);
if (isSlug("-docs")) process.exit(1);
'
