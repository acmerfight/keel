#!/usr/bin/env bash
set -euo pipefail

bash setup.sh
git merge -q redesign
