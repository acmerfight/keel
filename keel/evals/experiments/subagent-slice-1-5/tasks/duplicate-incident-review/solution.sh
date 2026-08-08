#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' '{"rootCause":"stale cart field lookup in the request cache adapter.","evidenceLine":"the cache adapter read `previous.items` instead of `current.items`.","affectedComponent":"checkout-api"}' > finding.json
