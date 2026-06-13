set -euo pipefail
expected="$(mktemp)"
cat > "$expected" <<'EOF'
# Sample Project

## Setup

Install the dependencies before running the app.

## Usage

Run `node index.js` to start.
EOF
cmp README.md "$expected"
