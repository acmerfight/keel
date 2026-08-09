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

## V2 — runtime reliable, task gate failed

V2 changes one behavior only: invalid arguments for a `delegate` tool that is
actually exposed in the current request become a recoverable tool failure with
a bounded compression instruction. The failed call creates no child and
consumes no one-shot slot. The 4,000-character limit, corpus, prompts, model,
budgets, arm order, trial count, verifiers, and acceptance thresholds are
unchanged.

V2 ran the complete 12-arm window once from `dd51689`:

| Metric | Result |
| --- | ---: |
| Control harness + task verifier | 6/6 |
| Treatment harness | 6/6 |
| Treatment task verifier | 4/6 |
| Treatment exactly-one-child selection | 6/6 |
| Completed child handoff with non-empty final text | 6/6 |
| Cost overshoot | 0/12 |
| Full reread of every child-observed path | 0/6 |
| Observable report cost | `$0.0781459728` |

Both failures confused a configured 300-second limit with related 240-second
samples even though the child handoff stated both correctly. All 6 child final
messages exceeded the 4,000-character projection bound and were truncated.
Full evidence is retained under `artifacts/v2/`.

## V3 — passed

V3 keeps the v2 runtime, corpus, tasks, provider/model, budgets, ordering,
trials, verifiers, and acceptance gate unchanged. The only change is the
handoff prompt contract:

- child starts with the direct answer or requested structured output;
- child keeps the final message below 4,000 characters and omits bulk source,
  logs, CSV rows, and repeated evidence; and
- main changes a child-reported fact only for direct contradictory evidence
  about that same fact, not a related measurement.

V3 ran all 12 arms once from `093ae6e` and passed:

| Metric | Result |
| --- | ---: |
| Control harness + task verifier | 6/6 |
| Treatment harness + task verifier | 6/6 |
| Treatment exactly-one-child selection | 6/6 |
| Completed child handoff with non-empty final text | 6/6 |
| Distinct child identities | 6/6 |
| Cost overshoot | 0/12 |
| Full reread of every child-observed path | 0/6 |
| Observable report cost | `$0.074461408` |

Five child final messages stayed below the admitted bound; one was safely
truncated and still verified. Full raw evidence and checksums are retained
under `artifacts/v3/`. Slice 1.6's explicit single-child completion gate is
therefore satisfied. This does not establish autonomous selection, parallel
speedup, or lower cost.
