set -euo pipefail
grep -q "Install the dependencies" README.md
! grep -q "Instal the dependencies" README.md
