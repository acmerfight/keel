# Slice 6.3 scored window V2

This directory preserves the only scored V2 orchestration-graduation window.

- Protocol freeze commit: `0082dc7aeccedc4031744fac3073f927f0389689`
- Candidate commit: `886dadb0d1d2c9d319e4a7e48b3931febe0e745c`
- Date: 2026-08-13
- Provider/model: DeepSeek / `deepseek-v4-flash`
- Corpus: 5 tasks x 3 paired trials, 30 arms
- Results: `results.jsonl`
- Main transcripts: `main-transcripts/`

The exact invocation was:

```bash
node --experimental-strip-types src/cli/index.ts eval \
  --suite evals/experiments/subagent-slice-6-3/tasks \
  --provider deepseek \
  --model deepseek-v4-flash \
  --trials 3 \
  --out /tmp/keel-subagent-slice-6-3-v2.jsonl \
  --transcript-dir /tmp/keel-subagent-slice-6-3-v2-transcripts
```

The command exited 1 under the suite selection gate and was not rerun. All 30
arms completed and verified. Auto positive treatments selected no child in 6/6
trials; explicit positives selected multiple completed children in 5/6; the
auto sequential negative correctly selected none in 3/3. There were zero
provider retries and zero root cost overshoots.

The requested transcript directory preserved all 30 Main transcripts. Each
explicit Main transcript contains the bounded child receipts, terminal status,
transcript reference, and final text returned to Main. The runner's isolated
per-arm state was cleaned after execution, so separate canonical child
transcript artifacts were not exported and are not claimed here.

The attempted production prompt change was reverted after this frozen window.
The complete interpretation is in [`../../RESULTS.md`](../../RESULTS.md).
