set -euo pipefail
grep -q "^timeout_seconds = 30$" settings.ini
! grep -q "^timeout_seconds = 10$" settings.ini
test "$(grep -c "^option_" settings.ini)" = "300"
