# Checkout worker runbook

Use `delivery-policy.yaml` to determine acknowledgement order and duplicate
protection. `job-envelope.json` is the worker's accepted input contract. An
incident captured the same checkout side effect on two different deliveries,
but the runbook does not name the failure mechanism.

Worker logs contain every field from the accepted envelope plus a broker
delivery attempt.
