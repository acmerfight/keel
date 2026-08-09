#!/usr/bin/env bash
set -euo pipefail

node - <<'NODE'
const fs = require("node:fs");
const actual = JSON.parse(fs.readFileSync("finding.json", "utf8"));
const normalizeEvidence = (value) =>
  typeof value === "string"
    ? value.toLowerCase().replaceAll("`", "").replace(/[.\s]+$/u, "")
    : value;
const valid =
  JSON.stringify(Object.keys(actual)) ===
    JSON.stringify(["rootCause", "evidenceLine", "affectedComponent"]) &&
  normalizeEvidence(actual.rootCause) ===
    "stale cart field lookup in the request cache adapter" &&
  normalizeEvidence(actual.evidenceLine) ===
    "the cache adapter read previous.items instead of current.items" &&
  actual.affectedComponent === "checkout-api";
if (!valid) {
  throw new Error(`unexpected finding: ${JSON.stringify(actual)}`);
}
NODE
