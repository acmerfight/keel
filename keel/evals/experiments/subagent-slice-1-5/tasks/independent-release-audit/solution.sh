#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' '{"payments":{"priorAmountUnit":"integer_cents","nextAmountFormat":"decimal_currency_string","callersCompatible":false,"incompatibleCallerCount":11,"rollbackOwner":null},"identity":{"positiveClockSkewSeconds":300,"replayWindowExtended":true,"extendedWindowSamples":7,"rollbackOwner":null},"sharedReleaseGap":"rollback owner unassigned in both releases"}' > release-audit.json
