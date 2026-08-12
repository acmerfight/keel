# Slice 6.2 scored window v1

This directory preserves the only scored V1 product-graduation window.

- Candidate commit: `f129a611405f75208b54703954919cbe89169b0c`
- Date: 2026-08-12
- Provider/model: DeepSeek / `deepseek-v4-flash`
- Corpus: 3 tasks x 3 paired trials, 18 arms
- Results: `results.jsonl`
- Main transcripts: `main-transcripts/`
- Child canonical transcript artifacts: `child-transcripts/`

The exact invocation was:

```bash
node --experimental-strip-types src/cli/index.ts eval \
  --suite evals/experiments/subagent-slice-6-2/tasks \
  --provider deepseek \
  --model deepseek-v4-flash \
  --trials 3 \
  --out /tmp/keel-subagent-slice-6-2-v1.jsonl \
  --transcript-dir /tmp/keel-subagent-slice-6-2-v1-transcripts
```

The command exited 1 under the generic suite gate and was not rerun. All 18
arms completed and verified. Explicit positive treatments selected 2, 2, and
1 distinct completed children, so only 2/3 met `require_multiple`; auto
positive treatments selected none, so 0/3 met it; auto negative treatments
selected none and passed 3/3. There were zero retries and zero cost overshoots.

The complete interpretation is in [`../../RESULTS.md`](../../RESULTS.md).
