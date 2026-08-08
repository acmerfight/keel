#!/usr/bin/env bash
set -euo pipefail

node - <<'NODE'
const fs = require("node:fs");
const actual = JSON.parse(fs.readFileSync("release-audit.json", "utf8"));
const expectedPackages = {
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
};
const gap =
  typeof actual.sharedReleaseGap === "string"
    ? actual.sharedReleaseGap.toLowerCase().replaceAll("_", " ")
    : "";
const topLevelShape =
  Object.keys(actual).length === 3 &&
  Object.hasOwn(actual, "payments") &&
  Object.hasOwn(actual, "identity") &&
  Object.hasOwn(actual, "sharedReleaseGap");
const sharedRollbackOwnerGap =
  gap.includes("rollback") &&
  gap.includes("owner") &&
  /(unassigned|not assigned|no .{0,24}assigned|missing)/u.test(gap) &&
  /(both|neither|either|two)/u.test(gap);
const packagesMatch =
  JSON.stringify({ payments: actual.payments, identity: actual.identity }) ===
  JSON.stringify(expectedPackages);
if (!topLevelShape || !packagesMatch || !sharedRollbackOwnerGap) {
  throw new Error(`unexpected release facts: ${JSON.stringify(actual)}`);
}
NODE
