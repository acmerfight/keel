# Deployment notes

The API deploys independently from the worker. A canary monitors request error
rate and payment status. Rollback does not change the queue envelope version,
and the deployment has no direct control over broker delivery or worker
idempotency.
