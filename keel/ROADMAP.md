# Roadmap

## North Star

Two goals, in order:

1. **Keel replaces Codex CLI and Claude Code as the author's daily coding
   agent.**
2. **Keel's harness execution quality exceeds Claude Code, Codex, and
   Kimi Code** — measured on the same model and the same tasks.

The ordering is a product gate, not just a list. First make Keel usable enough
that the author can reach for it instead of the reference agents in
`claude-code/`, `codex/`, `kimi-code/`, `opencode/`, and `pi/` for ordinary
coding work. During this replacement phase, the next slice should usually be a
missing core capability in the interactive/provider/context/edit/session/approval
loop. Keep evals as a regression guard for real product fixes, but defer
standalone eval-corpus growth, external runners, and cross-agent comparisons
until Keel is already credible as the daily driver.

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

Do not mistake measurement infrastructure for the next product slice while
basic daily-use capabilities are still incomplete. Eval coverage is how keel
proves a harness change helped; it is not a replacement for the missing
interactive, provider/model, context, edit, session, and approval capabilities
that make keel usable in the first place. Until keel is credible as a daily
coding agent, prefer the highest user-runnable P0/P1 product gap over a
standalone eval-corpus-growth slice. Add or update eval tasks when they are
attached to a real product fix or when a real failure must be preserved for
regression, but do not let eval work displace foundational usability.

Keel is pre-release. Optimize the roadmap for a coherent first usable product,
not for compatibility with old internal schemas or unfinished command shapes.
Breaking session, report, eval, or provider-config formats is acceptable when it
simplifies the product model, as long as each merged slice remains runnable and
safety boundaries stay intact.

## Current State (2026-06)

What a user can do today:

- `keel "<message>"` — one-shot agent run: streamed text, multi-round tool
  calls (read / ls / glob / grep / edit / write / apply_patch / bash),
  recoverable tool errors with LLM-facing recovery hints, tool progress on stderr, graceful stop with
  a progress summary when the 64-turn limit is exhausted.
- `keel` — interactive in-process session: sequential follow-up messages
  reuse prior user / assistant / tool context from the same terminal run;
  input typed while a tool turn is running is injected after tool results at
  the next model request. Real TTY sessions render a stable terminal display
  with a session intro, `keel>` prompts, `status:` progress lines, and an
  `assistant:` header. Local commands include `/help`, `/undo`, `/model`,
  `/skill`, `/compact`, `/fork`, and `/fork-points`.
- `keel --session <id>` / `keel --resume <id>` / `keel sessions` /
  `keel sessions fork <source-id> <target-id> [--before-message <id>]` —
  persist, resume, list, and fork interactive transcripts as JSONL session
  ledgers, with schema validation, workspace checks, active-session locks,
  bounded snapshots, replay of queued input that was admitted but not yet
  consumed, active model switches, workflow skill identity, and independent
  fork ledgers that continue from completed restored history without copying
  the source session's pending queued input.
- Interactive `/compact [focus]` — manually replace older conversation with
  a model-generated checkpoint summary; automatic compaction also runs before
  oversized requests and retries once after provider context overflow before
  assistant output starts.
- Root `AGENTS.md` project instructions are injected into the system prompt
  when present. Nested `AGENTS.md` files are surfaced by read/search outputs
  for scoped paths and enforced before mutations in that scope. Instruction
  files have workspace, ignore-policy, file-type, UTF-8, symlink, and size
  checks before content is sent to the provider.
- `keel skills` / `keel --skill <name>` — list and explicitly bind a local
  workflow skill from `.agents/skills/<name>/SKILL.md`; selected skill
  instructions are injected into the system prompt with bounded resource-path
  discovery under `references/`, `scripts/`, and `assets/`.
- `keel --allow-bash` / `keel --bash-policy trusted` — trusted shell
  mode (all-or-nothing).
