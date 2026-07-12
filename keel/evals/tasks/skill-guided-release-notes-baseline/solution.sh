#!/bin/sh
set -eu

printf '%s\n' \
  '## Breaking changes' \
  '' \
  '- Require scoped provider names (#19)' \
  '' \
  '## Features' \
  '' \
  '- Add project profiles (#7)' \
  '- Show model cost source (#11)' \
  '' \
  '## Fixes' \
  '' \
  '- Preserve queued input (#41)' > RELEASE_NOTES.md
