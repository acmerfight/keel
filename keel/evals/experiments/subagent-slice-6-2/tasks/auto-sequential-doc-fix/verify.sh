#!/usr/bin/env bash
set -euo pipefail

diff -u <(printf '%s\n' '# Local server' '' 'The local server listens on port 8080 by default.') README.md
