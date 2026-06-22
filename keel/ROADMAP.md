# Roadmap

## North Star

Two goals, in order:

1. **Keel replaces Codex CLI and Claude Code as the author's daily coding
   agent.**
2. **Keel's harness execution quality exceeds Claude Code, Codex, and
   Kimi Code** — measured on the same model and the same tasks.

"Harness quality" is an empirical claim, not a feeling. Metrics, in
priority order: **task success rate**, then **human interventions per
task**, then **turns and tokens to completion** (including edit success
rate as a tracked sub-metric). Anything not measurable this way is not
part of the goal.

This goal is plausible because the harness is an independent variable
with large measured effect: 2026 published comparisons show the same
model swinging 5–40 percentage points across harnesses on the same tasks
(e.g. GPT-5.5 at 61.5% in Codex CLI vs 87.2% in Cursor on the Endor Labs
suite; Terminal-Bench reports agent+model pairs for the same reason).
A small harness can win this game. Breadth of features cannot — see
Non-Goals.

Every slice should move toward one of these goals. When choosing the next
feature, pick the highest-priority gap below that can ship as a vertical
slice (see [SLICING.md](SLICING.md)). The priority order here answers
"which slice", SLICING.md answers "how to cut it". This is a priority
list, not a fixed sequence: re-check the current product entrypoint
before every pick, and re-triage this file when reality changes.

## Current State (2026-06)

What a user can do today:

- `keel "<message>"` — one-shot agent run: streamed text, multi-round tool
  calls (read / ls / glob / grep / edit / write / apply_patch / bash),
  recoverable tool errors with LLM-facing recovery hints, tool progress on stderr, graceful stop with
  a progress summary when the 64-turn limit is exhausted.
- `keel` — interactive in-process session: sequential follow-up messages
  reuse prior user / assistant / tool context from the same terminal run;
  input typed while a tool turn is running is injected after tool results at
  the next model request.
- `keel --session <id>` / `keel --resume <id>` — persist and resume
  interactive transcripts as JSONL session ledgers, with schema validation,
  workspace checks, and active-session locks.
- Interactive `/compact [focus]` — manually replace older conversation with
  a model-generated checkpoint summary; automatic compaction also runs before
  oversized requests and retries once after provider context overflow before
  assistant output starts.
- Root `AGENTS.md` project instructions are injected into the system prompt
  when present, with workspace, ignore-policy, file-type, UTF-8, and size
  checks before content is sent to the provider.
- `keel --allow-bash` / `keel --bash-policy trusted` — trusted shell
  mode (all-or-nothing).
- `keel --bash-policy ask` — expose bash while requiring per-command
  approval in interactive sessions, with exact command + cwd approval
  remembered for the process-local session. One-shot runs fail closed
  because there is no approval UI; forced non-TTY interactive runs also
  reject `ask` so approvals cannot be read from piped input.
- `keel --max-cost <usd>` — cost tracking with budget stop.
- `keel --report <file>` — write a machine-readable run report with turns,
  stop reason, token usage, duration, provider/model, and cost when tracked.
- `keel --transcript <file>` — write provider-visible one-shot messages as
  schema-versioned JSONL.
- `keel eval [--check] [--trials <n>]` — run a repeatable harness eval suite
  from `evals/tasks`, with per-trial JSONL results and reference-solution
  verifier checks. `--transcript-dir <dir>` keeps one readable transcript
  artifact per trial and links it from the result JSONL when produced.
- `keel /undo` — restore the last edit, created file, or apply_patch batch
  checkpoint.
- `keel --doctor` — environment check.

Known limits that shape the priorities below:

- Interactive sessions still have no TUI or session-level report, and cost
  limits apply to each submitted turn rather than the whole interactive
  session. Persisted sessions restore transcript context, not bash approval
  grants or a durable mid-run input inbox.
- Provider selection supports DeepSeek, Kimi, and Qwen through one-shot and
  interactive `--provider` / `--model` overrides plus environment
  configuration (`KEEL_PROVIDER`, provider-specific API keys, base URLs, and
  model env vars). Cost tracking fail-closes when a selected model has unknown
  pricing.
- Provider retry/backoff is in place for request setup failures and
  pre-stream HTTP 408 / 409 / 429 / 5xx responses, including retry notices,
  `retry-after-ms`, `Retry-After`, per-wait ceilings, and a total retry
  delay budget. Mid-stream failures after non-empty assistant output or tool
  calls still fail the turn; context overflow before assistant output is
  handled by compaction and one retry, not provider replay.
