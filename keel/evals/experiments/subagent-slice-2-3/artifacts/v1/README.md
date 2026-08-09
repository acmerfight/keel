# Slice 2.3 scored window v1

This directory preserves the complete first scored window for the stable
`explicit` agent policy.

- Candidate commit: `903601a6dc297ad094b764ddea58d02762450902`
- Date: 2026-08-09
- Provider/model: DeepSeek / `deepseek-v4-flash`
- Corpus: 2 tasks x 3 paired trials, 12 arms
- Results: `results.jsonl`
- Main transcripts: `main-transcripts/`
- Child canonical transcript artifacts: `child-transcripts/`

The exact invocation was:

```bash
node --experimental-strip-types src/cli/index.ts eval \
  --suite evals/experiments/subagent-slice-2-3/tasks \
  --provider deepseek \
  --model deepseek-v4-flash \
  --trials 3 \
  --out /tmp/keel-subagent-slice-2-3.jsonl \
  --transcript-dir /tmp/keel-subagent-slice-2-3-transcripts
```

The command exited 1 without selective reruns. All 12 arms completed and
verified. Each positive treatment selected two distinct completed children,
one for payments and one for identity; each negative treatment selected zero.
The frozen `require_one` gate rejected the positive treatments only because it
required exactly one child. That expectation was obsolete after Slice 2.2
introduced multi-child orchestration, so V2 adds a general `require_any` eval
policy and reruns the complete window without changing production behavior.

There were zero retries and zero cost overshoots. Positive controls cost
`$0.0101737272` with a 27.058-second median; positive treatments cost
`$0.0260060864` with a 66.889-second median. Negative controls cost
`$0.0023414216`; negative treatments cost `$0.0026465600`. Total observable
cost was `$0.0411677952`.

All three positive mains reread decisive payment and identity files after both
children returned. This preserves the pre-registered duplicate-work diagnostic
without turning it into a case-specific runtime rule.
