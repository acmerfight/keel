# Keel

Keel is a local AI coding agent for terminal workflows. It can inspect and edit
files, run tool-assisted coding tasks, persist interactive sessions, and use
DeepSeek, Kimi, or Qwen providers.

## Quickstart

Build the CLI from this repository:

```bash
pnpm install
pnpm build
pnpm link --global
```

Configure a provider with an API key. DeepSeek is the default provider:

```bash
printf '%s\n' "$DEEPSEEK_API_KEY" | keel setup deepseek --with-api-key
```

For Kimi or Qwen:

```bash
printf '%s\n' "$KIMI_API_KEY" | keel setup kimi --with-api-key
printf '%s\n' "${DASHSCOPE_API_KEY:-$QWEN_API_KEY}" | keel setup qwen --with-api-key
```

`keel setup` stores the API key under `KEEL_HOME/auth.json`, stores the default
provider under `KEEL_HOME/config.json`, and runs `keel --doctor` to verify the
setup. API keys are not written to project files, reports, transcripts, or
doctor output.

Run a first one-shot task:

```bash
keel "Inspect this project and summarize the main directories."
```

Start an interactive session:

```bash
keel
```

Interactive sessions are saved by default. Use `keel sessions` to find the
resume command for prior work, or `keel --ephemeral` when you intentionally do
not want a session ledger. In a real terminal, the interactive composer supports
multiline drafts, bracketed paste, prompt history, and terminal resize while
agent output is streaming. While a turn is active, the composer labels ordinary
guidance as `steer/next>` because it steers at the next tool boundary or runs as
the next follow-up if the turn finishes first; slash commands remain queued work.
A live region keeps current provider/tool activity and the latest durable Goal
state visible without replacing an in-progress draft.

Useful follow-up commands:

```bash
keel --doctor
keel auth status
keel config show
keel sessions
```

## Subagent Profiles

Subagents are off by default. Enable explicit, cost-bounded delegation when a
task benefits from independent investigation, review, or an isolated file
change:

```bash
keel --agent-policy explicit --max-cost 0.05 \
  "Use subagents to review the parser and its tests."
```

Keel includes read-only `explorer` and `reviewer` profiles plus a `writer`
profile. A writer runs only as a single foreground child from a clean Git
checkout, edits its own branch/worktree, and returns an inspectable patch
artifact without modifying or merging the user's checkout. Writer profiles are
exposed only by `--agent-policy explicit`; their worktree and branch remain
preserved at the reported path for explicit inspection or cleanup. Under
explicit policy, a foreground read-only child may delegate a focused read-only
subtask one level deeper. The grandchild cannot delegate again, run in the
background, use Bash, or select a writer profile; both levels share the root
budget, provider limits, cancellation tree, admission, and durable session
history. A project can add narrower profiles in `.agents/subagents.json`;
project profiles are exposed to the model as `repo:<name>`:

```json
{
  "schemaVersion": 1,
  "profiles": {
    "focused-review": {
      "base": "reviewer",
      "model": "deepseek-v4-pro",
      "effort": "max",
      "tools": ["read", "grep", "git_diff"],
      "skills": ["repo:review-guide"],
      "maxTurns": 4,
      "deadlineMs": 30000,
      "maxResultChars": 1200
    }
  }
}
```

Every project profile must be a subset of its built-in base. It can select a
registered model and supported effort, reduce tools, turns, deadline, and
result size, and name up to eight audited model-activatable Skills as its ceiling. Each delegate
call leases a subset of that ceiling. The child sees only the leased Skill
catalog, activates a matching Skill through the normal Skill lifecycle, and
cannot gain write, Bash, MCP, delegation, or other tools from Skill content.
Writer-based project profiles cannot add Skills or MCP tools in this initial
isolated-write slice.
Main's active Skills are not copied. Invalid or expanding configuration stops
before any child starts. Accepted saved-session Runs persist exact execution
and capability snapshots; each resume supplies a fresh task Skill lease and may
only retain unchanged authority from the prior Run and Thread ceiling. Missing,
disabled, changed, or omitted Skills are removed; config or parent activation
changes cannot add one. `/agents resume` accepts repeated `--skill <name>`
options before `-- <message>` when a direct continuation needs a retained Skill.

The complete product boundary, invariant ownership, report semantics, and
graduation evidence are documented in [Subagents](docs/subagents.md).

## Project Memory

