#!/usr/bin/env bash
set -euo pipefail

diff -u <(cat <<'EOF'
api_risk: retry amplification
worker_risk: duplicate execution
cross_service_gap: request_id missing from job envelope
EOF
) review.md
