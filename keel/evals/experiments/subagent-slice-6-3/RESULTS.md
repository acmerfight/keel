# Subagent orchestration graduation — Slice 6.3 V2 results

Decision: **do not graduate issue #590 and do not ship the attempted prompt
change**. Preserve the reliable explicit user-directed product, keep `auto`
opt-in and default-off, and leave Runtime authority and lifecycle unchanged.

The protocol was frozen at
`0082dc7aeccedc4031744fac3073f927f0389689`. The only production change in the
scored candidate `886dadb0d1d2c9d319e4a7e48b3931febe0e745c` was a general Main
decomposition/synthesis contract: decide separable scopes before substantial
investigation, assign distinct scopes, coordinate delegated work, and limit
verification to identified uncertainty. The complete DeepSeek window ran once
on 2026-08-13 without intervention or selective reruns.

All 30 arms completed and passed their deterministic workspace verifier, but
the selection gate failed:

- auto selected zero children in both positive domains: 0/3 release and 0/3
  service;
- explicit selected multiple children in 2/3 release trials and 3/3 service
  trials, for 5/6 positive trials overall; and
- auto correctly selected zero children in the small sequential negative in
  3/3 trials.

The attempted prompt therefore did not change the two V1 failures that mattered
most: DeepSeek still did the eligible `auto` investigations itself, and the
explicit release task still combined both scopes into one broad child once.

## Per-task metrics

| Task / arm | Verified | Completed child Runs | Median Main turns | Median input tokens | Median wall time | Aggregate cost |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| auto release control | 3/3 | n/a | 8 | 88,654 | 24.175s | $0.0095590 |
| auto release treatment | 3/3 | 0 / 0 / 0 | 8 | 101,026 | 22.678s | $0.0101397 |
| auto service control | 3/3 | n/a | 8 | 165,620 | 32.111s | $0.0179638 |
| auto service treatment | 3/3 | 0 / 0 / 0 | 7 | 162,878 | 25.142s | $0.0172618 |
| auto sequential control | 3/3 | n/a | 5 | 22,539 | 5.195s | $0.0022965 |
| auto sequential treatment | 3/3 | 0 / 0 / 0 | 5 | 27,828 | 5.739s | $0.0028467 |
| explicit release control | 3/3 | n/a | 7 | 94,659 | 22.866s | $0.0101936 |
| explicit release treatment | 3/3 | 2 / 1 / 2 | 7 | 108,757 | 64.163s | $0.0214840 |
| explicit service control | 3/3 | n/a | 8 | 192,013 | 31.589s | $0.0178704 |
| explicit service treatment | 3/3 | 2 / 2 / 2 | 8 | 280,651 | 108.779s | $0.0476732 |

Across the six explicit positives, the pre-registered aggregate medians were 8
versus 7 Main turns, 134,877.5 versus 147,464 input tokens, and 29.007s versus
85.214s wall time; aggregate treatment cost was 146% higher. Gate 4's frozen
rule therefore mechanically passed on Main turns. The apparent one-turn
aggregate improvement is not a within-domain improvement: release was 7 versus
7 and service was 8 versus 8. Mixing the two task distributions moved the
combined median. Future value gates should use per-task medians or paired
normalized deltas rather than treating this aggregate artifact as product
value.

The six auto positive treatments had slightly lower aggregate medians than
their controls, but they created no child. That movement is ordinary sampling
noise between two Main-only paths and cannot be attributed to subagents. It
also mechanically satisfies the frozen value subcriterion, without proving
subagent value.

## Transcript review

All six explicit Mains repeated some completed child-owned evidence after the
foreground results:

- release trial 1 and trial 3 used two correctly separated children, then Main
  re-counted both audit files and reread the API/config/rollback/release files;
- release trial 2 assigned both packages to one catch-all child, then Main read
  the decisive documents and counts again;
- service trial 1 used two separated children, then Main reread all twelve
  source files before writing the result; and
- service trials 2 and 3 legitimately completed scopes whose children failed,
  but also reread evidence returned by the children that had completed.

The stronger contract changed the model's explanation — it repeatedly called
the work "targeted verification" — but not the observable breadth of the
follow-up investigation. Keel does not infer semantic trust from read traces or
add a runtime prohibition in response.

The service holdout also exposed over-broad child return contracts. In trials 2
and 3 an initial child ended with provider `length`; Main responded by launching
progressively smaller children. Across all explicit treatments the report
contains 21 terminal child Runs: 11 completed, 2 failed on provider length, and
8 were budget-limited before a provider request. Service trial 3 reached the
existing eight-child root limit, then Main completed the missing evidence
itself. This is safe settlement, but poor orchestration value.

## Runtime reliability

- 30/30 harness arms completed and 30/30 deterministic verifiers passed.
- Human interventions: 0.
- Root cost overshoot: $0 across every arm.
- Observable total cost: $0.157288544.
- 278 physical provider requests completed in one attempt each; provider
  retries: 0.
- Eight additional model-operation records were admission rejections for
  budget-limited children and made no provider request.
- Every observed child was terminal; no queued/running orphan, duplicate
  delivery, false terminal, or authority bypass was observed.
- Provider/model: DeepSeek / `deepseek-v4-flash` only.

The result strengthens the V1 attribution: the remaining blocker is model
orchestration quality under this provider/model, not missing Runtime authority,
lifecycle, persistence, or accounting. Adding more mandatory Runtime cases
would not address it.

## Product decision

The candidate prompt was reverted before the PR because the harness change did
not earn its way into the product. The retained V2 experiment is evidence
against repeatedly tuning the same wording on the same fixtures. Any future
attempt should either test a materially different, generally justified model
or orchestration contract on held-out tasks, or revise the product claim to the
reliable explicit path while keeping autonomous delegation experimental. It
must not add a keyword router, forced child count, read receipt, or runtime ban
on verification.

Raw results, all 30 Main transcripts, command metadata, and checksums are under
[`artifacts/v2/`](artifacts/v2/). The Main transcripts retain the complete
bounded child receipts and final texts. The isolated eval runner did not export
the canonical child transcript artifacts before cleaning each arm's temporary
state, so those separate files are not claimed as retained evidence.
