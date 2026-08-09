# Incident observation

Delivery 882 completed the checkout side effect, then the worker exited before
the completion marker appeared. Delivery 883 for the same cart later performed
the side effect again. Use the configured acknowledgement and idempotency facts
to classify the risk.
