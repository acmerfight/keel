# Slice 1.6 scored window v5

This directory preserves the complete v5 scored window. V5 tested the general
named-fact distinction added after v4. The release-audit regression was fixed,
but the window exposed an ambiguous service-review verifier contract and was
therefore not selectively rerun.

- Candidate commit: `3e456f1974a0e8cd0001741426bdc6890f5a5f9e`
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
  --out /tmp/keel-subagent-slice-1-6-v5.jsonl \
  --transcript-dir /tmp/keel-subagent-slice-1-6-v5-transcripts
```

The command exited 1. All 12 arms completed; controls verified 6/6 and
treatments verified 5/6. Every treatment selected exactly one distinct child,
and all six child handoffs were `status=completed` with non-empty final text,
observed resources, and no cost overshoot or second child. The recurring
release-audit distinction between the configured 300-second policy and
observed 240-second samples verified in all three treatments.

The sole failure was `explicit-service-review` trial 1. Both child and main
reported `account_id`: it is present in the worker audit and envelope contract
but absent from the API request audit. The verifier expected `request_id`,
which is present in the API audit but absent from the worker delivery audit.
The prompt only named `missingCorrelationField` and did not specify which audit
was the source or target, so both answers were evidence-backed. This is an eval
contract ambiguity, not a runtime or handoff failure. The next experiment
version must state the direction explicitly and rerun the complete window.

The six controls cost `$0.0288312304` in total with a 26.128-second wall-time
median. The six treatments cost `$0.0464804536` with a 61.754-second median.

## Child transcript mapping

| Task/trial | Main `transcriptRef` | Preserved child transcript |
| --- | --- | --- |
| release audit / 1 | `tool-output:run-18b10e53-5342-4d9e-8751-ed7b538979a4/8901219c-e91f-4222-9e90-8ff45583e6ab` | `explicit-release-audit-trial-1.txt` |
| release audit / 2 | `tool-output:run-b949dd83-4540-421a-8044-1a978d2931dd/61707372-3fbf-483d-9ff4-aab563559a9e` | `explicit-release-audit-trial-2.txt` |
| release audit / 3 | `tool-output:run-55417146-f926-42fd-bd1c-54add940e83e/09e59606-e766-4aa3-9f37-3bbd87231de1` | `explicit-release-audit-trial-3.txt` |
| service review / 1 | `tool-output:run-de253993-1f50-48ad-87ff-5b525592c5fa/c6d9836a-2bb6-47f9-b519-a8558d50ff0a` | `explicit-service-review-trial-1.txt` |
| service review / 2 | `tool-output:run-e0c30ca3-57db-47c4-ba55-32dd044bebfd/5a971eef-b3bd-4cef-a490-f5793b37f1fc` | `explicit-service-review-trial-2.txt` |
| service review / 3 | `tool-output:run-ee8e585c-65de-4ad7-a684-65aacadae624/6dba4ada-dc2c-41ee-bc00-53cf8563446c` | `explicit-service-review-trial-3.txt` |
