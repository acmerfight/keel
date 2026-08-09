# Slice 1.6 scored window v2

This directory preserves the complete v2 scored window. V2 fixed the fatal
invalid-argument path found by v1, but failed the unchanged task-outcome gate.
It was not selectively rerun.

- Candidate commit: `dd51689044982deda8ed7acd7fc5f899d30e92e0`
- Date: 2026-08-09
- Provider/model: DeepSeek / `deepseek-v4-flash`
- Corpus: 2 frozen tasks x 3 paired trials, 12 arms
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
  --out /tmp/keel-subagent-slice-1-6-v2.jsonl \
  --transcript-dir /tmp/keel-subagent-slice-1-6-v2-transcripts
```

The command exited 1 under the generic suite semantics. All 12 arms completed,
all 6 controls verified, and all 6 treatments selected exactly one distinct
child. Every child handoff had `status=completed` and non-empty `finalText`, but
only 4 of 6 treatment workspaces verified.

Both failures wrote `identity.positiveClockSkewSeconds=240` instead of the
configured value `300`. Their child final messages correctly distinguished the
configured 300-second limit from seven observed samples at 240 seconds. One
main also reread `token-validation.yaml` and saw the direct `300` value, then
still substituted the related sample measurement. This is a synthesis-quality
failure, not a child terminal or evidence-delivery failure.

All 6 child final messages exceeded the 4,000-character admitted-text bound
(4,098–5,734 characters), so every main handoff was truncated. This evidence
motivated the v3 prompt-only change: conclusion-first final messages below the
existing bound, no bulk source/log copying, and replacement of child facts only
when direct evidence for the same fact contradicts them.

No treatment fully reread all child-observed paths. The repeated-path counts
were 8/12, 4/12, 7/12, 8/12, 8/12, and 5/12. No cost overshoot, second child,
false completion, crash, or orphan was observed.

## Child transcript mapping

| Task/trial | Main `transcriptRef` | Preserved child transcript |
| --- | --- | --- |
| release audit / 1 | `tool-output:run-aa4ec5ca-1c9a-4e5c-ae28-e0ec1d3fba3f/9061e52a-b82d-46fa-be32-1f52f9b72316` | `explicit-release-audit-trial-1.txt` |
| release audit / 2 | `tool-output:run-1521a7d8-84cc-4103-a647-5f6110a5a582/96954a7c-e5a3-4830-975d-8971068954ae` | `explicit-release-audit-trial-2.txt` |
| release audit / 3 | `tool-output:run-295f92d5-ccb2-4b32-8750-b62a0a1b9dd2/f266a43e-65f2-4f9f-a8c8-ce9b018840e0` | `explicit-release-audit-trial-3.txt` |
| service review / 1 | `tool-output:run-8455db92-c717-4fa6-a962-a512d6a700b9/144268ab-ed2e-4e05-b14a-3fd7a236c818` | `explicit-service-review-trial-1.txt` |
| service review / 2 | `tool-output:run-72167586-023b-4cb1-bae9-3cc3800887f8/5a3db7d9-9cd0-46e6-b6d0-6ed687d05223` | `explicit-service-review-trial-2.txt` |
| service review / 3 | `tool-output:run-69f1e9b9-f76c-40ef-b214-3e06a379c436/cb58399c-99fa-4dfa-9eff-a0c2a1944bbb` | `explicit-service-review-trial-3.txt` |
