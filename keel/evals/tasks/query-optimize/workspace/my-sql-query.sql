SELECT
  u.id,
  u.name,
  (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) AS order_count,
  (SELECT COALESCE(SUM(o.total), 0) FROM orders o WHERE o.user_id = u.id) AS total_spend
FROM users u
WHERE u.active = 1
ORDER BY u.id;