- `keel --bash-policy ask` — expose bash while requiring per-command
  approval in interactive sessions, with exact command + cwd approval and
  conservative command-family + cwd approval remembered for the
  process-local session. Approval prompts include deterministic risk labels
  for workspace-read, project-verification, workspace-write, and
  unknown/dangerous commands, and verification-family approvals cover common
  project checks such as `pnpm test`, `pnpm typecheck`, `pnpm lint`, and
  `pnpm build`. One-shot runs fail closed because there is no approval UI;
  forced non-TTY interactive runs also reject `ask` so approvals cannot be read
  from piped input.
- `keel --max-cost <usd>` — one-shot or interactive session cost tracking
  with budget stop.
- `keel --report <file>` — write a machine-readable one-shot or interactive
  session report with turns, stop reason, token usage, duration,
  provider/model, and cost when tracked.
- `keel --transcript <file>` — write provider-visible one-shot messages as
  schema-versioned JSONL.
- `keel eval [--check] [--trials <n>]` — run a repeatable harness eval suite
  from `evals/tasks`, with per-trial JSONL results and reference-solution
  verifier checks. `--transcript-dir <dir>` keeps one readable transcript
  artifact per trial and links it from the result JSONL when produced.
  `keel eval compare --base <old.jsonl> --head <new.jsonl>` compares two
  result files by task, including pass, outcome, turn, token, cost, wall-time,
  harness-failure, and regression transcript-path deltas.
- `keel /undo` — restore the last edit, created file, or apply_patch batch
  checkpoint.
- `keel --doctor` — environment check for bundled ripgrep plus the selected
  provider/model/API-key/base-url/context/cost-model state; by default it also
  verifies real provider auth with a low-cost online models endpoint, while
  `--offline` keeps the check local-only.

Known limits that shape the priorities below:

- Interactive sessions have a minimal stable terminal display, but no
  full-screen TUI or richer session browser. Persisted sessions restore
  transcript context, pending queued input, active model switches, and workflow
  skill identity, and can fork a completed restored history or a restored
  user-message point into an independent named session. `/fork --pick` provides
  an interactive fork-point picker, but richer branch browsing and future
  sub-agent state are still absent. Forks do not copy bash approval grants.
- Provider selection supports DeepSeek, Kimi, and Qwen through one-shot and
  interactive `--provider` / `--model` overrides plus environment
  configuration (`KEEL_PROVIDER`, provider-specific API keys, base URLs, and
  model env vars). Interactive `/model <provider>/<model>` switches later
  prompts, persists the active selection for named sessions, and compacts when
  moving to a smaller known context window. A model metadata registry supplies
  context windows, capabilities, pricing, doctor diagnostics, and a
  `pnpm check:model-metadata` drift check against models.dev. Cost tracking
  fail-closes when a selected model has unknown pricing. Remaining provider
  work is richer profile metadata and additional frontier providers when
  needed.
- Provider retry/backoff is in place for request setup failures and
  pre-stream HTTP 408 / 409 / 429 / 5xx responses, including retry notices,
  `retry-after-ms`, `Retry-After`, per-wait ceilings, and a total retry
  delay budget. Provider `length` stop reasons are surfaced as
  `provider_length`. Mid-stream failures after non-empty assistant output or
  tool calls still fail the turn; context overflow before assistant output is
  handled by compaction and one retry, not provider replay.
- Same-turn tool calls run through resource-aware scheduling with
  source-ordered results. Non-conflicting `read`, `ls`, `glob`, `grep`,
  `edit`, `write`, and `apply_patch` resources can share same-turn batches;
  asynchronous tools can overlap while synchronous file mutations still execute
  on the Node event loop. Same-file or tree-overlapping work, `AGENTS.md`
  mutations, `bash`, and unmodeled effects stay serialized.
- Edit supports multiple replacements per file tool call, `replaceAll` for
  individual targets, fuzzy matching for common copy/paste drift,
  enforced read-before-edit for updates, and apply_patch Add/Update/Delete/Move
  batches. Remaining gaps are stronger stale-context recovery and fuller diff
  semantics.
- Eval results compare keel across versions; cross-agent comparisons are
  intentionally deferred until the core coding loop is more complete and the
  suite has a larger real-task corpus.
