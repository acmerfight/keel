# Explicit Subagent Completion Reliability — Slice 1.6

This is the pre-registered completion-reliability window for issue #590 Slice
1.6. It asks a narrower question than autonomous delegation selection: after
the exact explicit prefix `使用 subagent 调研这个任务。` selects the experimental
feature, can one foreground read-only child finish normally and hand enough
trusted context back for main to complete the same task?

The corpus is a mechanical copy of the two frozen explicit-intent v1 fixtures.
Their prompts, workspaces, solutions, and deterministic verifiers are unchanged
so the new window measures the host-owned result handoff and continuation
budget rather than a new task distribution. The experiment has a new path and
decision rule because the v1 scored window remains immutable.

## Frozen protocol

- Experiment: `subagent-slice-1-6`.
- Provider: DeepSeek.
- Model: `deepseek-v4-flash`.
- Trials: 3 paired trials for each of 2 tasks; 12 arms total.
- Conditions: feature-disabled control and `--experimental-agents` treatment.
- Treatment policy: `require_one`.
- Prompt prefix: exactly `使用 subagent 调研这个任务。` followed by a blank line.
- Pairing: each pair uses the same prompt, model, root budget, base tools, and
  pristine workspace; delegation is the only treatment capability delta.
- Order: odd trials run control first and even trials run treatment first.
- Task grading: the unchanged deterministic workspace verifiers.
- Child completion grading: inspect each treatment transcript's `delegate`
  result and require `status=completed`; do not infer completion merely from a
  child model operation or a distinct child ID.
- Duplicate-work diagnostic: compare the child `observedResources` receipt
  with later main read calls. A main full reread of every covered path is
  recorded as a quality regression; targeted spot-checks remain allowed.
- Sampling: run the command below once from the exact committed candidate. Do
  not selectively rerun failed samples.
- Evidence: retain result JSONL, all main transcripts, extracted child
  transcripts, command metadata, and SHA-256 checksums under `artifacts/v1/`.

```bash
node --experimental-strip-types src/cli/index.ts eval \
  --suite evals/experiments/subagent-slice-1-6/tasks \
  --provider deepseek \
  --model deepseek-v4-flash \
  --trials 3 \
  --out /tmp/keel-subagent-slice-1-6.jsonl \
  --transcript-dir /tmp/keel-subagent-slice-1-6-transcripts
```

## Corpus and budget

| Task | Independent scopes | Per-arm root max cost |
| --- | --- | ---: |
| `explicit-service-review` | `services/api/`, `services/worker/` | $0.06 |
| `explicit-release-audit` | `packages/payments/`, `packages/identity/` | $0.04 |

## Pre-registered acceptance gate

Slice 1.6 passes only if all of the following hold in the one scored window:

- all 6 treatment arms select exactly one distinct child;
- all 6 treatment child results have terminal `status=completed` with a
  non-empty host-admitted `finalText`;
- all 6 controls and all 6 treatments complete and pass their deterministic
  task verifier;
- no authority bypass, cost overshoot, false completion, second child, or
  orphaned child is observed; and
- the deterministic Slice 1 regression suites remain green.

Duplicate full rereads are reported separately. They trigger prompt/projection
follow-up but do not become a runtime read ban or silently change task pass.
Any failed mandatory item keeps Slice 1.6 open; the generic eval exit code
continues to fail when a required treatment or ordinary task fails.
