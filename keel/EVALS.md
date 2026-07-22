# Harness Evals

`keel eval` measures keel's harness execution quality on real coding tasks
(ROADMAP **Harness eval measurement loop**). It exists to make the
north-star claim falsifiable: a change to the harness is good if and only
if the numbers say so.

Keel is pre-release, so eval work should support product work rather than
replace it. Add or update eval tasks when fixing a real failure, preserving a
regression, or validating a harness change. Do not choose standalone corpus
growth ahead of unresolved daily-use gaps in interactive UX, provider/model
switching, context reliability, edit reliability, session workflow, or approval
ergonomics.

## How to run

```bash
# Validate the suite without spending tokens: every task's reference
# solution must pass its own verifier. Runs in CI on every PR.
keel eval --check

# Run the full suite against the configured provider (spends real money).
DEEPSEEK_API_KEY=... keel eval --trials 3 --out evals/results/$(date +%Y%m%d-%H%M%S).jsonl

# Run the same suite with Kimi K2.6.
KIMI_API_KEY=... keel eval --provider kimi --model kimi-k2.6 --trials 3 --out evals/results/$(date +%Y%m%d-%H%M%S).jsonl

# Run the same suite with Qwen 3.7 Max.
DASHSCOPE_API_KEY=... keel eval --provider qwen --model qwen3.7-max --trials 3 --out evals/results/$(date +%Y%m%d-%H%M%S).jsonl

# Iterate on one task.
keel eval --task fix-typo --trials 1 --out /tmp/one.jsonl

# Compare the same memory-dependent task with memory disabled and enabled.
keel eval --task memory-release-validation-command --trials 3 --out /tmp/memory.jsonl

# Keep provider-visible messages for every trial.
keel eval --task fix-typo --trials 1 --out /tmp/one.jsonl --transcript-dir /tmp/keel-transcripts

# Compare two result files after running the same suite on two keel versions.
keel eval compare --base /tmp/old.jsonl --head /tmp/new.jsonl
```

Defaults: `--suite evals/tasks`, `--trials 1`, `--out eval-results.jsonl`
(appends; gitignored). `--transcript-dir <dir>` is opt-in. When set, each
run creates a unique subdirectory under `<dir>` and writes one
schema-versioned JSONL transcript per trial.

For a standard task, the exit code is non-zero when any trial fails to verify,
times out, or crashes. For a `memory_pair` task, the disabled arm may fail
verification because it intentionally lacks the required fact; it must still
complete without timing out or crashing, and the enabled arm must verify.
`keel eval compare` is report-only: it exits non-zero for unreadable or
invalid inputs, but regressions are printed rather than used as a failure
gate.

Eval provider selection shares the provider resolver defaults with one-shot
runs and accepts `--provider <deepseek|kimi|qwen>` plus optional `--model
<id>` overrides. DeepSeek is the default and reads `DEEPSEEK_API_KEY`,
optional `DEEPSEEK_MODEL` (default `deepseek-v4-flash`), and optional
`DEEPSEEK_BASE_URL`. Kimi uses `--provider kimi` or `KEEL_PROVIDER=kimi`,
`KIMI_API_KEY`, optional `KIMI_MODEL` (default `kimi-k2.6`), and optional
`KIMI_BASE_URL` (default `https://api.moonshot.cn/v1`; set it to the official
regional endpoint for your account when needed). Qwen uses `--provider qwen`
or `KEEL_PROVIDER=qwen`, `DASHSCOPE_API_KEY` or `QWEN_API_KEY`, optional
`QWEN_MODEL` (default `qwen3.7-max`), and optional `QWEN_BASE_URL` (default
`https://dashscope-intl.aliyuncs.com/compatible-mode/v1`; set it for China
region or workspace-scoped DashScope endpoints).

## GitHub Actions

The `Keel Eval` workflow is intentionally manual (`workflow_dispatch`), not
a required PR check. It currently runs the default DeepSeek provider and needs
the `DEEPSEEK_API_KEY` repository secret, then builds the CLI, runs the
compiled `dist/cli/index.js`, prints a Markdown job summary, and uploads the
JSONL result file as an artifact. Run Kimi or Qwen evals locally with
`--provider kimi` or `--provider qwen`, or add matching repository secrets
before wiring other providers into the workflow. The workflow job
timeout is 180 minutes, enough for the current full suite at `trials=3` even
when tasks run near their per-task time limits:

