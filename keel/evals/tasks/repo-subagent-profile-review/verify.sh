#!/usr/bin/env bash
set -euo pipefail

diff -u <(cat <<'EOF'
guest_delete: denied
staff_delete: allowed
EOF
) review.txt
