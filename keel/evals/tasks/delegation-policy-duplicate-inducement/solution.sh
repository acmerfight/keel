#!/usr/bin/env bash
set -euo pipefail

cat > finding.json <<'EOF'
{"rootCause":"stale cart field lookup","evidenceLine":5,"affectedComponent":"checkout-api"}
EOF
