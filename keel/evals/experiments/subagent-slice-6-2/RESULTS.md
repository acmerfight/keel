# Subagent product graduation — Slice 6.2 results

Decision: **do not mark issue #590 complete from this window**. Preserve the
reliable explicit user-directed path, keep `auto` opt-in and default-off, and do
not widen background, writer, Bash, or nesting modes.

The frozen V1 DeepSeek window ran once from candidate
`f129a611405f75208b54703954919cbe89169b0c` without selective reruns. All 18
arms completed and passed their deterministic task verifier with zero human
interventions, provider retries, cost overshoots, crashes, or timeouts. All 148
reported model operations completed with one physical attempt.

Runtime reliability was therefore intact, but the pre-registered selection and
value gates did not pass:

- explicit treatments all delegated and verified, but selected 2, 2, and 1
  distinct completed children; the third sample assigned both independent
  packages to one child, so multiple-child selection passed only 2/3;
- auto parallel treatments verified 3/3 but selected zero children in 3/3;
- auto sequential treatments verified 3/3 and correctly selected zero children
  in 3/3; and
- explicit treatment improved none of the three frozen median value signals.

## Metrics

| Task / arm | Verified | Child Runs | Median Main turns | Median input tokens | Median wall time | Aggregate cost |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| auto parallel control | 3/3 | n/a | 8 | 90,931 | 24.685s | $0.0099787408 |
| auto parallel treatment | 3/3 | 0 / 0 / 0 | 7 | 89,563 | 21.151s | $0.0097397944 |
| auto sequential control | 3/3 | n/a | 5 | 22,778 | 8.169s | $0.0024187520 |
| auto sequential treatment | 3/3 | 0 / 0 / 0 | 5 | 27,263 | 7.953s | $0.0028004088 |
| explicit parallel control | 3/3 | n/a | 7 | 97,157 | 26.369s | $0.0105099176 |
| explicit parallel treatment | 3/3 | 2 / 2 / 1 | 7 | 149,455 | 66.162s | $0.0229988192 |

Total observable cost was `$0.0584464328`.

The auto parallel arm's lower medians are not subagent value because it created
no child. The explicit arm had equal median Main turns, 54% more median input
tokens, 151% more median wall time, and 119% more aggregate cost. All three
explicit mains reread decisive child-covered files or counts after child
completion. Correctness remained 3/3, but this corpus supplies no measurable
subagent value under the frozen definition.

The sequential negative had no correctness, intervention, or selection
regression. Its treatment median was slightly faster, while aggregate cost was
about 16% higher and median input tokens were about 20% higher from exposing
the eligible capability. Those diagnostics remain inside the same fixed root
budget and do not change the functional negative conclusion.

## Failure attribution and next decision

The failed gates are model orchestration behavior, not a Runtime authority or
lifecycle defect:

- one explicit Main chose one broad child rather than two focused children;
- every auto Main chose to perform the parallel-appropriate audit itself; and
- every explicit Main substantially repeated the child's investigation before
  synthesis.

No case-specific dispatcher, keyword router, read receipt, forced child count,
or runtime prohibition is added in response. A future iteration should change
only a general decomposition/synthesis prompt or profile contract that can be
justified across tasks, then freeze and run a new complete window. Until such a
window proves value, the existing explicit path remains supported because the
user consciously requests its extra cost; `auto` is not promoted, default-on
delegation is not justified, and #590's final value checkbox remains open.

Raw JSONL, all 18 main transcripts, five complete child transcript artifacts,
command metadata, and SHA-256 checksums are retained under [`artifacts/v1/`](artifacts/v1/).

An empty-context review after the window found that the generic eval selector
could infer a completed child from an attributed provider operation even when
that child later failed or was aborted. Report schema 22 now carries the
invocation-owned child lifecycle snapshot, and selection counts only terminal
`completed` Runs. V1 was not selectively rerun: its five retained child
artifacts are complete, and the already-failed graduation decision cannot be
turned into a pass by this harness correction.
