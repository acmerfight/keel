# Explicit Subagent Intent Calibration v1 Results

## Decision

**Continue explicit user-directed subagent development** as of 2026-08-09.

With `--experimental-agents` enabled, the exact sentence
`使用 subagent 调研这个任务。` selected one child in 6/6 treatment trials. This
answers the clarified continuation question. It does not overturn v5's 0/6
result for autonomous selection, make the feature default-on, or establish that
the current end-to-end behavior is release-ready.

The immediate next slice must harden the existing single-child path before
multi-child concurrency: only 2/6 treatment artifacts verified and only 2/6
children returned a valid completed result.

## Authoritative run

| Field | Value |
| --- | --- |
| Experiment | `subagent-explicit-intent-v1` |
| Freeze commit | `c00cf08139c39a11f01e9477434ea164b1f7b245` |
| Provider / model | DeepSeek / `deepseek-v4-flash` |
| Window | one uninterrupted run on 2026-08-09 |
| Trials | 3 paired trials for each of 2 tasks; 12 arms total |
| Result JSONL | [`artifacts/v1/results.jsonl`](artifacts/v1/results.jsonl) |
| Result SHA-256 | `8e3d736aafe640c628a79faa0b02ab267efbdcc99c0966618df1365cf4f61204` |
| Main provider-visible transcripts | [`artifacts/v1/transcripts/`](artifacts/v1/transcripts/) |
| Child provider-visible transcripts | [`artifacts/v1/child-transcripts/`](artifacts/v1/child-transcripts/) |
| Per-file checksums | [`artifacts/v1/MANIFEST.sha256`](artifacts/v1/MANIFEST.sha256) |

The eval command exited 1 because the general `delegation_pair` suite gate
requires treatment task verification in addition to selection. That exit is
retained and explained; it is not relabeled as a harness or selection failure.

## Selection and outcome

| Observation | Result | 95% Wilson interval |
| --- | ---: | ---: |
| Treatment selected exactly one child | 6/6 | 61.0%–100.0% |
| Treatment child returned `completed` | 2/6 | 9.7%–70.0% |
| Control semantic task verified | 6/6 | 61.0%–100.0% |
| Treatment semantic task verified | 2/6 | 9.7%–70.0% |
| Harness completed | 12/12 | — |

Both tasks selected one child in 3/3 treatments. All controls verified.
`explicit-service-review` treatments verified 2/3; `explicit-release-audit`
treatments verified 0/3.

Four child runs ended as `failed` because DeepSeek produced invalid
`submit_agent_result` arguments. The host reported those failures truthfully;
none was converted to `completed`. Three main runs then attempted a second
delegation, which the one-child admission boundary rejected without creating a
second child. The other two children returned bounded, path-based evidence.

Four treatments ended with `cost_budget` when conservative admission rejected
the next main turn. They still had at least $0.033617 of their declared root
budget unspent by actual-cost accounting, and cost overshoot remained zero.
This is a synthesis-admission problem, not evidence that the provider spent the
entire declared dollar budget.

## Evidence handoff

The two completed child results both contained concrete paths, lines, values,
and risks, and main used them to produce verified `review.json` artifacts.
Handoff efficiency was inconsistent:

- in one verified treatment, main re-read 10 fixture files and issued four
  greps after receiving the child report, repeating most of the investigation;
- in the other, main read two files and issued four focused greps before
  writing, which is closer to bounded verification plus synthesis;
- the four failed children supplied no evidence, so main fell back to direct
  reads; conservative main-turn admission stopped those runs before a verified
  artifact was available.

The trigger result therefore supports continued development, while child
result conformance, synthesis reserve, and duplicate main investigation remain
open quality problems.

## Resources

| Condition | Harness | Task verified | Cost | Input tokens | Output tokens | Wall time |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Control | 6/6 | 6/6 | $0.029351 | 917,115 | 24,155 | 199.478 s |
| Treatment | 6/6 | 2/6 | $0.045536 | 799,308 | 53,432 | 538.863 s |

Treatment cost was 55.1% higher, output tokens 121.2% higher, and wall time
170.1% higher in this small serial experiment. Input tokens were 12.8% lower,
partly reflecting provider caching and shorter stopped runs. These figures are
diagnostic; they do not measure parallel value.

## Safety and scope

The unchanged deterministic Slice 1 reliability suites remain authoritative
for authority, budget, terminal-state, replay, and cancellation invariants.
The scored window observed zero cost overshoot, zero unavailable selection,
zero second child identity, zero false completion, and 12/12 completed
harnesses. The v5 negative controls remain applicable because this supplement
changed no production code or system prompt.

The next development slice should keep the feature default-off and single-child
while it:

1. makes DeepSeek child result submission reliably conform to the host schema;
2. reserves enough root capacity for main to admit synthesis and artifact
   writing after child completion or failure;
3. prevents an accepted child failure from prompting a futile second
   delegation under the one-child limit; and
4. reduces full main re-investigation when bounded child evidence is usable.

Only a new pre-registered run that closes those end-to-end failures should fund
two-child concurrency. Autonomous selection is not part of that requirement.
