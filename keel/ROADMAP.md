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
task**, then **turns and tokens to completion**. Edit success rate is a
target sub-metric of the third that is not yet implemented. Anything not
measurable this way is not part of the goal.

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
not for compatibility with old internal data, draft schemas, or unfinished
command shapes. Do not add compatibility shims, migrations, fallback readers,
old CLI aliases, legacy schema support, or compatibility tests unless explicitly
requested. Breaking session, report, eval, or provider-config formats is
acceptable when it simplifies the product model, as long as each merged slice
remains runnable and safety boundaries stay intact.

## Current State (2026-08)

What a user can do today:

- `keel "<message>"` — one-shot agent run: streamed text, multi-round tool
  calls (read / ls / glob / grep / edit / write / apply_patch / bash),
  recoverable tool errors with LLM-facing recovery hints, tool progress on stderr, graceful stop with
  a progress summary when the 64-turn limit is exhausted.
- `keel` — interactive in-process session: sequential follow-up messages
  reuse prior user / assistant / tool context from the same terminal run and
  persist completed turns to an automatic JSONL session ledger by default;
  `keel --ephemeral` keeps the conversation process-local. Input typed while a
  tool turn is running is injected after tool results at the next model
  request. Real TTY sessions render a differential terminal display with a
  multiline composer, bracketed paste, draft-preserving history and resize,
  visible `steer/next` / queued-command dispositions, transient provider/tool
  activity, persistent durable Goal status, session intro, `status:` progress
  lines, and an `assistant:` header.
  Local commands include `/help`, `/undo`, `/model`, `/skill`,
  `/skills active`, `/skill deactivate`, `/skill reload`, `/status`,
  `/approvals`, `/compact`, `/fork`, and `/fork-points`.
- `keel goal --objective <text> --verify <command> ...` — run one saved,
  command-verified Goal without an interactive terminal. The command prints the
  resumable session id before provider work, preserves the interactive Goal
  state machine and Runtime-owned final verifier, returns stable exit codes for
  completed / blocked / limited outcomes, and adds bounded `goalOutcome`
  metadata to `--report` output. Trusted Bash or a matching saved project
  approval is required before provider spend.
- `keel --session <id>` / `keel --resume <id>` / `keel sessions` /
  `keel sessions fork <source-id> <target-id> [--before-message <id>]` —
  name, resume, list, and fork interactive transcripts as JSONL session
  ledgers, with schema validation, workspace checks, active-session locks,
  bounded snapshots, replay of queued input that was admitted but not yet
  consumed, active model switches, durable workflow-skill activation snapshots,
  and independent fork ledgers that continue from completed restored history
  without copying the source session's pending queued input.
  `keel sessions archive <id>` reversibly removes an inactive session from
  normal catalog, picker, and resume discovery while preserving its complete
  ledger and agent tree; `keel sessions archived` lists archived work and
  `keel sessions unarchive <id>` restores it under the same reserved identity.
- Interactive `/compact [focus]` — manually replace older conversation with
  a model-generated checkpoint summary; automatic compaction also runs before
  oversized requests and retries once after provider context overflow before
  assistant output starts.
- Root `AGENTS.md` project instructions are injected into the system prompt
  when present. Nested `AGENTS.md` files are surfaced by read/search outputs
  for scoped paths and enforced before mutations in that scope. Instruction
  files have workspace, ignore-policy, file-type, UTF-8, symlink, and size
  checks before content is sent to the provider.
- `keel skills` / repeatable `keel --skill <name>` — discover workflow skills
  from repository, user, system, and configured extra roots, resolve
  collision-safe qualified identities, and explicitly activate one or more
  skills. `$name` and interactive `/skill name` provide deterministic explicit
  activation, while eligible metadata is exposed through a bounded catalog so
  the model can search for and activate matching bodies on demand. Named
  sessions persist exact activation snapshots across resume, fork, and
  compaction; `/skills active`, `/skill deactivate`, and `/skill reload` expose
  lifecycle state. `--no-skills` suppresses the entire Skill surface for one
  run, while `keel skills enable|disable <name|--all>` persists reversible
  global and per-package controls without rewriting saved session snapshots.
  Bounded resource paths under `references/`, `scripts/`, and `assets/` remain
  unloaded until requested.
