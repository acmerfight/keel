# Harness Evals

`keel eval` measures keel's harness execution quality on real coding tasks
(ROADMAP P0-6). It exists to make the north-star claim falsifiable: a
change to the harness is good if and only if the numbers say so.

## How to run

```bash
# Validate the suite without spending tokens: every task's reference
# solution must pass its own verifier. Runs in CI on every PR.
keel eval --check

# Run the full suite against the configured provider (spends real money).
DEEPSEEK_API_KEY=... keel eval --trials 3 --out evals/results/$(date +%Y%m%d-%H%M%S).jsonl

# Iterate on one task.
keel eval --task fix-typo --trials 1 --out /tmp/one.jsonl
```

Defaults: `--suite evals/tasks`, `--trials 1`, `--out eval-results.jsonl`
(appends; gitignored).

## GitHub Actions

The `Keel Eval` workflow is intentionally manual (`workflow_dispatch`), not
a required PR check. It needs the `DEEPSEEK_API_KEY` repository secret, then
builds the CLI, runs the compiled `dist/cli/index.js`, prints a Markdown job
summary, and uploads the JSONL result file as an artifact:

1. Open **Actions → Keel Eval → Run workflow**.
2. Pick `trials` (positive integer, default `1`; use `3+` before making
   quality claims).
3. Optionally set `task` to run one task id.
4. Read the job summary for pass rate, turns, tokens, cost, and per-task
   outcomes.
5. Download the `keel-eval-results` artifact when you need the raw JSONL for
   comparison with prior runs.

## Reading results

Each trial appends one JSON line:

```json
{
  "schemaVersion": 1,
  "timestamp": "2026-06-13T02:11:09.123Z",
  "keelVersion": "0.0.1",
  "taskId": "fix-typo",
  "trial": 1,
  "pass": true,
  "outcome": "verified",
  "wallMs": 9182,
  "report": {
    "schemaVersion": 1,
    "provider": "deepseek",
    "model": "deepseek-v4-flash",
    "turns": 3,
    "stopReason": "completed",
    "usage": { "inputTokens": 5210, "cachedInputTokens": 4100, "uncachedInputTokens": 1110, "outputTokens": 240 },
    "durationMs": 8455,
    "costUsd": 0.000234
  }
}
```

- `outcome` separates harness failures from graded failures: `verified` /
  `verify_failed` are the agent's score; `timeout` / `crashed` mean the
  environment or harness broke and the trial must not be read as agent
  quality.
- Regression comparison is `diff`-shaped by design: run the suite on two
  keel versions, compare pass counts, turns, and tokens per task from the
  two JSONL files.
- One trial says little: agent behavior varies between runs. Use
  `--trials 3` or more before claiming a change helped. Per-task pass
  fractions give you pass^k-style reliability reading; a task passing
  3/3 is evidence, 1/1 is an anecdote.

## Task format

A task is a directory under `evals/tasks/`:

```
evals/tasks/<task-id>/
  task.json       # { "prompt", "timeoutMs"?, "scriptTimeoutMs"?, "allowBash"?, "maxCostUsd"? }
  workspace/      # fixture files copied into a fresh temp dir per trial
  verify.sh       # runs in the workspace after the agent; exit 0 = pass
  solution.sh     # reference solution applied without an LLM; required
```

Execution model (mirrors Terminal-Bench/Harbor):

- Every trial starts from a pristine copy of `workspace/` in a throwaway
  temp directory. Nothing leaks between trials.
- The runner spawns the real `keel` CLI as a subprocess — the same
  surface a user runs. `src/eval/` is forbidden (by
  `tests/invariants/boundaries.test.ts`) from importing harness internals.
- `verify.sh` grades only the final workspace state, never the agent's
  path to it. Any approach that produces the right outcome passes.

## Writing good tasks

Drawn from the Terminal-Bench and Anthropic eval guidance; `--check`
enforces the mechanical parts:

1. **The prompt must be sufficient.** Everything `verify.sh` checks must
   be derivable from the prompt alone — exact paths, exact expected
   output. An agent that follows instructions correctly must be able to
   pass.
2. **Always ship `solution.sh`.** It proves the task is solvable and the
   verifier is configured correctly. `keel eval --check` replays it on
   every PR; a 0% task usually means a broken verifier, not a bad agent.
3. **Deterministic verifiers only.** Exit codes from `grep`/`node`, no
   timing, no randomness, no LLM judges.
4. **Don't leak the answer.** No comments in fixtures pointing at the
   bug; the agent should do the work the prompt describes.
5. **One capability per task.** Prefer more small tasks over one
   mega-task; the suite distribution should track what daily use actually
   demands.
6. **Read transcripts when scores move.** Numbers say *whether* it got
   better; only transcripts say *why*. Failures should look fair.

The seed tasks cover keel's current tool surface and the highest-risk
failure modes: single exact edit, constant change behind an import,
multi-file rename, new file creation, bash-driven test fixing, an edit
deep inside a long file, stale edit recovery, repeated-string
disambiguation, test-preserving bug fixes, and pattern-following feature
addition. Grow the suite from real daily-use tasks: when keel fails or
annoys you in real work, distill that session into a task directory.

## What this is not (yet)

- No cross-agent comparison until a second provider lands (P0-2); the
  JSONL schema already records provider/model so old results stay usable.
- No LLM-graded rubrics; deterministic outcome checks only.
- No transcript persistence per trial; the runner keeps only metrics.
- `interventions` (human steering count) becomes meaningful with the
  interactive session (P0-1) and will be added to the schema then.
