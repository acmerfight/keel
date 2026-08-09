# Slice 1.6 scored window v6

This directory preserves the complete v6 scored window. V6 keeps the v5
runtime and production prompts, and clarifies only the direction of one
ambiguous cross-service eval field. It passed every pre-registered Slice 1.6
completion criterion.

- Candidate commit: `2dd185140550a134391dfa26b971160207d7dd2e`
- Date: 2026-08-09
- Provider/model: DeepSeek / `deepseek-v4-flash`
- Corpus: 2 tasks x 3 paired trials, 12 arms
- Results: `results.jsonl`
- Main transcripts: `main-transcripts/`
- Child canonical transcript artifacts: `child-transcripts/`

The exact invocation was:

```bash
node --experimental-strip-types src/cli/index.ts eval \
  --suite evals/experiments/subagent-slice-1-6/tasks \
  --provider deepseek \
  --model deepseek-v4-flash \
  --trials 3 \
  --out /tmp/keel-subagent-slice-1-6-v6.jsonl \
  --transcript-dir /tmp/keel-subagent-slice-1-6-v6-transcripts
```

The command exited 0. All 12 arms completed and verified. Every treatment
selected exactly one distinct child, and every child result had
`status=completed`, non-empty `finalText`, `error=null`, a transcript reference,
and observed read resources. Six distinct child identities account for all 38
child model operations. No cost overshoot, second child, false completion,
crash, or orphan was observed.

Four child final messages stayed below the 4,000-character handoff bound. Two
were safely projected to 4,000 characters and their main tasks still verified.
No main fully reread every child-observed path. Repeated-path counts were 10/12,
10/12, 7/12, 2/12, 2/12, and 2/12.

The six controls cost `$0.0283446632` in total with a 25.539-second wall-time
median. The six treatments cost `$0.0515118576` with a 54.615-second median.
This establishes the explicit foreground single-child completion gate under
the serialized continuation lease. It does not establish autonomous selection,
parallel speedup, or lower cost.

## Child transcript mapping

| Task/trial | Main `transcriptRef` | Preserved child transcript |
| --- | --- | --- |
| release audit / 1 | `tool-output:run-f944346d-995f-400d-98c4-dcf0b22608ac/5dbe8975-8302-4aff-8691-0cc2e209ce67` | `explicit-release-audit-trial-1.txt` |
| release audit / 2 | `tool-output:run-1cc5e988-a0c7-4393-b884-f13e1abd8142/38991131-359b-4ec8-96e0-69d5fad558a6` | `explicit-release-audit-trial-2.txt` |
| release audit / 3 | `tool-output:run-b384085f-39b0-4c9c-8431-b61be7f49ab1/bca46afa-ff62-4b6b-9cb7-c4b43387c2ae` | `explicit-release-audit-trial-3.txt` |
| service review / 1 | `tool-output:run-1facf60a-2b7d-4e56-abe5-7f3a5ab210a4/2bdddadb-b51c-405d-b187-827b341847fb` | `explicit-service-review-trial-1.txt` |
| service review / 2 | `tool-output:run-9ff040f0-9a30-40e5-9da9-2c477a835235/7b2cbe5e-972b-47f0-ab03-e0dfe0671b5b` | `explicit-service-review-trial-2.txt` |
| service review / 3 | `tool-output:run-d00757cb-f3a8-4ac8-a85d-8d2360d9dbbd/a97a276a-4839-4e41-b3de-8fe03af04e13` | `explicit-service-review-trial-3.txt` |