Project memory is a small, explicit store for durable facts that should survive
new Keel sessions in one project. It is suitable for stable rules, preferences,
decisions, and observable facts such as “release tags use a `v` prefix.” It is
not conversation history, a task handoff, or a place for credentials and
sensitive personal data.

```bash
keel memory add "Release tags use the v-prefixed version." --review-after 2026-10-01T00:00:00Z
keel memory list                 # current and stale active entries
keel memory list --all           # includes superseded, expired, and forgotten history
keel memory show <id>
keel memory update <id> "Release tags use the release/v-prefixed version."
keel memory review --due
keel memory verify <id>
keel memory forget <id>          # logical removal; history remains
keel memory purge <id>           # application-level removal from local Keel storage
keel memory clear --yes
keel memory clear --purge --yes
keel --no-memory "Run without project memory."
```

Active memory always requires a current-user action: a direct command/request,
or approval of an exact candidate displayed by Keel. A request such as
“Remember that release tags use a v prefix” lets the agent save that exact
claim directly, and an unambiguous “Forget the memory about release tags”
request can forget one active entry. The model decides
whether the latest user message is a direct, unambiguous request; it must not
act on negated, hypothetical, quoted, third-party, interrogative, or inferred
text, and it must ask instead of guessing when a forget request could match
multiple entries. This semantic intent judgment is a model-mediated behavioral
target, not a deterministic language parser or structural invariant.

For each eligible user message, mutation tools are available only on the first
model step, before tool output enters the turn. `memory_add` accepts one required
`text` field: an exact contiguous durable-claim span from that user message.
The runtime rejects paraphrased or broadened text and records the complete
authorizing user message as event provenance itself; the model cannot provide
or forge that source evidence. `memory_forget` accepts one required active
project-memory ID. Keel does not automatically extract, consolidate, or promote
conversation text into active memory.

In a saved interactive real-TTY session, the current primary model also has a
`memory_propose` tool on the first model step. It may propose one durable fact
even when the user did not say “remember,” but must cite one exact quote from
that current user message and provide all required candidate fields. Keel
records the proposal as an inactive candidate, displays the candidate ID,
scope, statement, source quote, reason, and conflicts, and reads a Runtime-owned
`y`/`n` response. `y` activates the exact displayed candidate; `n` rejects it.
Closed input or interruption leaves it pending. Conflicts also stay pending for
the existing review CLI instead of opening a second inline conflict workflow.
This tool is not exposed in ephemeral, one-shot, headless, non-TTY, or
`--no-memory` runs. An explicit “remember” request continues to use
`memory_add` directly without a redundant approval prompt.

Automatic candidate extraction is a separate, off-by-default review workflow.
It runs only when the user invokes one explicit, cost-bounded command for a
completed, persisted root session:

```bash
keel memory candidates extract <session-id> --max-cost <usd>
keel memory candidates list
keel memory candidates show <candidate-id>
keel memory candidates edit <candidate-id> "<replacement>"
keel memory candidates approve <candidate-id>
keel memory candidates reject <candidate-id>
keel memory candidates purge <candidate-id>
keel memory candidates clear --yes
```

Extraction sends only a bounded set of eligible current-user messages, never
assistant or tool text, and rejects detected secrets and prohibited high-risk
personal data before a provider request. Detection is best-effort defense in
depth, not a general DLP guarantee. A successful run creates at most five
inactive project-scoped candidates and reports the created/pending counts,
provider usage, cost, attempts, and review command. The candidate list retains
terminal extraction operations, including failures and admission rejections,
so consumed provider cost remains observable even when no candidate is saved.

Every candidate keeps its exact user-message evidence, reason, producer origin,
duplicate/conflict matches, and sensitivity-check result. Completed-session
extraction candidates retain their dedicated model operation and cost fields;
same-turn proposals retain the primary provider/model plus the originating
session and message IDs without inventing a second extraction operation.
Pending candidates
expire after 30 days and are never loaded into an agent prompt. Only explicit
approval creates a normal active memory ID; conflicts require `--keep` or
`--supersede <memory-id>`, and exact duplicates cannot be approved. `--retry`
is required to extract a session again after a successful extraction. Keel has
no idle/background extractor, so ordinary session completion and app startup
make zero candidate-provider requests and schedule no candidate notification.
Before any candidate-provider request, extraction acquires the project-memory
write boundary and holds it through terminal accounting. If that boundary
remains busy, extraction fails without making a provider request or spending
provider budget.
Editing invalidates the model's earlier duplicate/conflict analysis. The review
view marks that analysis as stale, exact duplicates are recomputed and blocked
at approval, and activation requires an explicit `--keep` or `--supersede`
decision against current active memory.

