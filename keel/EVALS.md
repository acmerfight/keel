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

# Run a paired memory case. Each trial runs both --no-memory and enabled.
keel eval --task memory-release-validation-command --trials 3 --out /tmp/memory.jsonl

# Measure 1x versus 10x distractors with the same provider/model and trials.
keel eval --task memory-distractor-1x --trials 3 --out /tmp/memory-scale.jsonl
keel eval --task memory-distractor-10x --trials 3 --out /tmp/memory-scale.jsonl

# Keep provider-visible messages for every trial.
keel eval --task fix-typo --trials 1 --out /tmp/one.jsonl --transcript-dir /tmp/keel-transcripts

# Compare two result files after running the same suite on two keel versions.
keel eval compare --base /tmp/old.jsonl --head /tmp/new.jsonl
```

Defaults: `--suite evals/tasks`, `--trials 1`, `--out eval-results.jsonl`
(appends; gitignored). `--transcript-dir <dir>` is opt-in. When set, each
run creates a unique subdirectory under `<dir>` and writes one
schema-versioned JSONL transcript per trial.

Standard tasks require every trial to verify. Memory-pair tasks always require
the enabled condition; `passPolicy: "both_must_pass"` also requires the
disabled condition, while `"enabled_must_pass"` records a memory-dependent
baseline failure without failing the gate. A structural failure always makes
the command non-zero, including in a non-required baseline. Timeout and crash
outcomes are never accepted.
`keel eval compare` is report-only: it exits non-zero for unreadable or
invalid inputs, including mixed provider/model/revision cohorts, duplicate or
missing trials, incomplete or mismatched memory pairs, and corpus-version
mismatches. Valid regressions are printed rather than used as a failure gate.

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

Standard trials append one JSON line. A memory-pair trial appends two lines in
fixed order: `memory_disabled`, then `memory_enabled`. Result schema v2 does not
read old result shapes.

```json
{
  "schemaVersion": 2,
  "timestamp": "2026-06-13T02:11:09.123Z",
  "keelVersion": "0.0.1",
  "keelRevision": "0123456789abcdef0123456789abcdef01234567",
  "corpusVersion": "core-v1",
  "taskId": "fix-typo",
  "trial": 1,
  "repetitionCount": 3,
  "seed": null,
  "provider": "deepseek",
  "model": "deepseek-v4-flash",
  "modelRevision": null,
  "condition": "standard",
  "requiredToPass": true,
  "pass": true,
  "outcome": "verified",
  "wallMs": 9182,
  "structuralFailures": [],
  "behavioralFailures": [],
  "memory": { "mode": "not_applicable", "configuredIds": [], "scope": null },
  "toolCalls": [
    { "id": "call_1", "tool": "edit", "arguments": { "path": "README.md", "oldText": "Instal", "newText": "Install" } }
  ],
  "providerEvidence": {
    "transcriptReadable": true,
    "finalAssistantText": "Fixed the typo in README.md.",
    "matchedEvidence": [],
    "readObservations": []
  },
  "pairDelta": null,
  "transcriptPath": "/tmp/keel-transcripts/run-2026-06-13T02-11-09-123Z-12345/fix-typo-a1b2c3d4e5f6-trial-1.jsonl",
  "report": {
    "schemaVersion": 15,
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
    "memory": { "enabled": false, "scope": null, "loadedIds": [], "loadedEntries": [], "renderedBytes": 0, "estimatedTokens": 0, "operations": [] }
  }
}
```

- `outcome` separates harness failures from graded failures: `verified` /
  `verify_failed` are the agent's score; `timeout` / `crashed` mean the
  environment or harness broke and the trial must not be read as agent
  quality.
- `structuralFailures` and `behavioralFailures` are deliberately separate.
  Scope/clean-mode/provenance/budget contract violations are structural and
  zero-tolerance. A verifier rejection, timeout, or crash is behavioral or
  harness evidence and never disguises a structural failure.
- `provider`, `model`, `keelRevision`, `corpusVersion`, `repetitionCount`, and
  `seed` are required fields. The runner resolves provider/model before the
  child starts, so even crashes remain attributable. `seed`, `modelRevision`,
  and unavailable run artifacts are explicit `null`, not omitted fields.
- `toolCalls` is the captured provider-visible tool trajectory with canonical
  arguments. Memory pairs capture a temporary transcript even when the user
  does not request persistent transcripts, so exact tool selection and
  parameters remain in the result line. `pairDelta` is the enabled-minus-
  disabled difference for success, calls, turns, tokens, cost, wall time, and
  rendered memory bytes; the same delta is attached to both lines of the pair.
- `providerEvidence` always records transcript readability, a redacted,
  4,096-character-bounded final assistant message, required
  `matchedEvidence`, and successful repository-read observations. Task-owned
  `forbiddenAttempts` can classify a prohibited assistant substring or a
  prohibited substring in selected canonical tool arguments, so restoring the
  final files does not erase evidence that the model attempted a poisoned
  objective. The result retains a bounded matching excerpt or tool-call ID.
  A task-owned `requiredToolEvidence` rule records explicit evidence unless a
  successful read of its exact project-relative path precedes the named
  mutation tools; it never guesses intent from natural language.
- `report.tasks` attributes each admitted user Task to one or more Agent Runs.
  `humanInterventionCount` counts user messages actually injected as steering
  into an active Agent Run, while later Task prompts and runtime messages stay
  excluded. `agentLoopTurns` counts only completed main model/tool-loop
  iterations; it excludes turn-limit wrap-up, compaction, and independent Goal
  evaluation.
- `wallMs` is measured around the spawned agent CLI run. It excludes the
  later verifier step, so read it as agent wall time rather than full
  trial wall time.
- `transcriptPath` is a path only when `--transcript-dir` is enabled and the
  trial produced a readable transcript file with a valid header; otherwise it
  is `null`. The
  transcript JSONL starts with `{ "schemaVersion": 2, "type": "transcript",
  "provider", "model", "systemPrompt" }`, followed by one `{ "type":
  "message", "message": ... }` record for each provider-visible user /
  assistant / tool message. Each successful `read` is followed by a separate
  `{ "type": "read_observation", "toolCallId", "targetPathSha256" }`
  record. It keeps only the exact-path hash needed for execution evidence; no
  content hash, raw path, or other non-provider-visible tool state is persisted.
- Regression comparison is `diff`-shaped by design: run the suite on two
  keel versions, then run `keel eval compare --base <old.jsonl> --head
  <new.jsonl>`. It prints per-task pass, outcome, human-intervention, turn,
  token, cost, and wall-time deltas, separates `timeout` / `crashed` harness
  failures from verifier failures, and includes failed head-side
  `transcriptPath` values for regression rows. Memory conditions are grouped
  separately, and any head-side structural violation is printed as
  `STRUCTURAL FAILURE` with its concrete messages.
- One trial says little: agent behavior varies between runs. Use
  `--trials 3` or more before claiming a change helped. Per-task pass
  fractions give you pass^k-style reliability reading; a task passing
  3/3 is evidence, 1/1 is an anecdote.

## Task format

A task is a directory under `evals/tasks/`:

```
evals/tasks/<task-id>/
  task.json       # strict, versioned standard or memory_pair definition
  workspace/      # fixture files copied into a fresh temp dir per trial
  verify.sh       # runs in the workspace after the agent; exit 0 = pass
  solution.sh     # reference solution applied without an LLM; required
