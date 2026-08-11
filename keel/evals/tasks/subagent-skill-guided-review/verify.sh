#!/usr/bin/env bash
set -euo pipefail

diff -u <(printf '%s\n' 'release_gate=canary-17') result.txt
