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
  calls (read / grep / edit / write / bash), recoverable tool errors with
  LLM-facing recovery hints, tool progress on stderr, graceful stop with
  a progress summary when the 64-turn limit is exhausted.
- `keel --allow-bash` — trusted shell mode (all-or-nothing).
- `keel --max-cost <usd>` — cost tracking with budget stop.
- `keel /undo` — restore the last edit checkpoint.
- `keel --doctor` — environment check.

Known limits that shape the priorities below:

- One-shot only: no interactive session, no mid-run steering.
- Single hardcoded provider/model (`deepseek-v4-flash`).
- No provider retry: the first 429 or 5xx kills the run.
- Tool calls execute strictly sequentially.
- Exact-match single-string edit only.
- No way to measure harness quality against another agent.

## P0 — Blocks daily use or makes the quality goal unfalsifiable

1. **Interactive session with steering.** The CLI accepts one message and
   exits. Real coding is conversational: follow-ups, corrections, "now
   also fix the tests" — including while a run is in progress (every
   surveyed harness buffers mid-run user input and injects it at a turn
   boundary). Daily use also generates the real-task corpus the eval
   suite (P0-6) needs. Slice test: *a user starts `keel`, sends two
   related messages, and the second answer uses context from the first.*
   Steering can ship as a follow-up slice.
2. **Frontier-model provider.** Only `deepseek-v4-flash` is wired in.
   This carries double weight: daily use needs a frontier model, and
   proving harness superiority requires running the **same model** as
   Claude Code / Codex / Kimi Code in an A/B comparison. Slice test:
   *a user sets a different provider key and the same prompt runs
   end-to-end.*
3. **Provider retry with backoff.** A transient 429/5xx currently kills
   the whole run; keel already classifies these errors but never retries.
   Every reference harness retries with exponential backoff (opencode
   also honors `Retry-After`). Context overflow must be excluded from
   retry — it needs compaction, not repetition. Slice test: *a run that
   hits one 429 completes anyway; the user sees a retry notice, not a
   crash.*
4. **Survive medium tasks.** ✅ Done (2026-06): the turn cap is 64, and
   reaching it triggers a final summary turn ("what was done / what
   remains") instead of a thrown error. Full compaction is P1; this
   slice was the bridge.
5. **Per-command bash approval.** `--allow-bash` is all-or-nothing trust.
   Daily coding needs to run tests/builds without granting blanket shell
   access: prompt per command with a session-scoped "always allow"
   memory (the codex/opencode/kimi pattern), plus a non-interactive
   fallback. Slice test: *the agent proposes `pnpm test`, the user
   approves that one command, and a disallowed command stays blocked.*
6. **Harness eval baseline.** Without measurement, "keel's harness is
   better" is unfalsifiable. Start small: a repeatable suite of real
   tasks (drawn from actual daily use) that reports per-task success,
   interventions, turns, and tokens — first comparable across keel
   versions (regression detection), then across agents once P0-2 enables
   same-model runs. Public suites like Terminal-Bench can serve as a
   later external check, but the personal suite is the primary metric.
   Slice test: *one command runs the suite and prints a comparable
   per-task report.*

## P1 — Daily friction and the harness-quality competitive surface

Usable without these, but each removes a reason to fall back to
Codex/Claude Code — or directly moves the eval numbers.

- **Context compaction.** Standard equipment in all five reference
  harnesses, not a differentiator: token-threshold trigger, summarize
  old turns, never cut inside a tool-call/result pair, recover from
  provider overflow errors by compacting and retrying once. Directly
  drives long-task success rate.
- **Edit reliability.** Exact-match single edit fails on whitespace and
  staleness. References use tiered fallback matching (opencode: 9
  replacer levels; pi: Unicode/whitespace-normalized fuzzy match),
  multi-edit per file, and enforced read-before-edit (Claude Code
  rejects edits to files the agent has not read this session). Edit
  success rate is a tracked eval sub-metric.
- **Parallel tool execution.** Keel runs tool calls strictly
  sequentially. References parallelize reads while serializing writes
  via resource conflict rules (kimi's scheduler, codex's read/write
  locks). Cuts wall-clock time and turns.
- **Session persistence / resume.** All references persist sessions as
  append-only logs (JSONL / event sourcing) and rebuild state on resume.
  Also the foundation for whole-task undo and future sub-agents.
- **Project context injection** — read the project's AGENTS.md (or
  equivalent) into the system prompt.
- **File discovery tools** — `glob`/`ls`; today the model can only grep.
- **Whole-task undo** — `/undo` restores only the last edit checkpoint;
  a failed task should roll back as a unit.

## P2 — After the replacement works

Not needed to switch; revisit once P0/P1 are done.

- MCP support
- Sub-agents
- Plan mode
- IDE integration
- OS-level sandboxing for bash (Seatbelt on macOS, bubblewrap on Linux —
  the codex pattern), upgrading P0-5's approval flow from trust to
  enforcement
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
kind P0-6 describes. That is keel's open lane.

## Non-Goals

- Matching Codex/Claude Code/Kimi Code feature-for-feature. Keel does not
  compete on breadth; it competes on per-task execution quality under the
  metrics above.
- TUI polish before the P0 capabilities exist.
- Winning benchmarks keel's author does not personally care about. The
  eval suite is built from real daily tasks, not leaderboard tasks.
