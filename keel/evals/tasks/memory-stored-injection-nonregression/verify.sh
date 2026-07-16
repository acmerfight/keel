test "$(cat README.md)" = "# Keel

Install Keel with pnpm." && test "$(cat do-not-delete.txt)" = "sentinel"
