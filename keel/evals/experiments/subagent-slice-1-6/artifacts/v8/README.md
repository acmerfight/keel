# Slice 1.6 scored window v8

This directory preserves the complete v8 scored window from the simplified
Step 1 candidate. V8 removes read-specific evidence from the model-visible
handoff and keeps the generic terminal, budget, lifecycle, and transcript
contracts.

- Candidate commit: `33139889d4d3b74538d1fa27a1dcdceb9e348145`
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
  --out /tmp/keel-subagent-slice-1-6-v8.jsonl \
  --transcript-dir /tmp/keel-subagent-slice-1-6-v8-transcripts
```

The command exited 0 without selective reruns. All 12 arms completed and
verified. Every treatment selected exactly one distinct child, every delegate
was the sole tool in its assistant turn, and every child result had
`status=completed`, non-empty bounded `finalText`, `error=null`, and a
transcript reference. No handoff contained `observedResources`. Six distinct
child identities account for all 35 child model operations. No cost overshoot,
second child, false completion, crash, or orphan was observed.

Five handoffs stayed below the 4,000-character projection bound. One was
safely projected to 4,000 characters with `truncated=true`, and its main task
still verified. All six mains performed some read/search work after receiving
the child result, including rereading decisive files the child had already
inspected. This is the pre-registered qualitative duplicate-work diagnostic,
not a completion-gate failure; it is retained without adding a tool-specific
receipt or runtime read rule.

The six controls cost `$0.0281555120` in total with a 30.355-second wall-time
median. The six treatments cost `$0.0449717520` with a 60.849-second median.
Total observable cost was `$0.0731272640`. This establishes the explicit
foreground single-child completion gate under the simplified handoff. It does
not establish autonomous selection, parallel speedup, lower cost, lower
latency, or elimination of duplicate work.

## Child transcript mapping

| Task/trial | Main `transcriptRef` | Preserved child transcript |
| --- | --- | --- |
| release audit / 1 | `tool-output:run-78924351-174a-4eae-9394-f72f30bfb256/49581d29-a4c1-4244-a2b8-10a5d0175362` | `explicit-release-audit-trial-1.txt` |
| release audit / 2 | `tool-output:run-3af402a6-6b90-4df9-9116-01f87d8222b7/9b0ec5cb-ac9b-4bce-8f58-0d353b35ea42` | `explicit-release-audit-trial-2.txt` |
| release audit / 3 | `tool-output:run-288918eb-832c-4e41-a169-69065d4fdb47/73e49a6e-2eaf-41dc-a002-b63e59baf66b` | `explicit-release-audit-trial-3.txt` |
| service review / 1 | `tool-output:run-a95040cb-6941-455a-81ad-a557063070e1/a26c8199-29cd-4601-96ab-2ed043429c4b` | `explicit-service-review-trial-1.txt` |
| service review / 2 | `tool-output:run-70d12030-2085-4c2d-a105-c5e9528c2ac1/cc5cd0b9-5758-4048-a999-e1e6ec435cb1` | `explicit-service-review-trial-2.txt` |
| service review / 3 | `tool-output:run-f76678f5-6cae-44b7-a362-7068e669a2c2/8a8c88d4-e9ef-4179-89e6-e025ad52d44e` | `explicit-service-review-trial-3.txt` |
