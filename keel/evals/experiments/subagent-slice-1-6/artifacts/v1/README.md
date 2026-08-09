# Slice 1.6 scored window v1

This directory preserves the first scored Slice 1.6 window exactly as
observed. It failed the pre-registered gate and was not selectively rerun.

- Candidate commit: `714abd9f` (`fix(agent): harden explicit subagent completion`)
- Date: 2026-08-09
- Provider/model: DeepSeek / `deepseek-v4-flash`
- Corpus: 2 frozen tasks x 3 paired trials, 12 arms
- Root budgets: `$0.04` for `explicit-release-audit`, `$0.06` for
  `explicit-service-review`
- Results: `results.jsonl`
- Main transcripts: `main-transcripts/`
- Child canonical transcript artifacts: `child-transcripts/`

The effective invocation was:

```bash
node --experimental-strip-types src/cli/index.ts eval \
  --suite evals/experiments/subagent-slice-1-6/tasks \
  --provider deepseek \
  --model deepseek-v4-flash \
  --trials 3 \
  --out /tmp/keel-subagent-slice-1-6.OAZOd6/results.jsonl \
  --transcript-dir /tmp/keel-subagent-slice-1-6.OAZOd6/transcripts
```

The command exited 1 under the generic suite semantics. All 6 controls
completed and verified. Five of 6 treatments selected exactly one child,
received a host-owned `status=completed` handoff with non-empty `finalText`,
completed main synthesis, and verified. The remaining treatment crashed before
a child started, so no report, main transcript, or child transcript exists for
that arm. Its stderr was:

```text
[explicit-release-audit] agent stderr: Tool: ls packages
Tool: glob packages/**/release-audit*
Tool: ls packages/payments
Tool: ls packages/identity
Error: DeepSeek delegate tool call has invalid arguments
```

The failure was traced to a model-generated `delegate.task` longer than the
schema's 4,000-character maximum. V1 treated that validation failure as a
provider-fatal protocol error. The follow-up does not relax the bound or add a
DeepSeek-specific repair; it makes invalid arguments for a currently exposed
`delegate` call recoverable by main without starting a child or consuming the
one-shot slot.

## Child transcript mapping

| Task/trial | Main `transcriptRef` | Preserved child transcript |
| --- | --- | --- |
| release audit / 2 | `tool-output:run-66dc2e95-881b-4a02-b5be-46b7aaea6d05/dc957408-ea15-4db0-add1-5c2fbfb4d32d` | `explicit-release-audit-trial-2.txt` |
| release audit / 3 | `tool-output:run-ef6b20ef-b110-467f-a925-6eb6e4cd3858/39cdf80b-db99-4b8e-b89e-4be4c6f88764` | `explicit-release-audit-trial-3.txt` |
| service review / 1 | `tool-output:run-0ddbf941-87d3-45ef-a7c6-c9a7ee49e1e2/738d0013-fad1-49eb-a717-8f3582178b59` | `explicit-service-review-trial-1.txt` |
| service review / 2 | `tool-output:run-b7cc4aed-dc08-47ad-9382-7dfcbdb8dc76/ee986e3b-0432-43e7-8b5a-5689b67c9aba` | `explicit-service-review-trial-2.txt` |
| service review / 3 | `tool-output:run-528c9591-0326-4e51-a5fd-3e5185a7b02c/0fbe84cd-b927-4479-aa84-d877ed6f43d9` | `explicit-service-review-trial-3.txt` |

## Duplicate-work diagnostic

One of the five completed treatments (`explicit-release-audit`, trial 2) read
all 12 child-observed paths again. Its bounded child projection was truncated
mid-report, so main explicitly recovered the missing fields. The other four
treatments reread only subsets (7/12, 10/12, 6/12, and 8/12). This remains a
reported quality metric, not a runtime read prohibition.
