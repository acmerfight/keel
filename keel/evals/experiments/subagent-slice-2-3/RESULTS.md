# Stable Agent Policy — Slice 2.3 Results

Decision: **graduate the stable `off|explicit|auto` policy surface and continue
the Subagent Epic**.

The final V3 DeepSeek window passed its complete frozen gate: 12/12 arms
verified, positive selection 3/3, negative selection 3/3, seven distinct
completed children, zero retries, and zero cost overshoot. A short ordinary
request — `使用 subagent 调研这个任务。` — was sufficient under `explicit`; it did
not prescribe a tool name, child count, or partition. The same policy selected
zero children for the small task that did not ask for delegation.

V1 revealed that an exact-one selection gate was obsolete after multi-child
orchestration: every positive treatment reasonably split the two independent
packages into two children. V2 corrected that eval-only contract, then exposed
a general output-contract fidelity failure in one of three positive
treatments. V3 added one general prompt rule preserving user field meanings,
units, and output contracts across child task construction and final synthesis;
the full rerun passed.

The positive treatments remained materially slower and more expensive than
the controls in this serial corpus: `$0.0232953560` vs `$0.0102877824`, with
71.253 seconds vs 22.070 seconds median wall time. All three positive mains also
reread some child-covered evidence. Those facts prevent claims that subagents
are cheaper, faster, or eliminate duplicate investigation. They do not negate
the explicit user-directed product path, where the user chose the extra cost.
`auto` remains a separate opt-in and is not promoted to a default by this
result.

Raw evidence and checksums are preserved under `artifacts/v1/`,
`artifacts/v2/`, and `artifacts/v3/`.
