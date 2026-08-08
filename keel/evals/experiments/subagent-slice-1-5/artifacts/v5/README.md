# Slice 1.5 v5 Raw Evidence

This directory retains the complete authoritative DeepSeek scored window for
`subagent-slice-1-5-v5`, frozen at
`f48b512df2861087e58cb2b68436ccff9bbc46e7` and run on 2026-08-09.

- `results.jsonl` contains all 36 schema-v3 control/treatment result lines and
  their full run reports.
- `transcripts/` contains the 36 provider-visible transcripts named by task,
  trial, and condition.
- `MANIFEST.sha256` verifies every retained raw artifact. From this directory,
  run `shasum -a 256 -c MANIFEST.sha256`.

The `transcriptPath` values inside `results.jsonl` preserve the original
execution-time `/tmp` paths. The durable copies use the same filenames under
`transcripts/`. No provider credential or authorization header is present;
the artifacts contain only the checked-in synthetic fixtures, model-visible
messages, reports, and usage metadata.