- Same-turn batches made only of parallel-safe read tools (`read`, `ls`,
  `glob`, `grep`) run concurrently with source-ordered results. Any batch
  containing `edit`, `write`, or `bash` currently falls back to sequential
  execution; there is no resource-aware mixed-batch scheduler yet.
- Edit remains single-replacement per tool call (or `replaceAll` for one
  target string). Keel has fuzzy matching for common copy/paste drift,
  enforced read-before-edit for updates, and an initial apply_patch path for
  coordinated Add/Update patches, but no broad multi-edit-per-file operation.
- Eval results compare keel across versions; cross-agent comparisons are
  intentionally deferred until the core coding loop is more complete and the
  suite has a larger real-task corpus.

## P0 — Blocks daily use or makes the quality goal unfalsifiable

1. **Interactive session with steering.** ✅ Partial (2026-06): `keel`
   now starts an interactive session; follow-up messages reuse context, and
   user input typed while tools are running is injected after completed tool
   results at the next model request. Remaining work is clearer interactive
   UX, a durable input inbox, and session-level reporting. Real coding is
   conversational: follow-ups, corrections, "now also fix the tests" —
   including while a run is in progress. Daily use also generates the
   real-task corpus the eval suite needs.
2. **General provider/model configuration.**
   ✅ Partial (2026-06): DeepSeek, Kimi, and Qwen are wired through
   one-shot and interactive `--provider` / `--model` overrides,
   `KEEL_PROVIDER`, provider-specific API keys, base URLs, model env vars
   including `DEEPSEEK_MODEL`, and reports that identify provider/model for
   one-shot runs. Remaining work is provider profile metadata beyond the
   current resolver and pricing maps, additional frontier providers when
   needed, and clearer interactive-session reporting for the selected
   provider/model. This carries daily-use weight because switching frontier
   models should not require code changes. Cross-agent same-model evals remain
   useful later, but are not the next slice while the core coding loop still
   has basic gaps.
3. **Context compaction and overflow recovery.** ✅ Partial (2026-06):
   automatic compaction can trigger before oversized requests, summarizes old
   turns without cutting inside a current tool-call/result suffix, compacts
   stale large tool output, supports manual `/compact [focus]`, and recovers
   from provider context overflow before assistant output by compacting and
   retrying once. Remaining work is proving summary quality on real long
   tasks, handling more mid-stream overflow cases safely, and tuning provider
   context windows.
4. **Harness eval measurement loop.** ✅ Baseline done (2026-06): `keel eval`
   runs deterministic outcome-graded task directories from `evals/tasks`,
   appends per-trial JSONL results, supports multi-trial runs, and
   validates each task's reference solution via `--check`. Optional
   `--transcript-dir` writes provider-visible per-trial transcripts and
   records their paths in the JSONL results. The current seed suite covers
   exact edits, search/edit, multi-file rename, new file creation,
   bash-driven test fixing, long-file editing, stale edit recovery,
   repeated-string disambiguation, test-preserving bug fixes, and
   pattern-following feature additions. The next work is corpus growth from
   real daily-use failures and transcript comparison tooling. External agent
   runners and cross-agent same-model comparisons should wait until the
   basic daily-use capabilities below are stronger and `keel eval` has
   enough real usage to make the comparison meaningful.
5. **Completed P0 foundations.** ✅ Done/partial (2026-06): provider retry
   with backoff now handles request setup failures and pre-stream HTTP
   408 / 409 / 429 / 5xx, honors `retry-after-ms` / `Retry-After`, emits a
   user-visible retry notice, respects retry budgets, and leaves mid-stream
   replay and overflow recovery out of scope. The 64-turn cap now ends with
   a summary instead of a thrown error. `--bash-policy ask` supports
   per-command approval in interactive sessions and fails closed when no
   approval UI is available. These should inform future slices but no longer
   determine the next P0 pick.

## P1 — Daily friction and the harness-quality competitive surface

Usable without these, but each removes a reason to fall back to
Codex/Claude Code — or directly moves the eval numbers.

- **Edit reliability.** ✅ Partial (2026-06): single-target edit now handles
  line-ending drift, trailing whitespace, smart punctuation, common
  indentation, `replaceAll`, enforced read-before-edit, and an initial
  apply_patch Add/Update strategy for coordinated larger changes. Remaining
  gaps are broader multi-edit per file, stronger stale-context recovery, and
  fuller diff semantics. Edit success rate is a tracked eval sub-metric.
