# Checkout incident

Component: checkout-api
Symptom: cart totals intermittently used a previous request's item count.
Root cause: stale cart field lookup in the request cache adapter.
Evidence: the cache adapter read `previous.items` instead of `current.items`.
Resolution: use the current request field and invalidate the stale cache entry.
