# Checkout incident INC-204

1. At 09:14 UTC, checkout-api deployment 8f19 started serving traffic.
2. At 09:16 UTC, payment authorization latency remained normal.
3. At 09:17 UTC, checkout-api logs first showed `cart_total=null`.
4. At 09:18 UTC, error rate crossed the alert threshold.
5. The deployment changed `cart.total` to `cart.amount`, but checkout-api still read `cart.total`.
6. Rolling back deployment 8f19 restored successful checkouts.

The confirmed root cause is a stale cart field lookup in checkout-api. Line 5
is the direct evidence; other observations establish timing but not another
root cause.