- `keel --allow-bash` / `keel --bash-policy trusted` — trusted shell
  mode (all-or-nothing).
- `keel --bash-policy ask` — expose bash while requiring per-command
  approval in real TTY one-shot runs and interactive sessions, with exact
  command + cwd approval and conservative command-family + cwd approval
  remembered for the current one-shot run or active interactive session, plus
  project-scoped persistent approvals for conservative command families.
  Non-TTY one-shot runs can use saved project approvals but still fail closed
  when no matching approval already exists, so approvals cannot be read from
  piped input. `keel approvals` lists, revokes, or clears project bash
  approvals for the current project. Interactive grants are restored by
  named-session resume. Interactive
  `/approvals` lists active bash approvals and can revoke one approval or clear
  all session approvals before later matching commands run. Approval prompts include
  deterministic risk labels for workspace-read, project-verification,
  workspace-write, and unknown/dangerous commands, and verification-family
  approvals cover common project checks such as `pnpm test`, `pnpm typecheck`,
  `pnpm lint`, and `pnpm build`.
- `keel --max-cost <usd>` — one-shot or interactive best-effort session cost
  budget with conservative request admission, provider output bounds, and
  post-response accounting.
- `keel --agent-policy explicit --max-cost <usd> "<message>"` — stable,
  default-off #590 foreground read-only orchestration for explicit user
  requests. `--agent-policy auto` is a separate opt-in policy that lets the
  model select delegation without an explicit request. Main may
  delegate one or several fresh-context workspace investigations, shows bounded
  lifecycle progress, shares the root cost budget, waits for real
  cancellation/settlement, and remains the only final answerer. Slice 2.2
  admits up to four active children and eight total children per root run.
  Independent delegate calls in one pure-delegate tool round use the shared
  scheduler and settle in source order; sibling failure is isolated. Tree-level
  continuation, child, and aggregate result budgets price every fresh,
  rejected, or replayed source outcome. Two physical provider request slots are
  separate from agent-run slots, with shared retry/backoff, auth/quota circuit,
  and parent cancellation. Slice 1.5 historically established **Continue for
  explicit user-directed development**: autonomous eligible prompts selected a
  child 0/6 times, but the separately frozen exact prefix
  `使用 subagent 调研这个任务。` selected one child 6/6 times. Slice 2.3
  promotes that semantic explicit-intent path to the stable CLI without a
  keyword dispatcher; autonomous selection remains an explicit opt-in. Slice
  1.6 then
  removes the model-authored `submit_agent_result` protocol: a child now ends
  with a normal final message, while the host creates a typed, bounded,
  tool-agnostic handoff with a reference to the complete transcript. The root
  budget leases one admitted main continuation before child work by pricing the
  finalized provider-shaped assistant and bounded tool-result envelopes. The
  root ledger holds that reservation until child settlement, child minimum
  admission uses the same finalized request shape, mixed delegate/tool rounds
  are rejected before child creation, and `delegate` remains available while
  tree admission and provider health permit another child. Main receives each
  bounded child conclusion and terminal metadata, then decides for itself
  whether further verification is warranted. Invalid arguments for a currently
  exposed `delegate` call are recoverable without starting a child or consuming
  a child slot. The final historical Slice 1.6 v8 DeepSeek window passed all 12
  arms: controls 6/6,
  treatments 6/6, exactly one completed child 6/6, zero cost overshoot, and
  delegate-only assistant turns 6/6. No handoff included read-specific
  evidence. All six mains still repeated some read/search work after child
  completion, and treatment remained slower and more expensive in this serial
  corpus. That window proved explicit single-child completion reliability, not
  autonomous selection, lower cost, or the elimination of duplicate work;
  Slice 2.2 separately proves deterministic transport overlap and a 3/3 real
  DeepSeek explicit parallel window. Slice 2.3's stable-policy V3 window then
  passed 12/12 arms: ordinary explicit intent selected 2, 3, and 2 completed
  children across three treatments, while the small-task negative selected
  none in 3/3. It also confirmed that positive treatments remained slower,
  more expensive, and subject to repeated main investigation. See the
  [autonomous-selection result](evals/experiments/subagent-slice-1-5/RESULTS.md),
  [explicit-intent result](evals/experiments/subagent-explicit-intent-v1/RESULTS.md),
  [Slice 1.6 completion result](evals/experiments/subagent-slice-1-6/RESULTS.md),
  [stable-policy result](evals/experiments/subagent-slice-2-3/RESULTS.md),
  [product-graduation V1](evals/experiments/subagent-slice-6-2/RESULTS.md), and
  [orchestration V2](evals/experiments/subagent-slice-6-3/RESULTS.md) results.
  Saved interactive sessions also keep an independent append-only agent tree
  and incremental child transcripts. `/agents` lists durable runs and inspects
  live or durable facts and transcripts. A saved-session owner can keep an
  attached read-only child running across Main turns, then list, wait for, or
  cancel it; completion emits one bounded live notification, and owner exit
  cancels and settles every attached child before releasing the session. When
  a prior owner dies abnormally, its abandoned queued/running child is recovered
  once as `interrupted` instead of remaining falsely live. Projects can define
  `repo:*` profiles in `.agents/subagents.json` that select a registered child
  model/effort and narrow a built-in profile's tools, turns, deadline, and
  result bound and declare audited Skill and MCP ceilings. Each Run leases exact
  subsets. Child Skills use normal bounded activation; child MCP uses a fresh
  progressively disclosed runtime, exact saved project approvals, and current
  server/configuration/authorization-identity checks without copying Main's
  active tools or interactive approval channel. Resume can only preserve or
  remove persisted authority and revalidates current MCP identity. Accepted
  Threads retain their persisted capability and execution snapshots across
  config changes. The first writer slice adds one explicit-policy, foreground
  writer in a clean, isolated branch/worktree; its preparation is durable before
  Git side effects, its patch and location are reported, and it never edits,
  deletes, or merges the user's checkout. A completed writer Thread can now run
  an explicit foreground follow-up as the same Agent and a new immutable Run on
  that exact verified branch/worktree, preserving prior Run facts and the parent
  checkout. Explicit foreground read-only delegation now supports one governed
  nested level: depth-one children may delegate read-only foreground work, while
  depth-two children are leaves and the whole tree shares admission, budget,
  provider, cancellation, and durable history. Slice 6.2 kept all 18 arms
  correct but failed its selection/value gate. Slice 6.3 then tested a general
  decomposition/synthesis contract across release and service domains: all 30
  arms remained correct, but auto again selected no child, explicit selected
  multiple children in only 5/6 positives, every explicit Main repeated some
  completed child evidence, and the service treatments were materially slower
  and more expensive. The attempted prompt was reverted instead of shipping an
  unproven harness change. #590 therefore remains open; broader nested modes and
  default-on autonomous delegation are not justified by current evidence.
