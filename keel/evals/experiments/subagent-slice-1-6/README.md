# Explicit Subagent Completion Reliability — Slice 1.6

This is the pre-registered completion-reliability window for issue #590 Slice
1.6. It asks a narrower question than autonomous delegation selection: after
the exact explicit prefix `使用 subagent 调研这个任务。` selects the experimental
feature, can one foreground read-only child finish normally and hand enough
bounded context back for main to complete the same task?

The corpus began as a mechanical copy of the two frozen explicit-intent v1
fixtures. V1 through v5 retain their exact committed inputs and evidence. V6
clarifies one ambiguous service-review field after v5 showed that both
`account_id` and `request_id` satisfied the old undirected wording. The
workspace, solution, verifier, budgets, provider/model, and arm order remain
unchanged. V7 reran the original completion gate from the reviewed budget
candidate. V8 is the final simplification window required by the revised issue:
it removes read-specific evidence from the handoff while retaining the generic
terminal, budget, lifecycle, and transcript contracts.

## Scored windows

Slice 1.6 v1 ran from commit `714abd9f`. It failed the frozen gate when one of
six treatments emitted a `delegate.task` beyond the 4,000-character schema
bound and the provider treated validation as fatal. The other five treatments
completed and verified. Raw evidence remains under `artifacts/v1/`; that window
was not selectively rerun.

V2 ran from `dd51689`. All 12 arms completed; controls verified 6/6, treatments
selected and completed one child 6/6, but treatment task verification was only
4/6. All six child final messages exceeded the 4,000-character projection
bound. The two failures confused a configured value with a related sample
measurement despite correct child evidence. Raw evidence remains under
`artifacts/v2/`; the window was not selectively rerun.

V3 ran from `093ae6e` after one prompt-only handoff change: child final messages
put the direct answer first, stay under the existing 4,000-character bound, and
omit bulk source/log copying; main changes a reported fact only when direct
evidence for that same fact contradicts it. It passed the unchanged gate: all
12 arms completed and verified, all 6 treatments selected exactly one child,
and all 6 child handoffs were completed with non-empty final text. Raw evidence
is retained under `artifacts/v3/`.

V4 ran from `a8b2949` after continuation admission began pricing the complete
provider-shaped assistant and worst-case bounded tool-result envelopes. All
children completed and budget invariants held, but treatment task verification
was 4/6 because the configured-value/sample-value confusion recurred. Raw
evidence remains under `artifacts/v4/`; the window was not selectively rerun.

V5 ran from `3e456f1` after a general named-fact prompt rule. The recurring
release-audit case verified 3/3, and overall treatment verification was 5/6.
The sole failure answered `account_id` for an undirected
`missingCorrelationField`; the verifier expected `request_id`, while both were
missing from one side of the two audits. Raw evidence remains under
`artifacts/v5/`. V6 changes only that fixture wording to say the field must be
present in the API request audit and absent from the worker delivery audit.

V6 ran from `2dd1851` and passed the full gate: all 12 arms completed and
verified, every treatment selected exactly one distinct completed child, no
cost overshoot or second child occurred, and no main fully reread all
child-covered paths. Raw evidence is retained under `artifacts/v6/`.

V7 ran from `0cfae78` after review required delegate-only tool turns, finalized
request-shape pricing, a root-held continuation reservation, and finalized
minimum-child admission. It passed all 12 arms: controls 6/6, treatments 6/6,
and exactly one distinct completed child 6/6. One treatment fully reread all 12
child-covered paths; this retained duplicate-work diagnostic does not alter the
pre-registered completion gate. Raw evidence is retained under `artifacts/v7/`.

V8 ran once from `3313988` after Step 1 removed `observedResources`,
read-specific handoff logic, and case-specific verification prompt rules. It
passed all 12 arms: controls 6/6, treatments 6/6, and exactly one distinct
completed child 6/6. No treatment handoff contained `observedResources`. All
six mains still performed some read/search work after the child returned, so
the simpler generic protocol is accepted without claiming that it eliminates
duplicate investigation. Raw evidence is retained under `artifacts/v8/`.

## Final v8 protocol

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
- Task grading: the deterministic workspace verifiers.
- Child completion grading: inspect each treatment transcript's `delegate`
  result and require `status=completed`; do not infer completion merely from a
  child model operation or a distinct child ID.
- Duplicate-work diagnostic: inspect the child final/transcript and subsequent
  main transcript for obvious repetition. Report it qualitatively with cost and
  latency; do not add a read-specific receipt, infer semantic completeness from
  tool calls, or turn repetition into a runtime rule.
- Sampling: run the command below once from the exact committed candidate. Do
  not selectively rerun failed samples.
- Evidence: retain result JSONL, all available main transcripts, extracted
  child transcripts, command metadata, and SHA-256 checksums under the scored
  window's `artifacts/vN/` directory. A crash before report creation is retained
  as an explicit absence, not replaced by a synthetic transcript.

```bash
node --experimental-strip-types src/cli/index.ts eval \
  --suite evals/experiments/subagent-slice-1-6/tasks \
  --provider deepseek \
  --model deepseek-v4-flash \
  --trials 3 \
  --out /tmp/keel-subagent-slice-1-6-v8.jsonl \
  --transcript-dir /tmp/keel-subagent-slice-1-6-v8-transcripts
```

## Corpus and budget

| Task | Independent scopes | Per-arm root max cost |
| --- | --- | ---: |
| `explicit-service-review` | `services/api/`, `services/worker/` | $0.06 |
| `explicit-release-audit` | `packages/payments/`, `packages/identity/` | $0.04 |

## Pre-registered acceptance gate

The implementation-attributable product gate passes only if all of the
following hold in the one scored window:

- all 6 treatment arms select exactly one distinct child;
- a normal, non-truncated child final is handed off as `status=completed` with a
  non-empty bounded `finalText`; provider length/error remains an honest failure
  instead of being relabeled for the score;
- no authority bypass, cost overshoot, false completion, second child, or
  orphaned child is observed; and
- the deterministic Slice 1 regression suites remain green.

Control and treatment semantic success, duplicate investigation, cost, tokens,
and wall time are reported in full. The control is an attribution baseline, not
a runtime invariant. Any failure is first attributed to runtime, harness,
generic prompt/protocol, provider, or model variance. A reproducible failure in
the generic mechanism blocks the slice; an isolated provider/model event is
retained without a case-by-case runtime rule. The generic eval command still
exits non-zero when a required treatment fails its ordinary verifier, and no
failed sample is selectively rerun.
