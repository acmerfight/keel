#!/usr/bin/env bash
set -euo pipefail

diff -u <(cat <<'EOF'
errors_in_range: 6
top_error_service: api
warnings_outside_range: 3
EOF
) summary.md
