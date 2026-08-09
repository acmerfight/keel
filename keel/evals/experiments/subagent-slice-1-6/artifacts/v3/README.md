# Slice 1.6 scored window v3

This directory preserves the complete v3 scored window. V3 passed every
pre-registered Slice 1.6 completion criterion.

- Candidate commit: `093ae6e84fa7c032bf5860cc9628a23a749e3c5d`
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
  --out /tmp/keel-subagent-slice-1-6-v3.jsonl \
  --transcript-dir /tmp/keel-subagent-slice-1-6-v3-transcripts
```

The command exited 0. All 12 arms completed and verified. Every treatment
selected exactly one distinct child, and every child result had
`status=completed`, non-empty `finalText`, `error=null`, a transcript reference,
and observed read resources. Six distinct child identities account for all 39
child model operations. No cost overshoot, second child, false completion,
crash, or orphan was observed.

Five of six child final messages stayed within the 4,000-character handoff
bound (3,071–3,975 characters). One was 4,526 characters and was safely
projected to 4,000; its main task still verified. No main fully reread every
child-observed path. Repeated-path counts were 8/12, 6/12, 7/12, 10/12, 10/12,
and 2/12.

The six controls cost `$0.029377432` in total with a 29.521-second wall-time
median. The six treatments cost `$0.045083976` with a 58.618-second median.
This foreground single-child slice establishes reliable explicit completion,
not a speed or cost advantage; parallel value remains a later gate.

## Child transcript mapping

| Task/trial | Main `transcriptRef` | Preserved child transcript |
| --- | --- | --- |
| release audit / 1 | `tool-output:run-622005b6-3cbe-4e9a-97fc-acf6dbda3ef7/f813ad3d-1cc2-43e2-853b-5b78c9bcb39c` | `explicit-release-audit-trial-1.txt` |
| release audit / 2 | `tool-output:run-05d1b21d-98f5-49b1-a8d0-684d47e434fe/bd1b880e-83b1-4a8f-8503-986ee33da6f7` | `explicit-release-audit-trial-2.txt` |
| release audit / 3 | `tool-output:run-40395d26-8f62-4187-a388-40a2f832026f/f2df895c-84cc-4ae6-9d10-cb692b7472fa` | `explicit-release-audit-trial-3.txt` |
| service review / 1 | `tool-output:run-61308cd1-bd28-48a1-b264-31064553437b/9419ea8f-2c1d-476c-af91-b806b1a7eda8` | `explicit-service-review-trial-1.txt` |
| service review / 2 | `tool-output:run-fa5a7235-5a5c-457a-aeed-5103c41cc59f/6f7f0975-bcd2-4995-9f3f-a84b95d40b31` | `explicit-service-review-trial-2.txt` |
| service review / 3 | `tool-output:run-33cb96a0-60d2-425a-9ee0-4f3654efacd6/8cbcdb1a-0952-46b4-aa02-16f9318ac4a2` | `explicit-service-review-trial-3.txt` |
