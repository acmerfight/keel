#!/usr/bin/env bash
set -euo pipefail
printf 'pnpm test:coverage\n' | cmp -s - release-command.txt
