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

# Run the pre-registered #590 Slice 1.5 control/treatment calibration.
keel eval --suite evals/experiments/subagent-slice-1-5/tasks \
  --provider deepseek --model deepseek-v4-flash --trials 3 \
  --out /tmp/subagent-calibration.jsonl \
  --transcript-dir /tmp/subagent-calibration-transcripts

# Run the separately frozen explicit-user-intent supplement.
keel eval --suite evals/experiments/subagent-explicit-intent-v1/tasks \
  --provider deepseek --model deepseek-v4-flash --trials 3 \
  --out /tmp/subagent-explicit-intent.jsonl \
  --transcript-dir /tmp/subagent-explicit-intent-transcripts

# Run the frozen #590 Slice 1.6 explicit completion-reliability window.
keel eval --suite evals/experiments/subagent-slice-1-6/tasks \
  --provider deepseek --model deepseek-v4-flash --trials 3 \
  --out /tmp/subagent-slice-1-6.jsonl \
  --transcript-dir /tmp/subagent-slice-1-6-transcripts
```

Defaults: `--suite evals/tasks`, `--trials 1`, `--out eval-results.jsonl`
(appends; gitignored). `--transcript-dir <dir>` is opt-in. When set, each
run creates a unique subdirectory under `<dir>` and writes one
schema-versioned JSONL transcript per trial.

For a standard task, the exit code is non-zero when any trial fails to verify,
times out, or crashes. For a `memory_pair` task, the disabled arm may fail
verification because it intentionally lacks the required fact; it must still
complete without timing out or crashing, and the enabled arm must verify. For a
`delegation_pair`, the control harness must complete, the treatment must verify,
and the treatment must satisfy its independently recorded delegation policy.
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
  "schemaVersion": 4,
  "timestamp": "2026-06-13T02:11:09.123Z",
  "keelVersion": "0.0.1",
  "taskId": "fix-typo",
  "trial": 1,
  "condition": "standard",
  "requiredToPass": true,
  "pass": true,
  "harnessOutcome": "completed",
  "taskOutcome": "verified",
  "wallMs": 9182,
  "transcriptPath": "/tmp/keel-transcripts/run-2026-06-13T02-11-09-123Z-12345/fix-typo-a1b2c3d4e5f6-trial-1.jsonl",
  "report": {
    "schemaVersion": 22,
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
    "subagents": { "status": "observed", "runs": [] },
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

- `harnessOutcome` is `completed`, `timeout`, or `crashed`. Only a completed
  harness carries `taskOutcome`, which is `verified` or `verify_failed`.
  `pass` is true exactly for a completed, verified trial. The schema rejects
  impossible combinations instead of asking consumers to repair them.
- A non-zero agent exit remains `harnessOutcome: "crashed"`, but when the agent
  successfully wrote a current-schema failure report the eval result preserves
  it. Such a report uses `stopReason: "failed"`, closes the active Task and
  Agent Run as failed, and adds a bounded redacted `failure` object. The report
  is diagnostic evidence; it never changes the failed verdict into success.
- `condition` is `standard`, `memory_disabled`, `memory_enabled`,
  `delegation_control`, or `delegation_treatment`. `requiredToPass` is false
  for the observational `memory_disabled` and `delegation_control` conditions
  and true otherwise. A delegation treatment line also carries a required
  `delegationSelection` observation with policy, distinct child count, and
  satisfaction; the schema rejects a satisfaction value that contradicts its
  policy and child count. Control and task outcome never carry that judgment. A
  paired trial appends two lines in stable control/treatment or
  disabled/enabled order.
  Selection counts only child Runs whose invocation snapshot is terminal with
  `status: "completed"`; failed, limited, cancelled, interrupted, queued, and
  running children do not satisfy a positive delegation gate. If the CLI report
  cannot own a trustworthy invocation snapshot, selection is `unavailable`
  rather than inferred from provider operations.
  Each line carries the ordinary report, so model operations, child
  attribution, usage, cost, and timing remain inspectable without a second
  result format.
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
  <new.jsonl>`. It prints per-task pass, harness, task-outcome, selection,
  human-intervention, turn, token, cost, and wall-time deltas and includes
  failed head-side `transcriptPath` values for regression rows. Its suite gate
  includes both semantic task pass and any required delegation-selection
  observation; observational control conditions remain excluded.
- One trial says little: agent behavior varies between runs. Use
  `--trials 3` or more before claiming a change helped. Per-task pass
  fractions give you pass^k-style reliability reading; a task passing
  3/3 is evidence, 1/1 is an anecdote.

## Task format

A task is a directory under a selected suite:

```
<suite>/<task-id>/
  task.json       # strict standard, memory_pair, or delegation_pair config
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

Delegation calibration tasks use `"kind": "delegation_pair"` with explicit
timeouts, bash policy, root max cost, and a treatment-only `delegationPolicy`:

```json
{
  "kind": "delegation_pair",
  "prompt": "Review two independent modules and write review.md.",
  "timeoutMs": 240000,
  "scriptTimeoutMs": 60000,
  "allowBash": false,
  "maxCostUsd": 0.03,
  "agentPolicy": "explicit",
  "delegationPolicy": "require_one"
}
```

Each trial restores the same pristine workspace for a single-agent control and
an `--agent-policy <explicit|auto>` treatment. Odd trials run control first and
even trials run treatment first to reduce fixed order bias, while JSONL stays
in control/treatment order. The control harness must complete; its semantic
task failure remains a valid observation. The treatment must verify and
separately satisfy `require_one`, `require_multiple` (at least two distinct
child Runs), `require_any`, `forbid`, or `at_most_one` using distinct child
identities from the run report. Selection never changes
`taskOutcome`. The frozen Slice 1.5 corpus, transcript rubric, provider/model,
trial count,
budgets, and Continue/Pause/Stop gate live in
[`evals/experiments/subagent-slice-1-5/README.md`](evals/experiments/subagent-slice-1-5/README.md).
The later product clarification and independently pre-registered exact-prefix
experiment live in
[`evals/experiments/subagent-explicit-intent-v1/README.md`](evals/experiments/subagent-explicit-intent-v1/README.md).
The host-owned completion handoff and continuation-budget reliability gate live
in [`evals/experiments/subagent-slice-1-6/README.md`](evals/experiments/subagent-slice-1-6/README.md).
The stable explicit-policy graduation window lives in
[`evals/experiments/subagent-slice-2-3/README.md`](evals/experiments/subagent-slice-2-3/README.md).
The explicit/auto product-graduation and sequential-negative window lives in
[`evals/experiments/subagent-slice-6-2/README.md`](evals/experiments/subagent-slice-6-2/README.md).
The cross-domain general-orchestration V2 window and failed prompt candidate
live in
[`evals/experiments/subagent-slice-6-3/README.md`](evals/experiments/subagent-slice-6-3/README.md).

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
