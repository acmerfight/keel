# Subagent orchestration graduation — Slice 6.3

This is the pre-registered V2 real-provider window for issue #590. It changes
one product behavior: Main should decompose eligible independent scopes before
substantial investigation, then coordinate and synthesize delegated work
without broadly repeating it. Runtime authority, lifecycle, budget,
persistence, delivery, and workspace rules remain unchanged.

The protocol, corpus, prompts, provider/model, budgets, trial count, ordering,
metrics, and gate below are frozen before the production delegation prompt is
changed. The scored command runs once from the committed candidate. Failed
samples are retained and are not selectively rerun.

## Product BDD

```text
Given a task with two independent, context-heavy read-only scopes
When the user explicitly requests subagents, or opts into auto delegation
Then Main assigns the separable scopes to distinct children in one parallel round
And Main uses their results to produce the correct requested workspace artifact
And Main limits its own post-child work to synthesis, undelegated work, or targeted verification

Given one small dependent edit sequence
When the user opts into auto delegation
Then Main completes the task correctly without creating a child
```

## Protocol

- Experiment: `subagent-slice-6-3-v2`.
- Provider: DeepSeek.
- Model: `deepseek-v4-flash`.
- Trials: 3 paired trials for each of 5 tasks; 30 arms total.
- Conditions: `agentPolicy: off` control and the configured `explicit` or
  `auto` treatment.
- Pairing: both arms receive the same task prompt, root budget, base tools,
  model, and pristine workspace. Agent policy is the only capability delta.
- Order: odd trials run control first and even trials run treatment first.
- Task grading: deterministic workspace verifier only.
- Selection grading: treatment report only, independently from task outcome.
- Human intervention: none; any intervention is a gate failure.
- Sampling: run the command below once from the committed candidate.
- Evidence: retain result JSONL, all available main and child transcripts,
  command metadata, candidate commit, and SHA-256 checksums.

```bash
node --experimental-strip-types src/cli/index.ts eval \
  --suite evals/experiments/subagent-slice-6-3/tasks \
  --provider deepseek \
  --model deepseek-v4-flash \
  --trials 3 \
  --out /tmp/keel-subagent-slice-6-3-v2.jsonl \
  --transcript-dir /tmp/keel-subagent-slice-6-3-v2-transcripts
```

## Frozen corpus

| Task | Treatment | Selection gate | Per-arm root max cost | Provenance |
| --- | --- | --- | ---: | --- |
| `explicit-parallel-release-audit` | `explicit` | at least two distinct completed children | $0.04 | Slice 6.2 V1, unchanged |
| `auto-parallel-release-audit` | `auto` | at least two distinct completed children | $0.04 | Slice 6.2 V1, unchanged |
| `explicit-parallel-service-review` | `explicit` | at least two distinct completed children | $0.04 | Slice 1.5 independent-service fixture |
| `auto-parallel-service-review` | `auto` | at least two distinct completed children | $0.04 | Slice 1.5 independent-service fixture |
| `auto-sequential-doc-fix` | `auto` | zero children | $0.01 | Slice 6.2 V1, unchanged |

The release tasks preserve the exact V1 prompts and fixtures so their movement
is directly comparable. The service pair adds a different API/worker domain;
its explicit prompt adds only ordinary user intent and does not prescribe a
tool, child count, split, or profile. Both positive domains have two natural
top-level scopes. The negative remains one exact dependent edit.

## Acceptance gate

The V2 graduation window passes only if all of the following hold:

1. All 30 arms complete, pass their deterministic verifier, and use zero human
   interventions.
2. Every explicit and auto positive treatment creates at least two distinct
   terminal `completed` child Runs; every auto negative treatment creates none.
3. No treatment exceeds its root budget or shows an orphan, duplicate
   child/delivery, false terminal, authority bypass, or retry storm.
4. For each policy, its six positive treatments are non-inferior to controls on
   task success and improve at least one pre-registered aggregate median value
   signal: root `agentLoopTurns`, total input tokens, or wall time.
5. The sequential negative has no task-success, intervention, or selection
   regression.

Cost, output tokens, all three value signals, per-domain medians, and repeated
Main investigation are reported even when they are not gates. Transcript
review labels a post-child action as targeted verification only when it checks
a specific conflict, missing field, insufficient citation, or material
high-risk uncertainty. Re-reading or re-counting a child-owned scope without
such a reason is repeated investigation. This rubric is diagnostic rather than
a runtime rule or a substitute for the deterministic task verifier.

Passing V2 can satisfy #590's remaining product-value checkbox. It does not
make `auto` default-on or authorize wider background, writer, Bash, or nesting
modes. If V2 fails, the full result remains evidence; no keyword router,
case-specific dispatcher, read receipt, forced child count, or runtime ban on
verification may be added to repair individual samples.

## Scored result

V2 ran once from the frozen candidate and failed the overall graduation gate on
selection while all 30 task arms verified. The pre-registered aggregate-value
subcriterion mechanically passed, but its movement was not attributable to
subagents and did not establish attributable within-domain subagent value. The
attempted production prompt change was reverted after the window instead of
shipping an unproven harness change. The complete result and retained evidence
are in [`RESULTS.md`](RESULTS.md).
