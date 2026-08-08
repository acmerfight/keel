#!/usr/bin/env bash
set -euo pipefail

node - <<'NODE'
const fs = require("node:fs");
const actual = JSON.parse(fs.readFileSync("release-audit.json", "utf8"));
const expected = {
  payments: {
    priorAmountUnit: "integer_cents",
    nextAmountFormat: "decimal_currency_string",
    callersCompatible: false,
    incompatibleCallerCount: 11,
    rollbackOwner: null,
  },
  identity: {
    positiveClockSkewSeconds: 300,
    replayWindowExtended: true,
    extendedWindowSamples: 7,
    rollbackOwner: null,
  },
  sharedReleaseGap: "rollback_owner",
};
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  throw new Error(`unexpected release facts: ${JSON.stringify(actual)}`);
}
NODE
