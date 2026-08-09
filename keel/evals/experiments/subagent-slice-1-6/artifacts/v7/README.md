# Slice 1.6 scored window v7

This directory preserves the complete v7 scored window from the final reviewed
candidate. V7 reruns the unchanged v6 corpus and gate after review-driven
runtime changes: delegate must be the sole tool in its assistant turn, every
request is priced from its finalized provider shape, the root ledger holds the
main continuation reservation through child settlement, and minimum child
admission includes the finalized output bound.

- Candidate commit: `0cfae78065b578955aa2e40f0fa7749fe7a889ce`
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
  --out /tmp/keel-subagent-slice-1-6-v7.jsonl \
  --transcript-dir /tmp/keel-subagent-slice-1-6-v7-transcripts
```

The command exited 0. All 12 arms completed and verified. Every treatment
selected exactly one distinct child, every delegate was the sole tool in its
assistant turn, and every child result had `status=completed`, non-empty
`finalText`, `error=null`, a transcript reference, and observed read resources.
Six distinct child identities account for all 44 child model operations. No
cost overshoot, second child, false completion, crash, or orphan was observed.

Three child final messages stayed below the 4,000-character handoff bound.
Three were safely projected to 4,000 characters and their main tasks still
verified. Repeated child-covered path counts were 2/12, 10/12, 12/12, 0/12,
6/12, and 4/12. One main fully reread all 12 child-covered paths. This is the
pre-registered duplicate-work diagnostic, not a completion-gate failure; it is
retained without selective reruns or a new runtime read ban.

The six controls cost `$0.0284115944` in total with a 24.972-second wall-time
median. The six treatments cost `$0.0559316072` with a 60.809-second median.
Total observable cost was `$0.0843432016`. This establishes the explicit
foreground single-child completion gate under the final hard continuation
reservation. It does not establish autonomous selection, parallel speedup, or
lower cost.

## Child transcript mapping

| Task/trial | Main `transcriptRef` | Preserved child transcript |
| --- | --- | --- |
| release audit / 1 | `tool-output:run-9acda622-5f0e-445d-89a6-3862da038a4c/543c49de-ad11-4244-a445-d931bc98f7dd` | `explicit-release-audit-trial-1.txt` |
| release audit / 2 | `tool-output:run-d8c2757d-dbbe-465a-8595-fd181f4fec5a/be1d0af9-e2b1-4978-9f31-48a28633db2e` | `explicit-release-audit-trial-2.txt` |
| release audit / 3 | `tool-output:run-1e5ab2f6-cc5c-4a63-b6e3-be093bba4fc2/3c86b3d2-78b9-4465-ae98-5e9980008f2d` | `explicit-release-audit-trial-3.txt` |
| service review / 1 | `tool-output:run-66773353-a243-4852-bc92-48ab32d2e770/dcf0e376-4766-4772-8596-d9fbe219b2d3` | `explicit-service-review-trial-1.txt` |
| service review / 2 | `tool-output:run-9894a68f-64a5-4e79-84f3-7400060b0da1/9c0db91a-d965-4002-a89a-acfa6732be4b` | `explicit-service-review-trial-2.txt` |
| service review / 3 | `tool-output:run-b11c55bb-cd19-4d85-a86d-857e7b633711/375867ac-a3f0-41e3-946e-0fe1d6b8304e` | `explicit-service-review-trial-3.txt` |