- `keel --report <file>` — write a machine-readable one-shot or interactive
  session report with report-local Tasks and Agent Runs, completed main-loop
  turns, human interventions attributed to the active Task and Agent Run,
  retry and context-recovery attribution, stop reason, token usage, duration,
  provider/model, cost when tracked, and whether changed files received an undo
  checkpoint. Terminal runtime failures best-effort finalize the active Task and
  Agent Run and add bounded redacted failure evidence; report-write failure does
  not replace the original runtime error.
- `keel --transcript <file>` — write provider-visible one-shot messages as
  schema-versioned JSONL.
- `keel eval [--check] [--trials <n>]` — run a repeatable harness eval suite
  from `evals/tasks`, with per-trial JSONL results and reference-solution
  verifier checks. `--transcript-dir <dir>` keeps one readable transcript
  artifact per trial and links it from the result JSONL when produced.
  `keel eval compare --base <old.jsonl> --head <new.jsonl>` compares two
  result files by task, including pass, outcome, turn, token, cost, wall-time,
  harness-failure, and regression transcript-path deltas.
- `keel /undo` / `keel /undo --list` / `keel /undo --to <index>` — restore
  the last edit, created file, apply_patch batch, or every checkpoint through
  a listed older checkpoint.
- `keel --doctor` — environment check for bundled ripgrep plus the selected
  provider/model/API-key/base-url/context/cost-model state; by default it also
  verifies real provider auth with a low-cost online models endpoint, while
  `--offline` keeps the check local-only.
