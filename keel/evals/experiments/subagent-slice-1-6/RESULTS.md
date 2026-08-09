# Slice 1.6 results

## V1 — failed, retained

The first scored window ran from candidate `714abd9f` and failed the frozen
completion gate:

| Metric | Result |
| --- | ---: |
| Control harness + task verifier | 6/6 |
| Treatment harness + task verifier | 5/6 |
| Treatment exactly-one-child selection | 5/6 observable; 1 crashed before selection could be reported |
| Completed child handoff with non-empty final text | 5/6 |
| Cost overshoot | 0/11 reported arms |
| Full reread of every child-observed path | 1/5 completed treatments |
| Observable report cost | `$0.081926824` |

The failed treatment emitted an overlong `delegate.task`. Provider validation
treated it as fatal and crashed the run before creating a child. Raw evidence,
the exact stderr, and checksums are retained under `artifacts/v1/`; it was not
selectively rerun.

## V2 — pre-registered follow-up

V2 changes one behavior only: invalid arguments for a `delegate` tool that is
actually exposed in the current request become a recoverable tool failure with
a bounded compression instruction. The failed call creates no child and
consumes no one-shot slot. The 4,000-character limit, corpus, prompts, model,
budgets, arm order, trial count, verifiers, and acceptance thresholds are
unchanged.

V2 must run the complete 12-arm window once from the committed recovery
candidate. It is not a rerun of only the V1 failure. Results will be appended
here without rewriting V1.
