# Subagent product graduation — Slice 6.2

> Historical reproducibility: authoritative scored runs must be reproduced
> from their recorded freeze commit. Current-tree task fixtures follow Keel's
> trusted-execution default and are not directly comparable with frozen runs
> that used the removed `allowBash` task setting.

This is the pre-registered real-provider window for issue #590 Slice 6.2. It
tests the finished product boundary rather than a new orchestration mode:

- ordinary explicit intent can produce more than one distinct child for two
  independent scopes;
- opt-in `auto` can recognize the same parallel opportunity without an
  explicit subagent request; and
- opt-in `auto` leaves a small sequential edit with Main.

The corpus, prompts, provider/model, budgets, trial count, ordering, metrics,
and decision gate below are frozen before the scored window. A failed sample is
retained and is not selectively rerun. This slice does not change production
prompts after seeing results and does not open background, writer, Bash, or
`auto` nesting.

## Protocol

- Experiment: `subagent-slice-6-2`.
- Provider: DeepSeek.
- Model: `deepseek-v4-flash`.
- Trials: 3 paired trials for each of 3 tasks; 18 arms total.
- Conditions: `agentPolicy: off` control and the configured `explicit` or
  `auto` treatment.
- Pairing: both arms receive the same prompt, root budget, base tools, model,
  and pristine workspace. Agent policy is the only capability delta.
- Order: odd trials run control first and even trials run treatment first.
- Task grading: deterministic workspace verifier only.
- Selection grading: treatment report only, independently from task outcome.
- Human intervention: none; any intervention is a gate failure.
- Sampling: run the command below once from the committed candidate.
- Evidence: retain result JSONL, available main and child transcripts, command
  metadata, candidate commit, and SHA-256 checksums.

```bash
node --experimental-strip-types src/cli/index.ts eval \
  --suite evals/experiments/subagent-slice-6-2/tasks \
  --provider deepseek \
  --model deepseek-v4-flash \
  --trials 3 \
  --out /tmp/keel-subagent-slice-6-2-v1.jsonl \
  --transcript-dir /tmp/keel-subagent-slice-6-2-v1-transcripts
```

## Frozen corpus

| Task | Treatment | Selection gate | Per-arm root max cost |
| --- | --- | --- | ---: |
| `explicit-parallel-release-audit` | `explicit` | at least two distinct children | $0.04 |
| `auto-parallel-release-audit` | `auto` | at least two distinct children | $0.04 |
| `auto-sequential-doc-fix` | `auto` | zero children | $0.01 |

The two positive tasks contain the same independent payments and identity
release scopes. Their only prompt difference is the explicit task's ordinary
leading request, `使用 subagent 调研这个任务。`; it does not prescribe a
tool, child count, task split, or profile. The negative task is one exact line
edit. The fixture is copied into this experiment so later changes to historical
Slice 2.3 evidence cannot alter the frozen window.

## Acceptance gate

The product graduation window passes only if all of the following hold:

1. All 18 arms complete, pass their deterministic verifier, and use zero human
   interventions.
2. All 3 explicit positive treatments create at least two distinct completed
   children; all 3 auto positive treatments do the same; all 3 auto negative
   treatments create none.
3. No treatment exceeds its root cost budget or shows an orphan, duplicate
   child/delivery, false terminal, authority bypass, or retry storm.
4. Each positive treatment condition is non-inferior to its controls on task
   success and improves at least one pre-registered median value signal:
   root `agentLoopTurns`, total input tokens, or wall time. Cost, output tokens,
   repeated Main investigation, and the other two value signals are reported
   even when worse; one improvement cannot be used to claim that subagents are
   generally cheaper or faster.
5. The sequential negative has no task-success, intervention, or selection
   regression. Provider latency noise is reported but is not a failure while
   both arms remain inside the same fixed budget and no child is created.

Reliability and value are separate conclusions. If explicit passes but `auto`
does not, explicit remains a supported user-directed path while `auto` is not
promoted or made default. If the task verifies but no value signal improves,
the runtime remains unchanged and the result is recorded as evidence against
broader rollout. No outcome in this window authorizes default-on delegation or
wider nesting.

## Scored result

V1 ran once from the frozen candidate and failed the selection/value gate while
all 18 task arms verified. The complete result and retained evidence are in
[`RESULTS.md`](RESULTS.md).
