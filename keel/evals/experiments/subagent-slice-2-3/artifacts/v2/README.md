# Slice 2.3 scored window v2

This directory preserves the complete V2 scored window after the eval selection
contract began accepting one or more distinct children.

- Candidate commit: `9a23274c143aa80ea76d6ac592f562d66c7b0335`
- Date: 2026-08-09
- Provider/model: DeepSeek / `deepseek-v4-flash`
- Corpus: 2 tasks x 3 paired trials, 12 arms
- Results: `results.jsonl`
- Main transcripts: `main-transcripts/`
- Child canonical transcript artifacts: `child-transcripts/`

The exact invocation was:

```bash
node --experimental-strip-types src/cli/index.ts eval \
  --suite evals/experiments/subagent-slice-2-3/tasks \
  --provider deepseek \
  --model deepseek-v4-flash \
  --trials 3 \
  --out /tmp/keel-subagent-slice-2-3-v2.jsonl \
  --transcript-dir /tmp/keel-subagent-slice-2-3-v2-transcripts
```

The command exited 1 without selective reruns. Positive selection passed 3/3:
every treatment created two distinct completed children. Negative selection
passed 3/3 with zero children. All six controls and all three negative
treatments verified, while positive treatments verified 2/3.

The failed positive treatment delegated an identity field with the wrong
meaning: it asked the child to report a record count as
`positiveClockSkewSeconds`, even though the original user schema asked for a
duration in seconds and used a separate `extendedWindowSamples` count. The
child faithfully returned 7, and main wrote 7 after reading evidence that the
configured duration was 300 seconds. V3 therefore adds one general prompt rule:
delegated structured work must preserve original field meanings, units, and
output contracts, and final synthesis must reconcile against the user's
original request.

There were zero retries and zero cost overshoots. Positive controls cost
`$0.0103464480` with a 24.602-second median; positive treatments cost
`$0.0227545416` with a 69.762-second median. Negative controls cost
`$0.0023645664`; negative treatments cost `$0.0026924408`. Total observable
cost was `$0.0381579968`.
