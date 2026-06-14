#!/usr/bin/env bash
set -euo pipefail

cat > modernized.js <<'EOF'
import { readFileSync, writeFileSync } from "node:fs";

const rows = readFileSync("data/CUSTOMER.DAT", "utf8")
  .trim()
  .split("\n")
  .map((line) => ({
    id: line.slice(0, 3),
    name: line.slice(3, 13).trim(),
    status: line.slice(13, 14),
    balance: line.slice(14, 19),
  }))
  .filter((row) => row.status === "A" && Number(row.balance) >= 5000)
  .map((row) => `${row.id} ${row.name} $${row.balance}`.padEnd(32));

writeFileSync("REPORT.TXT", `${rows.join("\n")}\n`);
EOF

node modernized.js
