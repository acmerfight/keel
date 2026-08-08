#!/usr/bin/env bash
set -euo pipefail

cat > pipeline.mjs <<'EOF'
export function normalizeName(value) {
  return value.trim().toLowerCase();
}

export function nameKey(value) {
  const normalized = normalizeName(value);
  const checksum = [...normalized].reduce(
    (sum, char) => sum + char.charCodeAt(0),
    0,
  );
  return { normalized, checksum };
}

export function formatRecord(value) {
  const { normalized, checksum } = nameKey(value);
  return `${normalized}:${checksum}`;
}
EOF