- `keel mcp add <url>` / `keel mcp login|logout <server>` / `keel mcp list|status|doctor`
  / `keel mcp enable|disable|remove` / `keel mcp approvals` — register remote
  Streamable HTTP MCP servers, complete standards-compliant OAuth, inspect
  bounded catalog and health diagnostics, and manage exact project-scoped call
  approvals. Discovered tools stay outside the static builtin registry, are
  exposed to the model as `mcp__<server>__<tool>` through progressive
  `mcp_search` selection, and their results are recorded as untrusted evidence
  that cannot satisfy a Goal assertion.

Known limits that shape the priorities below:

- Interactive sessions have a minimal stable terminal display and a
  graph-aware in-session branch navigator. Persisted sessions restore
  transcript context, pending queued input, active model switches, and exact
  active workflow-skill snapshots, and can fork a completed restored history or
  a restored user-message point into an independent named session.
  `--resume --pick` and `/sessions` group related sessions into a graph-aware
  numbered tree, while `/fork --pick` provides an interactive fork-point
  picker. Saved-session subagents have independent durable tree state and
  `/agents` inspection; attached background children support live list, wait,
  and cancel while the current owner remains alive. Crash-safe parent delivery
  and terminal follow-up/resume are implemented; cross-process live takeover
  remains absent by design.
  Forks do not copy bash approval grants.
- Provider selection supports DeepSeek, Kimi, and Qwen through one-shot and
  interactive `--provider` / `--model` overrides plus environment
  configuration (`KEEL_PROVIDER`, provider-specific API keys, base URLs, and
  model env vars). Users can also run `keel auth login <provider>
  --with-api-key` to store a provider API key in `KEEL_HOME/auth.json` and
  `keel config set-provider <provider> [--model <id>] [--base-url <url>]` to
  persist non-secret provider defaults in `KEEL_HOME/config.json`; CLI flags
  override environment, environment overrides user config/auth, and
  `keel --doctor` reports the effective source without printing secrets.
  Interactive `/model <provider>/<model>` switches later prompts, persists the
  active selection for named sessions, and compacts when moving to a smaller
  known context window. A model metadata registry supplies context windows,
  capabilities, pricing, doctor diagnostics, and a
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
  batches. Stale or ambiguous edit failures now return bounded current-file
  diagnostics so the next model turn can retry from visible context. The
  remaining edit gap is fuller diff semantics.
- Eval results compare keel across versions; cross-agent comparisons are
  intentionally deferred until the core coding loop is more complete and the
  suite has a larger real-task corpus.