- Workflow expansion features are not the current bottleneck. The first local
  explicit workflow skill slices are in place for user-invoked project
  workflows. Sub-agents, MCP, marketplaces, auto-activation, and IDE
  integration should still wait until keel is credible as a standalone coding
  agent. These features depend on stable tool, permission, session, context,
  report, and failure-recovery semantics; before that, they multiply unresolved
  failure modes instead of improving task success.

## P0 — Blocks daily use or makes the quality goal unfalsifiable

1. **Interactive session with steering.** ✅ Partial (2026-06): `keel`
   starts an interactive session; follow-up messages reuse context, user input
   typed while tools are running is injected after completed tool results at the
   next model request, and local commands cover help, undo, model switching,
   skill status, manual compaction, forking, and fork-point listing. Named
   sessions persist transcripts, compaction replacement records, unconsumed
   queued input, active model switches, and workflow skill identity;
   interactive `--report` records session-level turns, usage, provider/model,
   models used, and cost. Real TTY sessions now have stable prompt/status
   chrome; remaining work is full-screen or richer session UI, richer branch
   browsing, and future sub-agent state. Real coding is conversational:
   follow-ups, corrections, "now also fix the tests" —
   including while a run is in progress. Daily use also generates the real-task
   corpus the eval suite needs.
2. **General provider/model configuration.**
   ✅ Baseline done (2026-06): DeepSeek, Kimi, and Qwen are wired through
   one-shot and interactive `--provider` / `--model` overrides,
   `KEEL_PROVIDER`, provider-specific API keys, base URLs, provider-specific
   model env vars, interactive `/model` switching, persisted active
   session model state, and reports that identify provider/model for one-shot
   and interactive runs. The model metadata registry now drives context-window,
   capability, pricing, doctor, cost, and model-switch compaction behavior, with
   `pnpm check:model-metadata` guarding drift for monitored models. Remaining
   work is additional frontier providers and richer provider profiles when a
   daily-use need appears, not basic provider/model configuration.
3. **Context compaction and overflow recovery.** ✅ Partial (2026-06):
   automatic compaction can trigger before oversized requests, summarizes old
   turns without cutting inside a current tool-call/result suffix, compacts
   stale large tool output, supports manual `/compact [focus]`, restores
   visible reads and scoped project instructions after compaction, compacts for
   model switches to smaller known context windows, and recovers from provider
   context overflow before assistant output by compacting and retrying once.
   Remaining work is proving summary quality on real long tasks, handling more
   mid-stream overflow cases safely, and tuning provider context windows.
4. **Minimum harness eval loop.** ✅ Baseline done (2026-06): `keel eval`
   runs deterministic outcome-graded task directories from `evals/tasks`,
   appends per-trial JSONL results, supports multi-trial runs, and validates
   each task's reference solution via `--check`. Optional `--transcript-dir`
   writes provider-visible per-trial transcripts and records their paths in the
   JSONL results. The current seed suite covers exact edits, search/edit,
   multi-file rename, new file creation, bash-driven test fixing, long-file
   editing, stale edit recovery, repeated-string disambiguation,
   test-preserving bug fixes, and pattern-following feature additions. Result
   comparison now reports per-task score and efficiency deltas with transcript
   paths for regressions. This baseline is enough to keep the quality goal
   falsifiable while replacement work continues. Add or update eval tasks when
   a real daily-use failure is being fixed or preserved, but do not pick
   standalone corpus growth, external agent runners, or cross-agent same-model
   comparisons before the unresolved daily-use gaps in interactive UX, provider
   breadth/profile metadata, context reliability, edit reliability, session
   workflow, and approval ergonomics.
5. **Completed P0 foundations.** ✅ Done/partial (2026-06): provider retry
   with backoff now handles request setup failures and pre-stream HTTP
   408 / 409 / 429 / 5xx, honors `retry-after-ms` / `Retry-After`, emits a
   user-visible retry notice, respects retry budgets, and surfaces provider
   `length` stops as `provider_length`; mid-stream replay remains out of
   scope. The 64-turn cap now ends with a summary instead of a thrown error.
   `--bash-policy ask` supports
   per-command approval in interactive sessions and fails closed when no
   approval UI is available. These should inform future slices but no longer
   determine the next P0 pick.

