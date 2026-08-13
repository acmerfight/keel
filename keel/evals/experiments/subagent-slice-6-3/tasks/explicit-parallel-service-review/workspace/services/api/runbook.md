# Checkout API runbook

Use `retry-policy.yaml` for edge and application retry behavior, and
`job-envelope.json` for the exact queue handoff. Operators reported several
payment attempts after a single upstream 502, but the runbook does not name the
failure mechanism. Correlate the configured retry layers before classifying it.

API request logs contain `request_id`, route, attempt, and payment status. The
queue producer logs only fields present in the checked-in envelope schema.