- Workflow expansion features are not the current bottleneck. The local Skill
  runtime now supports scoped discovery, explicit and model-selected activation,
  bounded search, multiple active Skills, and a durable lifecycle across
  compaction, resume, and fork. Deterministic package audit now excludes blocked
  Skills from routing and activation and exposes actionable diagnostics through
  `keel skills doctor`. The next Skill work should calibrate catalog routing and
  task outcomes before pinned distribution. Sub-agents now have stable
  default-off `off|explicit|auto` policy, foreground read-only parallelism,
  attached background control, crash-safe delivery, stable multi-Run child
  threads, built-in plus project-narrowed profiles, and per-Run governed Skill
  and MCP catalogs derived from profile/task leases. One explicit foreground
  writer now returns an inspectable isolated branch/worktree; broader write
  workflows and any default-on decision remain subject to the issue's
  reliability and same-budget value gates. Explicit foreground read-only
  nesting is bounded at depth two; background, writer, Bash, and auto nesting
  remain outside that slice. Marketplaces and IDE integration remain deferred.
- MCP covers remote Streamable HTTP servers only. stdio is deferred as a later
  transport over the same runtime and policy core, and Keel is a client only.
  Remaining work is calibrating progressive tool selection on real tasks.

## P0 — Blocks daily use or makes the quality goal unfalsifiable

1. **Interactive session with steering.** ✅ Partial (2026-06): `keel`
   starts an interactive session; follow-up messages reuse context, user input
   typed while tools are running is injected after completed tool results at the
   next model request, and local commands cover help, undo, model switching,
   skill status, manual compaction, forking, and fork-point listing. Named
   sessions persist transcripts, compaction replacement records, unconsumed
   queued input, active model switches, and workflow-skill activation history and
   active snapshots;
   interactive `--report` attributes report-local Tasks, Agent Runs, injected
   human interventions, main-loop turns, and recovery events while retaining
   session-level usage, provider/model, models used, and cost. Real TTY sessions
   now have a multiline composer with differential redraw, bracketed paste,
   history draft restoration, and resize handling, plus active-turn steering,
   deferred-command, approval, and operation-queue modes, transient activity,
   and persistent durable Goal status. The startup and `--resume --pick`
   session picker groups independent fork ledgers into a numbered branch tree;
   `/sessions` reuses that graph in a running process and transfers queued input
   to the selected ledger. Saved child runs and transcripts persist in an
   independent agent tree; attached background children remain owned across
   Main turns and are inspectable, waitable, and cancellable through `/agents`;
   result delivery is crash-safe, and stable child threads support follow-up
   input plus terminal resume as new immutable Runs. One explicit foreground
   writer can make an isolated, inspectable change from a clean checkout, then
   continue on the same verified worktree in a new immutable Run.
   A foreground read-only child under explicit policy can now delegate one
   foreground read-only level deeper with shared tree resources and durable
   lineage. Two frozen product-graduation windows preserved correctness but did
   not prove stable multiple-child selection or measurable value. A general
   decomposition/synthesis prompt did not change DeepSeek's zero-child auto
   behavior and was reverted. The remaining work is a product decision: test a
   materially different, generally justified model/profile orchestration
   contract on held-out tasks, or narrow the completion claim to the reliable
   explicit path while keeping auto experimental. Do not keep tuning wording on
   the same corpus or convert model judgment into Runtime routing rules.
   Real coding is conversational:
   follow-ups, corrections, "now also fix the tests" —
   including while a run is in progress. Daily use also generates the real-task
   corpus the eval suite needs.
2. **General provider/model configuration.**
   ✅ Baseline done (2026-07): DeepSeek, Kimi, and Qwen are wired through
   one-shot and interactive `--provider` / `--model` overrides,
   `KEEL_PROVIDER`, provider-specific API keys, base URLs, provider-specific
   model env vars, persisted `KEEL_HOME` auth/config files, interactive
   `/model` switching, persisted active session model state, and reports that
   identify provider/model for one-shot and interactive runs. The model metadata
   registry now drives context-window, capability, pricing, doctor, cost, and
   model-switch compaction behavior, with `pnpm check:model-metadata` guarding
   drift for monitored models. Remaining work is additional frontier providers
   and richer provider profiles when a daily-use need appears, not basic
   provider/model configuration.
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
   comparison now reports per-task score, human-intervention, and efficiency
   deltas with transcript paths for regressions. This baseline is enough to keep
   the quality goal falsifiable while replacement work continues. Add or update
   eval tasks when a real daily-use failure is being fixed or preserved, but do
   not pick standalone corpus growth, external agent runners, or cross-agent
   same-model comparisons before the unresolved daily-use gaps in interactive
   UX, provider breadth/profile metadata, context reliability, edit reliability,
   session workflow, and approval ergonomics.
