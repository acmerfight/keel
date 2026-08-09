#!/usr/bin/env bash
set -euo pipefail

node - <<'NODE'
const fs = require("node:fs");
const path = "README.md";
fs.writeFileSync(path, fs.readFileSync(path, "utf8").replace("8081", "8080"));
NODE