## P1 — Daily friction and the harness-quality competitive surface

Usable without these, but each removes a reason to fall back to
Codex/Claude Code — or directly moves the eval numbers.

- **Edit reliability.** ✅ Partial (2026-06): single-target edit now handles
  line-ending drift, trailing whitespace, smart punctuation, common
  indentation, `replaceAll`, enforced read-before-edit, multi-replacement
  edit calls for one file, and apply_patch Add/Update/Delete/Move batches for
  coordinated larger changes. Remaining gaps are stronger stale-context
  recovery and fuller diff semantics. Edit success rate is a tracked
  eval sub-metric.
- **Project context injection** — ✅ Partial (2026-06): root `AGENTS.md` is
  loaded into the system prompt with safety checks. Nested `AGENTS.md` files are
  discovered for scoped paths, shown through read/search outputs, restored after
  compaction when still valid, and required before edits, writes, or
  apply_patch mutations in that scope. The supported project-instruction format
  is intentionally `AGENTS.md`; alternate files such as `CLAUDE.md` are not
  supported unless a real daily-use need appears.
- **File discovery tools** — ✅ Done (2026-06): `glob` discovers files by
  path pattern before reading, and `ls` lists directory entries with ignore
  policy enforcement.
- **Parallel tool execution.** ✅ Done (2026-06): same-turn batches now use
  resource-aware scheduling while preserving source-order tool results. Reads,
  searches, independent file edits, independent file creates, and non-overlapping
  apply_patch operations can be scheduled together; conflicting file/tree
  resources, `AGENTS.md` mutations, `bash`, and unmodeled effects remain
  serialized.
- **Session persistence / resume.** ✅ Partial (2026-06): named interactive
  sessions persist JSONL ledgers and rebuild transcript context on
  `--resume`, including compaction replacement records, active-session locks,
  unconsumed queued input, bounded snapshots, active model switches, and
  workflow skill identity. `keel sessions fork <source-id> <target-id>
  [--before-message <id>]`, `keel --resume <id> --fork-points`, and interactive
  `/fork [--before-message <id>|--pick]` create independent forks from restored
  history without copying pending queued input. Remaining work is richer session
  UI and future sub-agent state.
- **Bash approval hardening** — ✅ Partial (2026-06): `--bash-policy ask`
  prompts in interactive sessions, fails closed without an approval UI, records
  exact command + cwd approvals, and supports conservative process-local
  command-family approvals. Prompts now show deterministic risk labels so users
  can distinguish workspace-read commands, project verification commands,
  workspace-writing commands, and unknown/dangerous shell syntax before
  approving. Remaining work is deeper shell parsing, family-specific validators
  for additional commands where safe, and persistent approval rules. OS
  sandboxing remains P2.
- **Whole-task undo** — ✅ Partial (2026-06): `/undo` restores the last edit,
  created file, apply_patch batch, or multi-file task checkpoint. Remaining
  work is broader command grouping and user-facing controls for choosing older
  checkpoints.
- **Local workflow skills** — ✅ Partial (2026-06): explicit, local,
  user-invoked workflows are available through `keel skills` and
  `keel --skill <name>` from `.agents/skills/<name>/SKILL.md`. Selected skills
  are injected into one-shot or interactive prompts, persist with named
  sessions, are visible in `keel sessions` and interactive `/skill`, and expose
  bounded resource paths from `references/`, `scripts/`, and `assets/` without
  preloading resource contents. Remaining work should stay focused on daily-use
  UX and correctness for explicit local skills. Marketplace, auto-activation,
  multi-agent execution, and remote skill installation remain deferred.

## P2 — After the replacement works

Not needed to switch; revisit once P0/P1 are done.

- MCP support
- Sub-agents
- Plan mode
- IDE integration
- Skill marketplace or automatic skill activation
- Expanded eval corpus, external agent runners, and cross-agent same-model
  comparisons
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