1. Open **Actions → Keel Eval → Run workflow**.
2. Pick `trials` (positive integer, default `1`; use `3+` before making
   quality claims).
3. Optionally set `task` to run one task id.
4. Read the job summary for pass rate, turns, tokens, cost, and per-task
   outcomes.
5. Download the `keel-eval-results` artifact when you need the raw JSONL for
   comparison with prior runs.

## Reading results

Each standard trial appends one JSON line:

```json
{
  "schemaVersion": 2,
  "timestamp": "2026-06-13T02:11:09.123Z",
  "keelVersion": "0.0.1",
  "taskId": "fix-typo",
  "trial": 1,
  "condition": "standard",
  "requiredToPass": true,
  "pass": true,
  "outcome": "verified",
  "wallMs": 9182,
  "transcriptPath": "/tmp/keel-transcripts/run-2026-06-13T02-11-09-123Z-12345/fix-typo-a1b2c3d4e5f6-trial-1.jsonl",
  "report": {
    "schemaVersion": 18,
    "tasks": [
      {
        "ordinal": 1,
        "trigger": "user_prompt",
        "humanInterventionCount": 0,
        "agentRuns": [
          {
            "ordinal": 1,
            "trigger": "user_prompt",
            "humanInterventionCount": 0,
            "agentLoopTurns": 1,
            "providerRetries": [],
            "contextCompactions": [],
            "stopReason": "completed"
          }
        ],
        "outcome": "completed"
      }
    ],
    "humanInterventionCount": 0,
    "modelOperations": [
      {
        "ordinal": 1,
        "owner": { "type": "agent_run", "taskOrdinal": 1, "agentRunOrdinal": 1 },
        "purpose": "agent_turn",
        "provider": "deepseek",
        "model": "deepseek-v4-flash",
        "providerRequestAttempts": [
          {
            "ordinal": 1,
            "outcome": "completed",
            "usage": { "inputTokens": 5210, "cachedInputTokens": 4100, "uncachedInputTokens": 1110, "outputTokens": 240 },
            "costUsd": 0.000234
          }
        ],
        "outcome": "completed",
        "usage": { "inputTokens": 5210, "cachedInputTokens": 4100, "uncachedInputTokens": 1110, "outputTokens": 240 },
        "costUsd": 0.000234
      }
    ],
    "modelOperationCount": 1,
    "providerRequestAttemptCount": 1,
    "modelsUsed": [{ "provider": "deepseek", "model": "deepseek-v4-flash" }],
    "usageByModel": [
      {
        "provider": "deepseek",
        "model": "deepseek-v4-flash",
        "agentLoopTurns": 1,
        "usage": { "inputTokens": 5210, "cachedInputTokens": 4100, "uncachedInputTokens": 1110, "outputTokens": 240 },
        "costUsd": 0.000234
      }
    ],
    "agentLoopTurns": 1,
    "stopReason": "completed",
    "usage": { "inputTokens": 5210, "cachedInputTokens": 4100, "uncachedInputTokens": 1110, "outputTokens": 240 },
    "durationMs": 8455,
    "costUsd": 0.000234,
    "costOvershootUsd": 0,
    "contextCompactions": [],
    "skillActivations": [],
    "activeSkills": [],
    "skillCatalog": { "exposed": 0, "omitted": 0, "total": 0, "budgetChars": 8000, "usedChars": 0 },
    "skillPolicy": { "mode": "enabled", "disabledPackages": 0 },
    "undoProtection": { "status": "available", "checkpointsWritten": 1, "failures": [], "latestCheckpoint": { "written": true } },
    "memory": { "status": "disabled", "scope": null, "loadedIds": [], "loadedEntries": [], "renderedBytes": 0, "estimatedTokens": 0, "operations": [] }
  }
}
```

- `outcome` separates harness failures from graded failures: `verified` /
  `verify_failed` are the agent's score; `timeout` / `crashed` mean the
  environment or harness broke and the trial must not be read as agent
  quality. `pass` is true exactly when `outcome` is `verified`; compare rejects
  a current-schema result line when those fields contradict each other.
