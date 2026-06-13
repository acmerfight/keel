set -euo pipefail
grep -q "^timeout_seconds = 30$" settings.ini
! grep -q "^timeout_seconds = 10$" settings.ini
test "$(grep -c "^option_" settings.ini)" = "300"
test "$(shasum -a 256 settings.ini | awk '{print $1}')" = "9128e2d0d4c47d2b40c2ec005d60210df03b53ba3184e866c14a5d64d878cd6a"
