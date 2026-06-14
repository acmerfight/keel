#!/usr/bin/env bash
set -euo pipefail

test -d .git
test "$(git branch --show-current)" = "main"
grep -qx "welcome: hello from the original site" site.txt
grep -qx "nav: refreshed navigation" site.txt
git merge-base --is-ancestor redesign main
