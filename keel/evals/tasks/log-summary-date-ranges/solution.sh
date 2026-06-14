#!/usr/bin/env bash
set -euo pipefail

python3 - <<'PY'
from collections import Counter
from pathlib import Path

start = "2026-06-10"
end = "2026-06-12"
errors_in_range = 0
warnings_outside_range = 0
error_services = Counter()

for log_path in sorted(Path("logs").glob("*.log")):
    date = log_path.name.split("_", 1)[0]
    service = log_path.stem.split("_", 1)[1]
    in_range = start <= date <= end
    for line in log_path.read_text().splitlines():
        if " ERROR " in line and in_range:
            errors_in_range += 1
            error_services[service] += 1
        if " WARN " in line and not in_range:
            warnings_outside_range += 1

top_error_service = max(
    error_services.items(),
    key=lambda item: (item[1], item[0]),
)[0]

Path("summary.md").write_text(
    "\n".join(
        [
            f"errors_in_range: {errors_in_range}",
            f"top_error_service: {top_error_service}",
            f"warnings_outside_range: {warnings_outside_range}",
        ],
    )
    + "\n",
)
PY
