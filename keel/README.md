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

`keel --report <file>` writes report schema 11. `tasks[].ordinal` and nested
`agentRuns[].ordinal` are report-local identities. Each Agent Run owns its
`agentLoopTurns`, existing provider retry notices, context-compaction records,
and stop reason. A single model-operation ledger derives root usage, cost,
operation count, physical-attempt count, `usageByModel`, and root
`agentLoopTurns`; only completed `agent_turn` operations count as Agent-loop
turns. Goal `usage.turns` has a different owner: it increments once per Goal
Agent Run, including automatic continuation.

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
