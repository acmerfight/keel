#!/usr/bin/env bash
set -euo pipefail

test -f out.html
cp out.html filtered.html
python3 filter.py filtered.html

if grep -qi "<script" filtered.html; then
  echo "script tag survived" >&2
  exit 1
fi

grep -Eiq "<[[:alpha:]][^>]*[[:space:]]on[[:alpha:]]+[[:space:]]*=" filtered.html
grep -q "keel" filtered.html
