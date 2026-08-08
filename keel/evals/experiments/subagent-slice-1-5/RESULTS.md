# Subagent Slice 1.5 Results

## Decision

**Pause** as of 2026-08-09. Keep `--experimental-agents` default-off and do
not start #590 Slice 2a.

The runtime safety baseline held, and the model avoided delegation on every
negative control. However, it selected no child for either eligible ordinary
workspace task. The scored run therefore has no positive evidence-handoff
sample and cannot justify investing in multi-child concurrency.

- Owner: `@acmerfight`
- Review date: 2026-09-09
- Experiment expiry: 2026-11-09
- Expiry action: repeat next-slice triage using new product-demand evidence;
  remove the experimental surface or record Stop if no evidence supports a
  new, pre-registered calibration.

## Authoritative run

| Field | Value |
| --- | --- |
| Experiment | `subagent-slice-1-5-v4` |
| Freeze commit | `f6f069d663d9b1142a0d0c449ce4617dff4d3033` |
| Provider / model | DeepSeek / `deepseek-v4-flash` |
| Window | one uninterrupted run on 2026-08-09 |
| Trials | 3 paired trials for each of 6 tasks; 36 arms total |
| Result JSONL | [`artifacts/v4/results.jsonl`](artifacts/v4/results.jsonl) |
| Result SHA-256 | `a09d814e1e382116e0edbda679ddf9c489ccd8c4695889212a5bce3308a596b1` |
| Provider-visible transcripts | [`artifacts/v4/transcripts/`](artifacts/v4/transcripts/) |
| Per-file checksums | [`artifacts/v4/MANIFEST.sha256`](artifacts/v4/MANIFEST.sha256) |

All 36 harness arms completed, all 36 semantic task verifiers passed, every
report stop reason was `completed`, and cost overshoot was zero. The full suite
gate was 12/18 because all six eligible treatments failed selection.

## Selection evidence

| Corpus role | Observed | 95% Wilson interval | Gate |
| --- | ---: | ---: | --- |
| Eligible ordinary tasks selected one child | 0/6 | 0.0%–39.0% | Fail; required 6/6 |
| Ineligible tasks made a false child call | 0/9 | 0.0%–29.9% | Pass; required 0/9 |
| Duplicate inducement stayed at or below one child | 3/3 | 43.9%–100.0% | Pass; required 3/3 |

These are curated-corpus rates, not production precision. The duplicate task
created one distinct child in each treatment. Both ordinary eligible tasks
created zero children in every treatment even though their artifacts verified.

The positive-delegation evidence rubric is not applicable: there were 0/6
actual positive delegations, so there is no child evidence-handoff sample to
grade. In the duplicate inducement, main did synthesize after the child and
retained root budget, but that explicitly prompted task is not evidence that
ordinary eligible prompts select delegation.

## Outcome and resources

| Condition | Harness | Task verified | Cost | Input tokens | Output tokens | Wall time | Unspent root budget |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Control | 18/18 | 18/18 | $0.038314 | 1,090,295 | 26,841 | 231.423 s | $0.306686 |
| Treatment | 18/18 | 18/18 | $0.040597 | 1,055,783 | 29,858 | 257.899 s | $0.304403 |

Treatment used $0.002283 more, 34,512 fewer input tokens, 3,017 more output
tokens, and 26.476 seconds more in aggregate. These totals include the three
serial child runs in the duplicate inducement and normal provider variation;
they are not interpreted as evidence for or against parallel speedup. Every
arm retained at least $0.009142 of root budget.

## Reliability evidence

The deterministic Slice 1 reliability suites passed 30/30 tests:

- `tests/agent/subagent-supervisor.test.ts`
- `tests/cli/main/subagent-delegation.test.ts`

They cover provider failure classification, authority enforcement, child and
root budget admission, same-call replay/accounting, false completion,
cancellation settlement, and a real CLI-process Ctrl-C path. The scored cloud
window additionally observed 36/36 completed harnesses, zero cost overshoot,
zero missing reports, and zero unavailable selection observations.

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

Version 4 narrowed the unresolved-decision negative control to facts its
deterministic workspace verifier can observe, then reran all 36 arms. The
stable 0/6 eligible selection observation across all four complete windows
supports Pause, while only v4 task outcomes are used for the authoritative
decision gate.

## Limits and restart condition

This is a small, single-provider, single-model, single-child experiment. It
does not measure production base rates, multi-child parallel value, durable
delivery, or write-agent behavior. A new experiment should start only when
real Keel usage supplies repeated independent investigation demand or a scoped
selection change is proposed. It must use a new pre-registered version and
must not weaken the existing authority, budget, lifecycle, or negative-control
gates.
