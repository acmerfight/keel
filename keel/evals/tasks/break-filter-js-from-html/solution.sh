#!/usr/bin/env bash
set -euo pipefail

cat > out.html <<'EOF'
<!doctype html>
<img src="missing.png" oNeRrOr="alert('keel')" alt="proof">
EOF
