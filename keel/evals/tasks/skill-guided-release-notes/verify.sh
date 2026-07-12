#!/bin/sh
set -eu

node <<'NODE'
const fs = require("node:fs");
const expected = [
  "## Breaking changes",
  "",
  "- Require scoped provider names (#19)",
  "",
  "## Features",
  "",
  "- Add project profiles (#7)",
  "- Show model cost source (#11)",
  "",
  "## Fixes",
  "",
  "- Preserve queued input (#41)",
  "",
].join("\n");
const actual = fs.readFileSync("RELEASE_NOTES.md", "utf8");
if (actual !== expected) {
  console.error("RELEASE_NOTES.md did not match the requested grouped output");
  process.exit(1);
}
const changes = JSON.parse(fs.readFileSync("changes.json", "utf8"));
if (changes.length !== 5 || changes[3]?.title !== "Refactor retry helper") {
  console.error("changes.json was modified");
  process.exit(1);
}
NODE