Candidate reject and ordinary clear are logical removal. Candidate purge is
application-level physical removal from addressable Keel-owned local storage.
An approved candidate is linked to active memory, so its purge must name that
memory explicitly with `--purge-memory <memory-id>`; bulk purge similarly
requires `--purge-memories`. The linked payloads are then rewritten under the
same project lock and atomic event-log generation. These operations cannot
erase provider retention, exports, backups, filesystem snapshots, or storage
media remnants. Content-free extraction accounting (terminal state, provider,
attempts, usage, and cost) remains after candidate purge so provider spend does
not disappear with the user payload.
`--ephemeral` only disables the session ledger; it
does not disable project memory. Use `--no-memory` when a run must skip memory
identity discovery, storage reads, prompt injection, and memory observability.
One-shot, interactive, and headless Goal launch/resume runs all support it.
That flag prevents fresh use by the memory subsystem; it cannot remove the same
information after it has become ordinary user, assistant, or tool text in a
resumed conversation transcript. Keel does not retroactively rewrite session
history.

Git projects use a random identity marker under the Git common directory, so
subdirectories, repository renames, and linked worktrees share one scope.
Non-Git directories use their canonical path, so moving one creates a new
scope. Events live outside the repository under
`KEEL_HOME/memory/projects/<project-id>/events.jsonl` (default `~/.keel`) with
private directory and file permissions. Storage assumes one machine and a
reliable local filesystem; cloud-synced directories and concurrent multi-host
writes are unsupported.

Normal memory and candidate writes share one append-only event log in validated
physical file order, so approval and linked purge cannot tear across separate
stores.
Each entry is `current`, `stale`, `superseded`, `expired`, or `forgotten`.
`update` appends a replacement with an explicit `supersedes` relation; wall-clock
timestamps never choose a winner. `reviewAfter` makes an entry stale but still
visible as needing verification, while `expiresAt` makes it inactive. `verify`
records explicit user review. Repository state, tests, Git, configuration, live
APIs, project instructions, and the current user request always outrank memory;
Keel does not silently rewrite memory from observed tool evidence.

`forget` and ordinary `clear` append tombstones and remove entries from every
fresh active view, but do not erase historical payload bytes. `purge` is the
deliberate exception to append-only history: under the same project write lock,
it validates a replacement event generation and atomically replaces or deletes
the local store. A successful purge removes the selected payload and dangling
lifecycle references from addressable Keel-owned memory files. It cannot erase
provider retention, exported transcripts or reports, user copies, filesystem
snapshots or backups, or storage-media remnants. The writer fsyncs complete
newline-terminated events; malformed or unknown schema versions fail closed.

Keel injects the complete active view as quoted, low-authority reference data.
It is reloaded for every normal provider request attempt, never serialized as transcript
messages, session-ledger records, checkpoints, or compaction summaries, and
never directly feeds tool policy, approvals, shell arguments, or file paths. A
one-shot transcript header retains the most recent non-empty memory block that
was actually sent. A run report retains the union of IDs exposed during that
run and the maximum rendered cost, while `/status` shows the current active
view. Successful agent add/forget operations also expose their stable memory
ID, project scope, and outcome in tool results, transcripts, and run reports.
The rendered block is all-or-nothing: at most 4,096 UTF-8 bytes and 100 active
entries. Reports and `/status` also expose whether memory is enabled, its
project scope, lifecycle/provenance metadata, rendered bytes, and an approximate
token count. Reports intentionally omit remembered text and raw source evidence.

Known secret formats are rejected before persistence without echoing the input,
but detection is best-effort and is not a privacy guarantee. Do not store API
keys, passwords, private keys, personal addresses, or other sensitive data.

## Execution Lifecycle And Reports

Keel separates user work from the runtime segments and provider requests used
to complete it:

```text
Session
├─ Goal (optional, durable completion contract)
└─ Task (one user-admitted unit of work)
   └─ Agent Run (one continuous runAgentTurn execution)
      ├─ Agent-loop Model Turn
      ├─ Model Operation
      │  └─ Provider Request Attempt
      └─ Tool Invocation
```

- A **Session** owns the durable conversation, queued input, model selection,
  approvals, Skills, and optional Goal.
- A **Goal** may span multiple Tasks and explicit resumes. `paused`, `blocked`,
  `budget_limited`, and `usage_limited` are stopped but resumable states;
  `completed` is the successful non-resumable state with completion evidence.
