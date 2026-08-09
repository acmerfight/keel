#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' '{"api":{"edgeMaxAttempts":4,"applicationMaxAttempts":4,"sharedRetryBudget":false,"idempotencyKey":false,"incidentRequestAttempts":16},"worker":{"acknowledgement":"before_completion_marker","redeliveryOnExit":true,"idempotencyRecord":false,"commitBeforeAck":false,"incidentDeliveries":2},"crossService":{"missingCorrelationField":"request_id"}}' > review.json
