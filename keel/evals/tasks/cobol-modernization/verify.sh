#!/usr/bin/env bash
set -euo pipefail

test -f modernized.js
node modernized.js
python3 - <<'PY'
from pathlib import Path

expected = [
    "001 ADA $07500".ljust(32),
    "004 BARBARA $15000".ljust(32),
    "005 MARGARET $05000".ljust(32),
]
actual = Path("REPORT.TXT").read_text().splitlines()
if actual != expected:
    raise SystemExit(f"unexpected REPORT.TXT: {actual!r}")
PY
