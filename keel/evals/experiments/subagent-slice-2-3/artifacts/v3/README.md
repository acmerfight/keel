# Slice 2.3 scored window v3

This directory preserves the final scored window for the stable `explicit`
agent policy after the general delegated-contract fidelity prompt fix.

- Candidate commit: `254dc5fa5b8beae4c2da179d8b906db711f33f75`
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
  --out /tmp/keel-subagent-slice-2-3-v3.jsonl \
  --transcript-dir /tmp/keel-subagent-slice-2-3-v3-transcripts
```

The command exited 0 without selective reruns. All 12 arms completed and
verified. Positive treatments selected 2, 3, and 2 distinct children; all
seven child canonical artifacts report `sourceStatus: complete`. Negative
treatments selected zero children. There were zero provider retries and zero
cost overshoots.

Positive controls cost `$0.0102877824` with a 22.070-second wall-time median;
positive treatments cost `$0.0232953560` with a 71.253-second median. Negative
controls cost `$0.0023705080` with a 5.642-second median; negative treatments
cost `$0.0026142704` with a 5.471-second median. Total observable cost was
`$0.0385679168`.

All three positive mains performed read or grep work over child-covered
evidence after child completion. That repeated investigation remains an honest
latency/cost diagnostic. The accepted design continues to trust main's
verification judgment and does not add a runtime ban, read receipt, fact
classifier, or task-specific synthesis rule.
