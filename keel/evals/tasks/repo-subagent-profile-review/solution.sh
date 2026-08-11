#!/usr/bin/env bash
set -euo pipefail

cat > review.txt <<'EOF'
guest_delete: denied
staff_delete: allowed
EOF