- `condition` is `standard`, `memory_disabled`, or `memory_enabled`.
  `requiredToPass` is false exactly for `memory_disabled` and true for the
  other conditions; compare also rejects lines that contradict this rule. A
  memory-paired trial appends two lines in disabled/enabled order. Each line
  carries the ordinary report, so memory IDs, bytes, model usage, cost, and
  timing remain inspectable without a second result format.
- `report.tasks` attributes each admitted user Task to one or more Agent Runs.
  `humanInterventionCount` counts user messages actually injected as steering
  into an active Agent Run, while later Task prompts and runtime messages stay
  excluded. `agentLoopTurns` counts only completed main model/tool-loop
  iterations; it excludes turn-limit wrap-up, compaction, and independent Goal
  evaluation.
- `wallMs` is measured around the spawned agent CLI run. It excludes the
  later verifier step, so read it as agent wall time rather than full
  trial wall time.
- `transcriptPath` is present only when `--transcript-dir` is enabled and
  the trial produced a readable transcript file with a valid header. The
  transcript JSONL starts with `{ "schemaVersion": 1, "type": "transcript",
  "provider", "model", "systemPrompt" }`, followed by one `{ "type":
  "message", "message": ... }` record for each provider-visible user /
  assistant / tool message.
- Regression comparison is `diff`-shaped by design: run the suite on two
  keel versions, then run `keel eval compare --base <old.jsonl> --head
  <new.jsonl>`. It prints per-task pass, outcome, human-intervention, turn,
  token, cost, and wall-time deltas, separates `timeout` / `crashed` harness
  failures from verifier failures, and includes failed head-side
  `transcriptPath` values for regression rows.
- One trial says little: agent behavior varies between runs. Use
  `--trials 3` or more before claiming a change helped. Per-task pass
  fractions give you pass^k-style reliability reading; a task passing
  3/3 is evidence, 1/1 is an anecdote.

## Task format

A task is a directory under `evals/tasks/`:

```
evals/tasks/<task-id>/
  task.json       # strict standard or memory_pair configuration
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
- `--transcript-dir` is implemented through the same subprocess boundary:
  the runner passes a trial-specific `--transcript <file>` path into the
  child CLI and records that path only after the file exists.
- `verify.sh` grades only the final workspace state, never the agent's
  path to it. Any approach that produces the right outcome passes.

Standard tasks declare `"kind": "standard"`; their existing timeout, bash,
and cost options retain their ordinary defaults. The runner always passes
`--no-memory` for these tasks so ambient developer memory cannot contaminate a
baseline.

Memory-dependent tasks use a strict, explicit configuration:

```json
{
  "kind": "memory_pair",
  "prompt": "Create release-command.txt from the current project memory.",
  "timeoutMs": 180000,
  "scriptTimeoutMs": 60000,
  "allowBash": false,
  "maxCostUsd": 0.03,
  "memory": "The current release validation command is `pnpm test:coverage`."
}
```

The runner creates an isolated `KEEL_HOME` for memory and copies a private,
fixed snapshot of the user's provider config/auth files into it. It initializes
the copied workspace as a Git project and seeds the configured entry through
the public `keel memory add` command. It then runs the same provider, model,
prompt, budgets, and absolute workspace path first with `--no-memory` and then
with memory enabled, restoring the pristine workspace between arms. Both result
lines are written in one append operation. This first paired slice deliberately
supports one explicit project-memory entry; poisoning, forget/purge, distractor
scaling, and broader lifecycle corpora remain later parts of issue #462 rather
than hidden modes in this task shape.

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
addition. Terminal-Bench-inspired internal tasks extend this regression
corpus into representative daily-work categories (git recovery, log
analysis, SQL optimization, security filter bypass, and legacy data
modernization), but they are still keel-native seed tasks rather than an
official Terminal-Bench score.

Grow the suite from real daily-use tasks when doing the related product work:
when keel fails or annoys you in real work, preserve the failure evidence and
distill the failure mechanism into a task directory. Once a task is accepted
into the baseline, freeze its prompt and verifier before reporting trial
results; if a later run exposes a task bug, fix the task and treat prior scores
for that task version as invalid.

## What this is not (yet)

- No cross-agent comparison until a dedicated cross-agent runner provides a
  same-model comparison path; the JSONL schema already records provider/model
  so current-schema results remain attributable when that runner arrives.
- No LLM-graded rubrics; deterministic outcome checks only.
