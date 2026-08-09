# Explicit Intent v1 Raw Evidence

This directory retains the complete DeepSeek scored window for
`subagent-explicit-intent-v1`, frozen at
`c00cf08139c39a11f01e9477434ea164b1f7b245` and run on 2026-08-09.

- `results.jsonl` contains all 12 schema-v3 control/treatment result lines and
  their full run reports.
- `transcripts/` contains the 12 provider-visible transcripts named by task,
  trial, and condition.
- `MANIFEST.sha256` verifies every retained raw artifact. From this directory,
  run `shasum -a 256 -c MANIFEST.sha256`.

The `transcriptPath` values inside `results.jsonl` preserve the original
execution-time `/tmp` paths. Durable copies use the same filenames under
`transcripts/`. No provider credential or authorization header is present; the
artifacts contain only checked-in synthetic fixtures, model-visible messages,
reports, and usage metadata.
