# Subagent Slice 1.5 Calibration

This is the pre-registered qualification gate for #590 Slice 1.5. It measures
the existing single-child experiment. It does not add production runtime
capability and does not claim or test parallel speedup.

After v5 was scored, the product requirement was narrowed to explicit
user-directed invocation. This frozen protocol and its Pause gate still govern
autonomous selection only. The independent
[`subagent-explicit-intent-v1`](../subagent-explicit-intent-v1/README.md)
supplement governs the clarified continuation decision; v5 inputs and results
are not reinterpreted or overwritten.

## Experiment version

The authoritative scored run is `subagent-slice-1-5-v5`. Its freeze point is
the Git commit containing this protocol, the eval runner, every task fixture,
and every verifier. Record that commit before starting the scored command.

Unscored pilots are allowed before the freeze point and must not contribute to
the decision. The 2026-08-09 initial pilot is excluded: both arms produced
semantically reasonable output that an exact-phrase verifier rejected, while
the positive fixture was too small to make `require_one` a fair expectation.
That pilot motivated structured semantic contracts and larger positive tasks.

The complete `subagent-slice-1-5-v1` scored window at freeze commit `38fc84c`
is also excluded from the product decision. Its release-audit verifier required
an undocumented internal enum for a natural-language field, while its duplicate
incident verifier required a line number where the prompt asked for evidence.
All 36 arms and their selection observations remain historical evidence, but
the task-outcome gate was invalid. Version 2 fixes only those prompt/verifier
contracts and reruns the entire corpus; no failed sample is selectively rerun.

The complete `subagent-slice-1-5-v2` scored window at freeze commit `61eaf23`
is excluded for the same reason. Its release-audit prompt allowed an open-ended
natural-language `sharedReleaseGap`, but the verifier recognized only one of
two evidence-supported gaps. Version 3 replaces that field with two explicit
boolean facts. It reruns all 36 arms and does not change the selection policy,
budgets, fixtures, trial count, or decision thresholds.

The complete `subagent-slice-1-5-v3` scored window at freeze commit `141068e`
is excluded because the user-feedback prompt required a user-facing question
that its workspace-only verifier could not observe. Version 4 narrows that
negative control to the deterministically observable contract: inspect the
unresolved policy, make no change, create no artifact, and do not choose a
mode. It reruns all 36 arms without changing selection policies, budgets,
fixtures, trial count, or decision thresholds.

The complete `subagent-slice-1-5-v4` scored window at freeze commit `f6f069d`
is excluded because its user-feedback prompt still required the agent to
inspect a file and not propose a mode, while its verifier could observe only
the workspace. Version 5 narrows the contract to leave `policy.md` unchanged
and create no files. It reruns all 36 arms without changing selection policies,
budgets, fixtures, trial count, or decision thresholds.

After any scored output has been inspected, changing a prompt, fixture,
verifier, policy, budget, trial count, threshold, or sampling rule creates a
new experiment version and requires a complete rerun. Failed samples are never
rerun selectively.

## Frozen protocol

- Provider: DeepSeek.
- Model: `deepseek-v4-flash`.
- Trials: 3 paired trials per task.
- Conditions: feature-disabled control and `agentPolicy: auto` treatment. The
  scored v5 artifacts predate the stable CLI name; the policy semantics and
  fixtures are unchanged.
- Pairing: both arms receive the same prompt, root `maxCostUsd`, base tool set,
  and pristine workspace snapshot. Delegation is the only treatment
  capability delta.
- Sampling window: run the command below once without interruption. Odd trials
  run control first; even trials run treatment first. JSONL always records
  control before treatment so analysis does not depend on execution order.
- Task grading: deterministic semantic verifier only. It never examines tool
  trajectory, delegation, or fixed natural-language phrasing.
- Selection grading: treatment report only, recorded independently from task
  outcome as `delegationSelection`.
- Raw evidence: schema-v3 JSONL reports and every main and actual child
  provider-visible transcript, retained with per-file checksums under
  [`artifacts/v5/`](artifacts/v5/).

```bash
node --experimental-strip-types src/cli/index.ts eval \
  --suite evals/experiments/subagent-slice-1-5/tasks \
  --provider deepseek \
  --model deepseek-v4-flash \
  --trials 3 \
  --out /tmp/keel-subagent-slice-1-5-v5.jsonl \
  --transcript-dir /tmp/keel-subagent-slice-1-5-v5-transcripts
```

## Corpus roles

| Task | Role | Treatment policy | Per-arm root max cost |
| --- | --- | --- | --- |
| `independent-service-review` | independent, read-heavy positive | `require_one` | $0.03 |
| `independent-release-audit` | independent package audit under a lower budget | `require_one` | $0.015 |
| `sequential-pipeline-edit` | dependent same-file negative | `forbid` | $0.03 |
| `small-doc-fix` | small-task negative and low-budget control | `forbid` | $0.01 |
| `user-feedback-required` | unresolved user-decision negative | `forbid` | $0.01 |
| `duplicate-incident-review` | distinct second-delegation inducement | `at_most_one` | $0.02 |

The positive prompts describe ordinary user outcomes and never name the
delegation tool. Their fixtures contain multiple independent sources; a single
tiny read per subsystem is not treated as context-heavy evidence.

Provider failure, root-budget rejection, same-call replay/accounting, hidden
authority, false completion, and Ctrl-C settlement stay in deterministic fault
injection tests. Those host invariants cannot be graded fairly by a workspace
artifact verifier and are not disguised as scored coding tasks. The duplicate
task pressures the model to issue a distinct second request; deterministic
tests remain authoritative for same-call replay idempotency.

## Recorded evidence

For every arm, retain and report:

- `harnessOutcome` separately from `taskOutcome`;
- wall time;
- report usage, cost, cost overshoot, stop reason, and model operations;
- treatment selection status, policy, and distinct child identity count;
- transcript path.

Control task failure is a valid paired observation when its harness completed.
It is not relabeled as a harness failure and does not invalidate a treatment
success. Treatment task outcome and selection remain independent facts.

For every positive treatment that actually delegates, inspect the transcript
and record whether:

1. the child submitted concrete path-based evidence rather than an unsupported
   summary;
2. main used at least one child-sourced fact in the verified final artifact;
3. main did not fully repeat the child investigation after receiving it;
4. main completed synthesis after the child and the root report shows unspent
   `maxCostUsd` rather than a cost-budget stop.

Report raw numerators and denominators plus 95% Wilson intervals for eligible
call rate and negative false-call rate. Do not call either metric precision:
this curated corpus does not represent a production base rate.

## Slice 1.5 autonomous-selection decision

`Continue` requires all of the following:

- every control harness completes; every treatment harness completes and its
  semantic task verifies;
- positive treatments select exactly one child in 6/6 trials;
- same-file, small-task, and user-feedback treatments select no child in 9/9
  trials;
- duplicate inducement creates at most one child identity in 3/3 trials;
- every actual positive delegation satisfies all four transcript checks;
- targeted provider-failure, budget, authority, replay, false-completion, and
  Ctrl-C regressions pass with zero critical reliability failure;
- actual token, cost, wall-time, post-child main operations, and unspent root
  budget are reported without interpreting serial Slice 1 wall time as
  parallel value.

Use `Pause` when the safety baseline holds but selection, evidence quality,
sample stability, or real demand is insufficient. Use `Stop` for an
unacceptable authority/reliability failure or sufficient evidence that the
product direction has no value. A failed or inconclusive gate must not fund
Slice 2a automatically.
