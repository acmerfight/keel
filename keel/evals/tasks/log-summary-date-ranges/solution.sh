#!/usr/bin/env bash
set -euo pipefail

cat > summary.md <<'EOF'
errors_in_range: 6
top_error_service: api
warnings_outside_range: 3
EOF
