set -euo pipefail
node -e '
const fs = require("node:fs");
const validators = fs.readFileSync("validators.js", "utf8");
fs.writeFileSync(
  "validators.js",
  validators.replace(
    "\nmodule.exports = { isEmail, isUuid };\n",
    "\nfunction isSlug(value) {\n  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);\n}\n\nmodule.exports = { isEmail, isUuid, isSlug };\n",
  ),
);
const tests = fs.readFileSync("test.js", "utf8");
fs.writeFileSync(
  "test.js",
  tests
    .replace("const { isEmail, isUuid } = require(\"./validators\");", "const { isEmail, isUuid, isSlug } = require(\"./validators\");")
    .replace(
      "assert.strictEqual(isUuid(\"not-a-uuid\"), false);",
      "assert.strictEqual(isUuid(\"not-a-uuid\"), false);\nassert.strictEqual(isSlug(\"docs-v2\"), true);\nassert.strictEqual(isSlug(\"Docs\"), false);\nassert.strictEqual(isSlug(\"docs--v2\"), false);\nassert.strictEqual(isSlug(\"docs_2\"), false);",
    ),
);
'
