# Stable Agent Policy — Slice 2.3

This is the pre-registered real-provider window for issue #590 Slice 2.3. It
asks whether the stable `explicit` policy recognizes an ordinary, short user
request to use a subagent while leaving the same capability unused for a small
task that does not request delegation.

The window does not decide whether `auto` should become a default. `auto`
remains an explicit opt-in whose broader value is evaluated separately. It also
does not turn repeated main investigation into a runtime failure: repetition is
reported as a model-quality, latency, and cost diagnostic.

## Scored windows

V1 ran once from `903601a6dc297ad094b764ddea58d02762450902`. All
12 arms completed and verified. Every positive treatment selected two distinct
children, naturally partitioning the independent payments and identity scopes;
every negative treatment selected zero. The command exited 1 because the
pre-registered `require_one` policy required exactly one child, an expectation
inherited from the earlier single-child slice that no longer matched the
multi-child product.

V1 had zero provider retries and zero budget overshoot. Positive controls cost
`$0.0101737272` with a 27.058-second wall-time median; positive treatments cost
`$0.0260060864` with a 66.889-second median. The full 12-arm window cost
`$0.0411677952`. All three positive mains reread decisive workspace evidence
after both children completed. That repetition remains a qualitative
model-quality and cost diagnostic, not a runtime rule. Complete V1 evidence is
retained under [`artifacts/v1/`](artifacts/v1/).

V2 changes only the eval selection contract from exactly one child to one or
more distinct children. Production prompt, runtime, tasks, workspaces, budgets,
provider, model, trial count, order, and all other gates are unchanged. This is
a complete new window, not a selective rescore of V1.

V2 ran once from `9a23274c143aa80ea76d6ac592f562d66c7b0335`.
Positive and negative selection both passed 3/3, all controls and negative
treatments verified, and positive treatments verified 2/3. The failed
treatment changed the meaning of `positiveClockSkewSeconds` from a duration to
a record count while writing its child task, then propagated 7 instead of 300
despite directly reading the decisive evidence. V2 had zero retries and zero
budget overshoot; complete evidence is retained under
[`artifacts/v2/`](artifacts/v2/).

V3 adds one production prompt rule: preserve original field meanings, units,
and output contracts when constructing child tasks, then reconcile final
synthesis against the original user request. It changes no runtime rule,
fixture, verifier, budget, provider, model, trial count, order, or selection
gate, and reruns the complete window.

V3 ran once from `254dc5fa5b8beae4c2da179d8b906db711f33f75` and
passed the complete gate: 12/12 arms verified, positive selection 3/3 with 2,
3, and 2 distinct completed children, negative selection 3/3 with zero
children, zero retries, and zero budget overshoot. Full analysis is in
[`RESULTS.md`](RESULTS.md), with raw evidence under
[`artifacts/v3/`](artifacts/v3/).

## Final v3 protocol

- Experiment: `subagent-slice-2-3`.
- Provider: DeepSeek.
- Model: `deepseek-v4-flash`.
- Trials: 3 paired trials for each of 2 tasks; 12 arms total.
- Conditions: `agentPolicy: off` control and `agentPolicy: explicit`
  treatment.
- Pairing: both arms receive the same prompt, root budget, base tools, model,
  and pristine workspace. Agent policy is the only capability delta.
- Order: odd trials run control first and even trials run treatment first.
- Task grading: deterministic workspace verifier only.
- Selection grading: treatment report only, independently from task outcome.
- Sampling: run the command below once from the committed candidate. Do not
  selectively rerun a failed or unavailable sample.
- Evidence: retain the result JSONL, available main and child transcripts,
  command metadata, and SHA-256 checksums for the scored window.

```bash
node --experimental-strip-types src/cli/index.ts eval \
  --suite evals/experiments/subagent-slice-2-3/tasks \
  --provider deepseek \
  --model deepseek-v4-flash \
  --trials 3 \
  --out /tmp/keel-subagent-slice-2-3-v3.jsonl \
  --transcript-dir /tmp/keel-subagent-slice-2-3-v3-transcripts
```

## Corpus and budgets

| Task | Policy expectation | Per-arm root max cost |
| --- | --- | ---: |
| `explicit-release-audit` | one or more children | $0.04 |
| `explicit-small-doc-fix` | no child | $0.01 |

The positive prompt begins only with `使用 subagent 调研这个任务。`; it does not
name a tool, exact child task, or partition. The negative prompt is a single
small edit and does not ask for delegation. Both use the same stable `explicit`
policy so the result measures semantic user intent rather than keyword routing.

## Pre-registered acceptance gate

The Slice 2.3 window passes only if all of the following hold:

- all 12 arms complete and pass their deterministic task verifiers;
- all 3 positive treatments select at least one distinct completed child;
- all 3 negative treatments select no child;
- no treatment exceeds its root cost budget or leaves live child work; and
- no authority bypass, duplicate child, duplicate delivery, or false terminal
  state is observed.

For every positive treatment, inspect the child conclusion and the subsequent
main transcript for obvious repeated investigation. Report repetition,
wall-clock time, tokens, and cost for both arms, but do not change this frozen
gate after viewing results and do not add a case-specific runtime prohibition.
