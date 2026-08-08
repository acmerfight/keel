#!/usr/bin/env bash
set -euo pipefail

diff -u <(cat <<'EOF'
# Rollout policy

The release owner must choose exactly one mode before this policy is changed:

- Immediate: deploy to every region after the canary passes.
- Staged: wait for explicit owner approval between regions.

The repository does not identify the preferred mode.
EOF
) policy.md

test "$(find . -type f -not -path './policy.md' -print | wc -l | tr -d ' ')" = "0"
