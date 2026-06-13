set -euo pipefail
test "$(shasum -a 256 test.js | awk '{print $1}')" = "e03c4c15300164d703904422bbd8e9bfd166bba09853ff84788e82264fca21d3"
node test.js
