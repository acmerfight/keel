# Explicit Subagent Intent Calibration v1

> Historical reproducibility: authoritative scored runs must be reproduced
> from their recorded freeze commit. Current-tree task fixtures follow Keel's
> trusted-execution default and are not directly comparable with frozen runs
> that used the removed `allowBash` task setting.

This is a pre-registered supplement to the #590 Slice 1.5 calibration. It
answers one narrower product question: when the experimental feature is enabled
and the user explicitly says `使用 subagent 调研这个任务。`, does main start one bounded child?

It does not retest autonomous delegation selection, claim that delegation is
faster, or make the feature default-on. The authoritative
`subagent-slice-1-5-v5` result remains the evidence for prompts that do not
mention subagents.

The protocol was frozen at
`c00cf08139c39a11f01e9477434ea164b1f7b245` and run once. See
[`RESULTS.md`](RESULTS.md) for the scored result and product decision.

## Why this is a separate experiment

The product requirement was clarified after v5 results were inspected:
explicit user intent is sufficient to justify the extra subagent cost. Changing
the v5 prompt or decision threshold in place would invalidate its
pre-registration, so this supplement has new tasks, budgets, thresholds, and a
complete scored window.

Two exploratory runs informed this protocol but are unscored. A detailed
one-child partition selected a child in 3/3 valid treatment trials. A later run
using only the exact sentence above selected a child in both treatments whose
reports were observable; the third treatment ended during a provider stream
tool call before a report existed. Those outputs were inspected and therefore
cannot contribute to this decision. They motivated a larger declared root cost
budget and the no-rerun rule below.

## Frozen protocol

- Experiment: `subagent-explicit-intent-v1`.
- Provider: DeepSeek.
- Model: `deepseek-v4-flash`.
- Trials: 3 paired trials for each of 2 tasks; 12 arms total.
- Conditions: feature-disabled control and `agentPolicy: explicit` treatment.
  The scored v1 artifacts predate the stable CLI name; the explicit-intent
  semantics and fixtures are unchanged.
- Prompt delta from the v5 positive fixtures: exactly the sentence
  `使用 subagent 调研这个任务。` followed by a blank line. The prompt does not
  prescribe a partition, child scope, tool name, or evidence allocation.
- Pairing: both arms receive the same prompt, root `maxCostUsd`, base tools,
  model, and pristine workspace snapshot. Delegation is the only treatment
  capability delta.
- Order: odd trials run control first and even trials run treatment first.
- Task grading: the existing deterministic semantic verifiers.
- Selection grading: the treatment report's schema-v3
  `delegationSelection`, independent from task outcome.
- Sampling: run the command below once after committing this protocol. Do not
  selectively rerun a failed or unavailable sample.
- Raw evidence: retain the result JSONL, every main and child provider-visible
  transcript, and per-file SHA-256 checksums under `artifacts/v1/`.

```bash
node --experimental-strip-types src/cli/index.ts eval \
  --suite evals/experiments/subagent-explicit-intent-v1/tasks \
  --provider deepseek \
  --model deepseek-v4-flash \
  --trials 3 \
  --out /tmp/keel-subagent-explicit-intent-v1.jsonl \
  --transcript-dir /tmp/keel-subagent-explicit-intent-v1-transcripts
```

## Corpus and budget

| Task | Independent scopes | Per-arm root max cost |
| --- | --- | ---: |
| `explicit-service-review` | `services/api/`, `services/worker/` | $0.06 |
| `explicit-release-audit` | `packages/payments/`, `packages/identity/` | $0.04 |

Both treatments use `require_one`. The larger budgets are deliberate: this
experiment is measuring whether explicit intent reaches the existing bounded
child runtime, not whether that runtime is cheaper than one agent. Actual cost,
tokens, wall time, task outcome, stop reason, and remaining budget are still
reported.

## Pre-registered decision

`Continue explicit delegation development` requires all of the following:

- all 6 treatment selections are observable and select exactly one distinct
  child;
- all 6 control harnesses and all 6 treatment harnesses complete;
- zero authority bypass, cost overshoot, false completion, duplicate child, or
  orphaned child is observed;
- the unchanged deterministic Slice 1 reliability suites remain green; and
- the v5 negative-control evidence remains applicable because this supplement
  changes no production runtime or prompt.

Semantic task verification, evidence reuse, repeated main investigation,
tokens, cost, wall time, stop reason, and unspent budget are diagnostic in this
supplement. They must be reported honestly, but they do not redefine the
explicit-intent selection question. A selection pass means only that explicit
user-directed development may continue; quality regressions become inputs to
the next slice and still block any release/default-on decision.

Use `Pause` if any selection is absent or unavailable, a harness does not
complete, or the existing safety baseline regresses. `Stop` remains reserved
for an unacceptable authority or reliability failure. Autonomous selection
stays uncommitted regardless of this result.
