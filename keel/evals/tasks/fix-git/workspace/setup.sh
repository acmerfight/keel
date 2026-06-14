#!/usr/bin/env bash
set -euo pipefail

rm -rf .git site.txt
git init -q
git config user.email "keel@example.test"
git config user.name "Keel Eval"
git branch -m main

cat > site.txt <<'TXT'
welcome: hello from the original site
TXT
git add site.txt
git commit -q -m "initial site"

git switch -q -c redesign
cat >> site.txt <<'TXT'
nav: refreshed navigation
TXT
git add site.txt
git commit -q -m "redesign navigation"

git switch -q main
