#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' '{"rootCause":"stale cart field lookup","evidenceLine":6,"affectedComponent":"checkout-api"}' > finding.json