- **Project context injection** — ✅ Partial (2026-06): root `AGENTS.md` is
  loaded into the system prompt with safety checks. Remaining work is support
  for nested or alternate project-instruction files when that becomes a real
  daily-use need.
- **File discovery tools** — ✅ Done (2026-06): `glob` discovers files by
  path pattern before reading, and `ls` lists directory entries with ignore
  policy enforcement.
- **Parallel tool execution.** ✅ Partial (2026-06): all-parallel-safe
  same-turn batches now overlap while preserving source-order tool results;
  exclusive batches still run sequentially. Remaining work is
  resource-aware mixed-batch scheduling that can parallelize independent
  reads while serializing writes.
- **Session persistence / resume.** ✅ Partial (2026-06): named interactive
  sessions persist JSONL ledgers and rebuild transcript context on
  `--resume`, including compaction replacement records and active-session
  locks. Remaining work is whole-task undo, fork/branch semantics, durable
  queued input, and future sub-agent state.
- **Bash approval hardening** — richer command parsing/risk
  classification, safer prefix approvals beyond exact command + cwd,
  and persistent approval rules. OS sandboxing remains P2.
- **Whole-task undo** — `/undo` restores the last edit, created file, or
  apply_patch batch checkpoint; a failed task should roll back as a unit.

## P2 — After the replacement works

Not needed to switch; revisit once P0/P1 are done.

- MCP support
- Sub-agents
- Plan mode
- IDE integration
- OS-level sandboxing for bash (Seatbelt on macOS, bubblewrap on Linux —
  the codex pattern), upgrading **Bash approval hardening** from approval
  to enforcement
- Prompt-cache-aware context layout (inject dynamic state at turn
  boundaries, keep the prefix stable — the codex/kimi pattern; shows up
  directly in the token eval metric)

## Reference Harness Facts (2026-06 survey)

All five columns are verifiable against the submodules in this repo.
The `claude-code/` submodule carries the leaked Claude Code source
(2026-03-31 leak; Anthropic's official repo remains closed source), and
its column matches both that source and the 2026 arXiv "Dive into Claude
Code" study. Re-verify before relying on a detail. Use this table to
sanity-check any slice design against prior art.

| Capability | Claude Code (leaked source) | Codex CLI | Kimi Code | pi | opencode |
|---|---|---|---|---|---|
| Turn limit | None known; context pressure managed before every model call | None; compaction + steering | maxSteps/turn + tiered dedup escalation | shouldStopAfterTurn hook | 25-step bound (V2) + forced text finish |
| Compaction | 5-layer pipeline (budget → snip → microcompact → collapse → auto-compact); `cache_edits` prunes cached tool results without cache miss; session-memory file replaces LLM summary | Pre-turn + mid-turn auto, local or remote | Blocking full + experimental micro | Token-reserve trigger, split-turn summaries | Summary checkpoint + tool-output pruning |
| Edit strategy | String replacement with enforced read-before-edit | apply_patch DSL (file-level diffs) | Exact match + replace_all | Multi-edit, fuzzy normalize | 9-level replacer chain |
| Approval | 7 permission modes (plan → bypass), deny-first rules, ML auto-classifier, shell sandbox, 27 hook events | 5-tier policy + LLM guardian + OS sandbox | Policy chain (manual/auto/yolo) | Extension hooks only | allow/deny/ask ruleset + session cache |
| Retry | `withRetry` wrapper (~3 attempts); manual retry on the streaming path | (managed in client) | Per-step retries, exponential backoff | Backoff, overflow excluded | Effect.retry, honors Retry-After |
| Sessions | Resumable transcripts; permissions never restored on resume; 10-section session-memory markdown | JSONL rollout + SQLite, fork/resume | Event-sourced wire.jsonl | JSONL tree, fork/branch | SQLite + durable input inbox |
| Parallel tools | Yes; subagents return summaries only | Read/write lock runtime | Resource-based scheduler | Parallel by default | Tool fibers |
| Eval infra | Internal to Anthropic; none shipped | Mock-API integration suite + rollout traces | Deterministic harness tests | Faux-provider suite | HTTP-cassette VCR tests |

None of the five ships a user-facing per-task quality eval suite of the
kind **Harness eval measurement loop** describes. That is keel's open lane.

## Non-Goals

- Matching Codex/Claude Code/Kimi Code feature-for-feature. Keel does not
  compete on breadth; it competes on per-task execution quality under the
  metrics above.
- TUI polish before the P0 capabilities exist.
- Winning benchmarks keel's author does not personally care about. The
  eval suite is built from real daily tasks, not leaderboard tasks.