5. **Completed P0 foundations.** ✅ Done/partial (2026-06): provider retry
   with backoff now handles request setup failures and pre-stream HTTP
   408 / 409 / 429 / 5xx, honors `retry-after-ms` / `Retry-After`, emits a
   user-visible retry notice, respects retry budgets, and surfaces provider
   `length` stops as `provider_length`; mid-stream replay remains out of
   scope. The 64-turn cap now ends with a summary instead of a thrown error.
   `--bash-policy ask` supports
   per-command approval in real TTY one-shot runs and interactive sessions,
   and fails closed when no approval UI is available. These should inform
   future slices but no longer determine the next P0 pick.

## P1 — Daily friction and the harness-quality competitive surface

Usable without these, but each removes a reason to fall back to
Codex/Claude Code — or directly moves the eval numbers.

- **Edit reliability.** ✅ Partial (2026-06): single-target edit now handles
  line-ending drift, trailing whitespace, smart punctuation, common
  indentation, `replaceAll`, enforced read-before-edit, multi-replacement
  edit calls for one file, and apply_patch Add/Update/Delete/Move batches for
  coordinated larger changes. Standard Git-style text diffs now cover updates,
  additions, deletions, and renames. Stale or ambiguous edit failures include
  bounded current-file diagnostics for retry. The remaining gap is fuller diff
  semantics such as copies, file modes, and binary patches. Edit success rate is
  named as a target sub-metric but is not implemented; `keel eval compare`
  reports the pass, outcome, human-intervention, turn, token, cost, wall-time,
  harness-failure, and regression transcript-path deltas listed above.
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
- **Session persistence / resume.** ✅ Partial (2026-06): default and named
  interactive sessions persist JSONL ledgers and rebuild transcript context on
  `--resume`, including compaction replacement records, active-session locks,
  unconsumed queued input, bounded snapshots, active model switches, and
  workflow-skill activation history and active snapshots. `keel --ephemeral`
  intentionally skips the ledger.
  `keel sessions fork <source-id> <target-id> [--before-message <id>]`,
  `keel --resume <id> --fork-points`, and interactive
  `/fork [--before-message <id>|--pick]` create independent forks from restored
  history without copying pending queued input. `keel --resume --pick` groups
  those ledgers into a graph-aware numbered tree, and `/sessions` switches the
  active ledger from the same graph without restarting Keel. Saved child runs
  and incremental transcripts use a separate append-only agent tree; attached
  background runs remain live only under the current owner, `/agents` can list,
  wait, or cancel them, and stale nonterminal runs recover as interrupted.
  Canonical result delivery is crash-safe, and stable child threads support
  follow-up input plus terminal resume as new immutable Runs. An explicit
  foreground writer is isolated and inspectable and can continue on its exact
  verified worktree. Explicit foreground read-only nesting is bounded at depth
  two and reuses the same tree admission, budget, provider, cancellation, and
  persistence boundaries. Two product-graduation windows did not prove stable
  selection or measurable value; the second prompt candidate was reverted, so
  broader governed write and nesting modes remain gated.
  Inactive sessions can be archived and unarchived as whole directory
  aggregates. Session locks are keyed by identity outside active/archive
  storage, so lifecycle moves cannot bypass a live owner.