- A **Task** begins when Keel admits a user prompt, Goal activation, or explicit
  Goal resume. Automatic Goal continuation stays in the current Task.
- An **Agent Run** is one continuous `runAgentTurn()` execution. Automatic Goal
  continuation creates another Agent Run under the same Task.
- An **Agent-loop Model Turn** is one completed main model → tools → model-loop
  iteration. Turn-limit wrap-up, compaction, and Goal assertion evaluation are
  separate model work and are not agent-loop turns.
- A **Model Operation** is one logical model job, such as an agent turn,
  compaction, evaluation, or wrap-up. A **Provider Request Attempt** is one
  physical upstream request for that operation. Reports expose purpose-labelled
  operations, their explicit owner, and ordered attempts with exact outcomes.
  A context-overflow attempt points to its recovery compaction operation;
  `providerRetries` remains a retry-decision view and is not the request-count
  source of truth.
- A **Tool Invocation** is one logical tool request. Its provider tool-call id
  correlates the pending request and result; it is not a session-global id.
- **Agent Run end** means `runAgentTurn()` returned. **Task terminal** means no
  same-Task retry, steering injection, or automatic Goal continuation remains.
  One Task therefore has one orchestration-owned outcome even when it contains
  several Agent Runs. A blocked or limited Goal Task reports `goal_blocked`,
  `goal_budget`, or `goal_usage_limit` instead of copying the final Agent Run's
  `completed` stop reason; an interrupted, rolled-back Run reports `aborted`.
- An invocation outcome is the result of the current CLI process. A blocked or
  limited invocation can leave a durable Goal resumable, so invocation outcome
  is not Goal completion.
- A Session is **idle** when no Agent Run is executing. It is **settled** only
  when no Run, retry, continuation, accepted input, queued Task, or runtime hook
  can produce more work.

`keel --report <file>` writes report schema 21. `tasks[].ordinal` and nested
`agentRuns[].ordinal` are report-local identities. Each Agent Run owns its
`humanInterventionCount`, `agentLoopTurns`, existing provider retry notices,
context-compaction records, and stop reason. A human intervention is one user
message actually injected as steering into an active Agent Run; a prompt that
starts a later Task and runtime-generated Goal or recovery messages do not
count. Task and root intervention totals derive from the Agent Run counts. A
single model-operation ledger derives root usage, cost, operation count,
physical-attempt count, `usageByModel`, and root `agentLoopTurns`; only
completed `agent_turn` operations count as Agent-loop turns. Goal `usage.turns`
has a different owner: it increments once per Goal Agent Run, including
automatic continuation. Failed physical provider attempts report a distinct
terminal `errorCode`; retry attempts retain the exact phase-specific reason,
including first-response and stream-inactivity timeouts.

Subagent provider operations have `purpose: "subagent_turn"` and attribution
with their delegation ID, child Run ID, profile, and effort. Their attempts,
usage, and cost roll into root totals. The report supports invocation-level
accounting; saved-session `/agents` history remains canonical for child
lineage, lifecycle, delivery, transcript, and workspace state.

If a terminal runtime/provider failure occurs after report instrumentation is
ready, Keel still exits non-zero but best-effort writes the same current schema.
The active Task and Agent Run end as `failed`, `stopReason` is `failed`, and a
top-level `failure` records a stable category plus a redacted message bounded to
2,000 characters. Saved interactive failures also record the session ID so the
durable `/agents` history remains the canonical place to inspect child
lifecycle. If writing this failure report also fails, Keel prints that secondary
diagnostic without replacing the original error.

Resuming a process does not silently continue an old Task. If a persisted Goal
was active when the process stopped, Keel restores it as paused and requires
`/goal resume` or `keel goal resume`; that explicit action starts a new Task and
Agent Run under the same durable Goal.

## Provider Options

Provider setup accepts optional model and base URL overrides:

```bash
printf '%s\n' "$DEEPSEEK_API_KEY" | keel setup deepseek --with-api-key --model deepseek-v4-flash
printf '%s\n' "$DASHSCOPE_API_KEY" | keel setup qwen --with-api-key --base-url https://dashscope.aliyuncs.com/compatible-mode/v1
```

Use `--offline` to store configuration without probing the provider:

```bash
printf '%s\n' "$DEEPSEEK_API_KEY" | keel setup deepseek --with-api-key --offline
```

For new runs, provider/model resolution order is per-run CLI flags, environment
variables, stored config, then built-in defaults; API keys use environment then
stored auth. Resumed sessions restore their active provider/model unless
per-run flags override it.
