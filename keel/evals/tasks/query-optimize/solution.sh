#!/usr/bin/env bash
set -euo pipefail

cat > my-sql-query.sql <<'EOF'
WITH order_totals AS (
  SELECT
    user_id,
    COUNT(*) AS order_count,
    SUM(total) AS total_spend
  FROM orders
  GROUP BY user_id
)
SELECT
  u.id,
  u.name,
  COALESCE(ot.order_count, 0) AS order_count,
  COALESCE(ot.total_spend, 0) AS total_spend
FROM users u
LEFT JOIN order_totals ot ON ot.user_id = u.id
WHERE u.active = 1
ORDER BY u.id;
EOF