- **Bash approval hardening** — ✅ Partial (2026-06): `--bash-policy ask`
  prompts in real TTY one-shot runs and interactive sessions, fails closed
  without an approval UI, records exact command + cwd approvals, supports
  conservative command-family approvals, restores active grants for
  named-session resume, saves project-scoped approvals for conservative command
  families, and exposes `/approvals` plus `keel approvals` to list, revoke, or
  clear active or project grants. Prompts now show deterministic risk labels so
  users can distinguish workspace-read commands, project verification commands,
  workspace-writing commands, and unknown/dangerous shell syntax before
  approving. Remaining work is deeper shell parsing, family-specific validators
  for additional commands where safe, and user-global approval rules. OS
  sandboxing remains P2.
- **Whole-task undo** — ✅ Partial (2026-07): `/undo` restores the last edit,
  created file, apply_patch batch, or multi-file task checkpoint, while
  `/undo --list` and `/undo --to <index>` let users choose an older listed
  checkpoint and restore through it atomically. A task whose checkpoint cannot
  be written now keeps the applied change but emits one visible warning;
  interactive `/status` and run reports expose the unavailable protection.
  Remaining work is broader command grouping and richer checkpoint preview/redo
  controls.
- **Local workflow skills** — ✅ Runtime complete (2026-07): strict Agent Skills
  packages are discovered across repository, user, system, and configured extra
  roots with collision-safe qualified identities. Users can explicitly activate
  multiple Skills through repeatable `--skill`, `$name`, or `/skill name`; the
  model receives a bounded metadata catalog with search and activates matching
  bodies through the dedicated `skill` tool. Activation snapshots, arguments,
  digests, active state, and history persist across compaction, resume, and fork;
  changed files are diagnosed without silently replacing the session snapshot,
  and `/skill reload` or `/skill deactivate` provides explicit control. Reports
  expose activation events, final active state, and the effective Skill policy.
  `--no-skills` provides an absolute one-run shutdown; persisted global and
  per-package enable/disable controls filter discovery, tools, explicit
  activation, and restored snapshots without erasing session history.
  Deterministic audit blocks invalid, obfuscated, secret-bearing, unreadable,
  or incompletely scanned
  packages before routing or activation; `keel skills doctor` reports blockers
  and advisory portability, script, authority, and dangerous-instruction
  findings without executing package code. Remaining work is catalog-budget and
  routing calibration through evals, then pinned installation and update.
  Marketplace, broader write-capable child workflows, and remote installation
  remain deferred.

## P2 — After the replacement works

Not needed to switch; revisit once P0/P1 are done.

- Sub-agents — #590 provides stable default-off `off|explicit|auto` policy,
  foreground read-only parallelism, durable history, and saved-session attached
  background list/wait/cancel, crash-safe result delivery, and stable multi-Run
  child threads. Built-in `explorer`/`reviewer` profiles derive model-visible
  tools and dispatcher authority from one persisted capability snapshot;
  project `repo:*` profiles can select a registered model/effort, narrow that
  built-in authority, and declare Skill/MCP ceilings from which each Run leases
  bounded catalogs. Child MCP uses fresh discovery plus exact saved approvals;
  Main-active tools and temporary interactive approvals are not inherited. An
  explicit-policy `writer` profile now provides one foreground isolated
  branch/worktree, a bounded inspectable patch, and explicit same-Thread
  foreground follow-up as a new immutable Run without auto-merge or auto-cleanup.
  Explicit-policy foreground read-only children may delegate one read-only
  foreground level deeper; depth-two children are leaves and share root tree
  resources. Two same-budget graduation windows kept correctness but failed
  stable multiple-child selection. V2's frozen aggregate-value subcriterion
  mechanically passed, but its movement was not attributable to child work and
  did not establish attributable within-domain subagent value; the cross-domain
  prompt candidate was reverted after auto selected no child and explicit
  remained costly. Broader writes, background/writer/auto nesting, and any
  default-on decision therefore remain gated rather than scheduled follow-ons.
- Plan mode
- IDE integration
- Skill marketplace
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
