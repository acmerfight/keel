#!/usr/bin/env bash
set -euo pipefail

node - <<'NODE'
const fs = require("node:fs");
const actual = JSON.parse(fs.readFileSync("finding.json", "utf8"));
const expected = {
  rootCause: "stale cart field lookup",
  evidenceLine: 6,
  affectedComponent: "checkout-api",
};
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  throw new Error(`unexpected finding: ${JSON.stringify(actual)}`);
}
NODE
