# Slice 1.6 scored window v4

This directory preserves the complete v4 scored window. V4 was run after the
continuation lease began pricing the provider-shaped assistant and bounded tool
result envelopes. The budget fix held, but the window failed the task-quality
gate and therefore was not selectively rerun.

- Candidate commit: `a8b294984d6ae786b911d8e6312b765fa103f3a3`
- Date: 2026-08-09
- Provider/model: DeepSeek / `deepseek-v4-flash`
- Corpus: 2 frozen tasks x 3 paired trials, 12 arms
- Results: `results.jsonl`
- Main transcripts: `main-transcripts/`
- Child canonical transcript artifacts: `child-transcripts/`

The exact invocation was:

```bash
node --experimental-strip-types src/cli/index.ts eval \
  --suite evals/experiments/subagent-slice-1-6/tasks \
  --provider deepseek \
  --model deepseek-v4-flash \
  --trials 3 \
  --out /tmp/keel-subagent-slice-1-6-v4.jsonl \
  --transcript-dir /tmp/keel-subagent-slice-1-6-v4-transcripts
```

The command exited 1 under the suite's normal gate semantics. All 12 arms
completed; controls verified 6/6 and treatments verified 4/6. Every treatment
selected exactly one distinct child, and all six child handoffs were
`status=completed` with non-empty final text, 12 observed resources, and no
cost overshoot or second child. Three handoffs were projected to the 4,000
character bound.

Both failures were in `explicit-release-audit`. In trial 2 the child correctly
distinguished the configured 300-second policy from observed 240-second audit
samples, but main reread the evidence and substituted the sample measurement.
In trial 3 the child itself made that substitution in its field summary and
main retained it. This recurred after v2 and is a named-fact synthesis failure,
not a child terminal, budget-lease, or result-delivery failure. It motivated a
general prompt contract: requested fields use their defining artifact, while
configured or declared values remain distinct from observations, examples, and
samples.

The six controls cost `$0.0287829192` in total with a 29.665-second wall-time
median. The six treatments cost `$0.0547958152` with a 76.691-second median.

## Child transcript mapping

| Task/trial | Main `transcriptRef` | Preserved child transcript |
| --- | --- | --- |
| release audit / 1 | `tool-output:run-53cd0a86-34e2-4f4d-9dd0-0bc9dac473f1/2e98eb61-9f5a-4dcf-9f82-d7cbbbd86f93` | `explicit-release-audit-trial-1.txt` |
| release audit / 2 | `tool-output:run-345bf56f-670b-4e98-a112-346a4ce47ac7/603a59de-31cd-4e02-803b-09f37bd25e09` | `explicit-release-audit-trial-2.txt` |
| release audit / 3 | `tool-output:run-684c2642-9128-4967-a386-058d20fd032c/d4d01343-9e2c-4d9b-97f3-5016c1eef3c8` | `explicit-release-audit-trial-3.txt` |
| service review / 1 | `tool-output:run-309e23d5-bd59-4b24-89c7-5ff80126ef42/593ab01f-16bc-449b-935d-4f886219f94f` | `explicit-service-review-trial-1.txt` |
| service review / 2 | `tool-output:run-9a7a44d4-9ac3-4ca0-8ab1-550e80f94d6d/800e26d2-647f-4c07-95f6-b115b6d806d9` | `explicit-service-review-trial-2.txt` |
| service review / 3 | `tool-output:run-a6a01f1e-62c0-42cc-96ac-0ee07b449e35/ba3b1f78-d767-4c1e-9da1-f52c740978af` | `explicit-service-review-trial-3.txt` |
