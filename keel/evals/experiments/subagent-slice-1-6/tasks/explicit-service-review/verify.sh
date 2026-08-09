#!/usr/bin/env bash
set -euo pipefail

node - <<'NODE'
const fs = require("node:fs");
const actual = JSON.parse(fs.readFileSync("review.json", "utf8"));
const expected = {
  api: {
    edgeMaxAttempts: 4,
    applicationMaxAttempts: 4,
    sharedRetryBudget: false,
    idempotencyKey: false,
    incidentRequestAttempts: 16,
  },
  worker: {
    acknowledgement: "before_completion_marker",
    redeliveryOnExit: true,
    idempotencyRecord: false,
    commitBeforeAck: false,
    incidentDeliveries: 2,
  },
  crossService: { missingCorrelationField: "request_id" },
};
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  throw new Error(`unexpected review facts: ${JSON.stringify(actual)}`);
}
NODE
