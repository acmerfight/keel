# Stable Agent Policy — Slice 2.3

This is the pre-registered real-provider window for issue #590 Slice 2.3. It
asks whether the stable `explicit` policy recognizes an ordinary, short user
request to use a subagent while leaving the same capability unused for a small
task that does not request delegation.

The window does not decide whether `auto` should become a default. `auto`
remains an explicit opt-in whose broader value is evaluated separately. It also
does not turn repeated main investigation into a runtime failure: repetition is
reported as a model-quality, latency, and cost diagnostic.

## Frozen protocol

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
  --out /tmp/keel-subagent-slice-2-3.jsonl \
  --transcript-dir /tmp/keel-subagent-slice-2-3-transcripts
```

## Corpus and budgets

| Task | Policy expectation | Per-arm root max cost |
| --- | --- | ---: |
| `explicit-release-audit` | exactly one child | $0.04 |
| `explicit-small-doc-fix` | no child | $0.01 |

The positive prompt begins only with `使用 subagent 调研这个任务。`; it does not
name a tool, exact child task, or partition. The negative prompt is a single
small edit and does not ask for delegation. Both use the same stable `explicit`
policy so the result measures semantic user intent rather than keyword routing.

## Pre-registered acceptance gate

The Slice 2.3 window passes only if all of the following hold:

- all 12 arms complete and pass their deterministic task verifiers;
- all 3 positive treatments select exactly one distinct completed child;
- all 3 negative treatments select no child;
- no treatment exceeds its root cost budget or leaves live child work; and
- no authority bypass, duplicate child, duplicate delivery, or false terminal
  state is observed.

For every positive treatment, inspect the child conclusion and the subsequent
main transcript for obvious repeated investigation. Report repetition,
wall-clock time, tokens, and cost for both arms, but do not change this frozen
gate after viewing results and do not add a case-specific runtime prohibition.