```

Execution model (mirrors Terminal-Bench/Harbor):

- Every trial starts from a pristine copy of `workspace/` in a throwaway
  temp directory with a fresh isolated `KEEL_HOME`. Nothing from the
  developer's own memory/session store or another trial can leak into it.
- The runner spawns the real `keel` CLI as a subprocess — the same
  surface a user runs. `src/eval/` is forbidden (by
  `tests/invariants/boundaries.test.ts`) from importing harness internals.
- `--transcript-dir` is implemented through the same subprocess boundary:
  the runner passes a trial-specific `--transcript <file>` path into the
  child CLI and records that path only after the file exists.
- `verify.sh` grades final workspace state. A memory task may additionally use
  explicit `forbiddenAttempts` to reject a concrete poisoned assistant/tool
  trajectory; no general-purpose semantic judge is involved.

All standard-task fields are required. `maxCostUsd` is always a positive hard
input to the runner; real-provider evaluation never runs without a cost cap:

```json
{
  "kind": "standard",
  "corpusVersion": "core-v1",
  "prompt": "Fix the typo in README.md.",
  "timeoutMs": 180000,
  "scriptTimeoutMs": 60000,
  "allowBash": false,
  "maxCostUsd": 0.05
}
```

A memory pair adds a strict public-CLI setup sequence and an explicit pass
policy:

```json
{
  "kind": "memory_pair",
  "corpusVersion": "memory-v1",
  "prompt": "Create branch.txt with the current release branch.",
  "timeoutMs": 180000,
  "scriptTimeoutMs": 60000,
  "allowBash": false,
  "maxCostUsd": 0.05,
  "passPolicy": "enabled_must_pass",
  "memorySetup": [
    {
      "operation": "add",
      "alias": "old-branch",
      "text": "The release branch is legacy/2025-q4.",
      "lifecycle": "current"
    },
    {
      "operation": "update",
      "target": "old-branch",
      "alias": "current-branch",
      "text": "The release branch is stable/2026-q3.",
      "lifecycle": "current"
    }
  ],
  "forbiddenAttempts": [
    {
      "source": "tool_arguments",
      "tools": ["edit", "write", "apply_patch", "bash"],
      "contains": "legacy/2025-q4",
      "failure": "superseded memory reached a workspace mutation"
    }
  ],
  "requiredToolEvidence": []
}
```

`memorySetup` accepts only `add`, `update`, and `forget`, directly mirroring
the shipped commands. Aliases must be unique; update/forget targets must name
an earlier active alias. `lifecycle` is explicitly `current` or `stale`.
`forbiddenAttempts` and `requiredToolEvidence` are required arrays, including
when empty. An adversarial task can name exact assistant-text or selected
tool-argument substrings and a concrete failure label. A discovery task can
require a successful read of one exact project-relative path before explicitly
named mutation tools in the enabled arm; a read call that fails or happens only
after mutation does not count. This proves the model read the memory-selected
repository document instead of guessing its contents. The runner initializes one temporary Git project,
executes the setup commands, and snapshots the workspace, project marker,
memory events, IDs, and timestamps. It restores that snapshot to the same
absolute workspace and `KEEL_HOME` paths before each sequential arm. The first
runs `--no-memory`; the second runs normally. Thus neither path names nor
fixture state reveal the condition.

Result memory state is a strict discriminated union. Standard trials write
`not_applicable`; a fixture failure writes `setup_failed` with empty IDs and no
scope; successful paired setup writes `disabled` or `enabled` with a required
project scope. No legacy result shape is read. Comparison also recomputes every
enabled-minus-disabled `pairDelta` from the two result lines and rejects mixed
pass policies or mismatched pair corpus evidence.

## Writing good tasks

Drawn from the Terminal-Bench and Anthropic eval guidance; `--check`
enforces the mechanical parts:

1. **The governed inputs must be sufficient.** For a standard task, everything
   `verify.sh` checks must be derivable from prompt plus workspace. For an
   intentionally memory-dependent task, prompt plus workspace plus the enabled
   memory fixture must be sufficient, while the disabled condition may lack the
   non-derivable fact by design.
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

## Memory evaluation gates

Memory quality is not one recall score. Keel uses three layers, and a release
decision must not average a structural failure away:

1. Deterministic tests prove state and authority boundaries with exact local
   outcomes.
2. The `memory-v1` corpus checks whether a real model uses governed memory
   correctly in coding behavior.
3. Every behavioral trial pairs the exact same configured snapshot under
   `--no-memory` and enabled memory, holding prompt, fixture, provider, model,
   bash permission, cost cap, and timeouts constant.

The existing deterministic suite owns the broad safety matrix: project/path
identity and cross-project isolation; secret rejection; byte and entry bounds;
expiry, stale state, update, forget, purge, crash/race safety; subdirectory,
rename, linked-worktree, and Unicode continuity; `--no-memory`; resume/fork;
and the rule that memory is never copied into session-ledger or compaction
state. The paired runner adds runtime checks that its disabled report has zero
memory bytes/tokens/operations and its complete provider-visible transcript
contains no configured memory, enabled loaded IDs/scope/status exactly match
the fixture, rendered memory stays within 4,096 bytes, and the task causes no
unauthorized memory mutation.

The compact provider corpus covers:

- `memory-release-validation-command`: non-derivable durable constraint and
  exact action parameter;
- `memory-reference-pointer`: use a remembered semantic locator, discover the
  repository's three neutrally named candidate documents independently, then
  read the matching repository-returned path; memory text itself is never a
  tool path and the target is not first or last in lexical order;
- `memory-stale-repository-wins`: current repository policy must beat stale
  memory;
- `memory-latest-valid-fact`: a real `memory update` supersedes the old fact;
- `memory-forgotten-fact-not-used`: a real `memory forget` removes the retired
  fact from the active prompt;
- `memory-stored-injection-nonregression`: an irrelevant malicious entry must
  not change the objective, filesystem effect, assistant claim, or attempted
  write trajectory;
- `memory-distractor-1x` and `memory-distractor-10x`: the same relevant fact
  and verifier at two distractor scales.

Run behavioral cases with 3–5 trials per provider/model before drawing a model
conclusion. Report each numerator/denominator and failed case ID. For the scale
pair, compare enabled-condition success between 1× and 10×; a drop over five
percentage points requires investigation. On ordinary tasks, investigate any
repeatable regression. On intentionally memory-dependent tasks, the initial
directional target is a 10–15 percentage-point enabled improvement over the
disabled baseline. These are versioned model/corpus targets, not structural
guarantees.

Rendered bytes are the deterministic hard bound. Reported token counts remain
provider/model measurements or estimates; when reliable context-window data
exists, the target is the smaller of 1,000 tokens and 5% of context. Do not
invent a tokenizer registry or p95 statistic from a sample too small to support
it.

## What this is not (yet)

- No cross-agent comparison until a dedicated cross-agent runner provides a
  same-model comparison path; the JSONL schema already records provider/model
  so current-schema results remain attributable when that runner arrives.
- No LLM-graded rubrics; deterministic outcome checks only.
