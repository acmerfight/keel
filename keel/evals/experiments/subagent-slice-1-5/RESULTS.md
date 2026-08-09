# Subagent Slice 1.5 Results

## Decision

**Continue explicit user-directed subagent development** as of 2026-08-09,
while keeping autonomous selection paused and the feature default-off.

The runtime safety baseline held, and the model avoided delegation on every
negative control. It selected no child for either eligible ordinary workspace
task when the user did not mention subagents, so v5 still supports **Pause** for
autonomous delegation selection.

The product requirement was subsequently narrowed: explicit user intent is
sufficient because subagent cost is expected. A separately frozen supplement
using only the prefix `使用 subagent 调研这个任务。` selected one child in 6/6
treatments. Its treatment artifacts verified only 2/6, so the next slice must
harden the single-child completion and main-synthesis path before concurrency.
See
[`subagent-explicit-intent-v1/RESULTS.md`](../subagent-explicit-intent-v1/RESULTS.md).

## Autonomous-selection run

| Field | Value |
| --- | --- |
| Experiment | `subagent-slice-1-5-v5` |
| Freeze commit | `f48b512df2861087e58cb2b68436ccff9bbc46e7` |
| Provider / model | DeepSeek / `deepseek-v4-flash` |
| Window | one uninterrupted run on 2026-08-09 |
| Trials | 3 paired trials for each of 6 tasks; 36 arms total |
| Result JSONL | [`artifacts/v5/results.jsonl`](artifacts/v5/results.jsonl) |
| Result SHA-256 | `5f3c6922596cecbafe669a3cbad9494688a0171399c56efca5cb814a2bafdd10` |
| Main provider-visible transcripts | [`artifacts/v5/transcripts/`](artifacts/v5/transcripts/) |
| Child provider-visible transcripts | [`artifacts/v5/child-transcripts/`](artifacts/v5/child-transcripts/) |
| Per-file checksums | [`artifacts/v5/MANIFEST.sha256`](artifacts/v5/MANIFEST.sha256) |

All 36 harness arms completed and 35 semantic task verifiers passed. One
eligible treatment stopped at budget admission before writing its artifact;
its report truthfully records `cost_budget`, `verify_failed`, and 0 child runs.
Cost overshoot was zero. The full suite gate remained 12/18 because all six
eligible treatments failed selection.

## Selection evidence

| Corpus role | Observed | 95% Wilson interval | Gate |
| --- | ---: | ---: | --- |
| Eligible ordinary tasks selected one child | 0/6 | 0.0%–39.0% | Fail; required 6/6 |
| Ineligible tasks made a false child call | 0/9 | 0.0%–29.9% | Pass; required 0/9 |
| Duplicate inducement stayed at or below one child | 3/3 | 43.9%–100.0% | Pass; required 3/3 |

These are curated-corpus rates, not production precision. The duplicate task
created one distinct child in each treatment. Both ordinary eligible tasks
created zero children in every treatment; five of their six artifacts verified,
while one treatment stopped safely at budget admission before writing one.

The positive-delegation evidence rubric is not applicable: there were 0/6
actual positive delegations, so there is no child evidence-handoff sample to
grade. In the duplicate inducement, main did synthesize after the child and
retained root budget, but that explicitly prompted task is not evidence that
ordinary eligible prompts select delegation.

## Outcome and resources

| Condition | Harness | Task verified | Cost | Input tokens | Output tokens | Wall time | Unspent root budget |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Control | 18/18 | 18/18 | $0.037798 | 1,030,260 | 27,982 | 263.137 s | $0.307202 |
| Treatment | 18/18 | 17/18 | $0.040977 | 1,041,944 | 32,740 | 298.136 s | $0.304023 |

Treatment used $0.003179 more, 11,684 more input tokens, 4,758 more output
tokens, and 34.999 seconds more in aggregate. These totals include the three
serial child runs in the duplicate inducement and normal provider variation;
they are not interpreted as evidence for or against parallel speedup. Every
arm retained at least $0.009124 of root budget.

## Reliability evidence

The deterministic Slice 1 reliability suites passed 30/30 tests:

- `tests/agent/subagent-supervisor.test.ts`
- `tests/cli/main/subagent-delegation.test.ts`

They cover provider failure classification, authority enforcement, child and
root budget admission, same-call replay/accounting, false completion,
cancellation settlement, and a real CLI-process Ctrl-C path. The scored cloud
window additionally observed 36/36 completed harnesses, 35 completed agent
runs, one safe budget-admission stop, zero cost overshoot, zero missing
reports, and zero unavailable selection observations.

## Superseded experiment versions

No inspected output was overwritten or selectively rerun.

- `v1`, freeze `38fc84c`: excluded because two verifiers required values not
  specified by their prompts. JSONL SHA-256:
  `e3d2295dabdd0b04fa3128f68fce56be02b76eddcb35c7bd26f78cbd40881898`.
- `v2`, freeze `61eaf23`: excluded because a natural-language release-gap
  field still had a narrower phrase recognizer than its prompt. JSONL SHA-256:
  `b044468b53563dba2c8061fa1a1c141313c65a10843f4f7d404ee47a1cecd52c`.
- `v3`, freeze `141068e`: excluded because the user-feedback prompt required a
  user-facing question that its workspace-only verifier could not observe.
  JSONL SHA-256:
  `ebc6bb3dd810a79256d52ad0a4c40e2f83d79a59cfb0b0c7b9a7d9d597187a88`.
- `v4`, freeze `f6f069d`: excluded because the user-feedback prompt still
  required file inspection and prohibited proposing a mode, neither of which
  its workspace-only verifier could observe. JSONL SHA-256:
  `a09d814e1e382116e0edbda679ddf9c489ccd8c4695889212a5bce3308a596b1`.

Version 5 narrowed the unresolved-decision negative control to the only facts
its deterministic verifier grades: leave `policy.md` unchanged and create no
files. It then reran all 36 arms. The stable 0/6 eligible selection observation
across all five complete windows supports Pause for prompts that do not express
subagent intent, while only v5 outcomes are used for that autonomous-selection
gate.

## Limits and restart condition

This is a small, single-provider, single-model, single-child experiment. It
does not measure production base rates, multi-child parallel value, durable
delivery, or write-agent behavior. Autonomous selection requires a new scoped
proposal and a new pre-registered version; it is not required for explicit
user-directed development. Any follow-up must preserve the existing authority,
budget, lifecycle, and negative-control gates.
