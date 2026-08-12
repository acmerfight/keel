# Subagents

Keel's subagent product is a governed agent tree, not a peer-to-peer swarm.
Main is the only user-facing answerer. It can delegate independent work to
fresh-context children while the Runtime owns authority, identity, shared
resources, terminal truth, persistence, and delivery.

## Product surface

- `--agent-policy off` is the default.
- `--agent-policy explicit --max-cost <usd>` permits delegation after the
  current user asks for a subagent.
- `--agent-policy auto --max-cost <usd>` is a separate opt-in that lets Main
  select eligible independent read-only work. It is not default-on.
- Independent foreground read-only children can overlap. Saved interactive
  sessions also own attached background read-only children with `/agents`
  list, wait, input, cancel, and resume controls.
- Built-in and narrowing-only project profiles govern model, effort, tools,
  Skills, MCP, turns, deadline, and result size.
- One explicit foreground writer can work in an isolated branch/worktree and
  return an inspectable patch; Keel does not merge it automatically.
- Under explicit policy, a foreground read-only child can delegate one focused
  foreground read-only grandchild. Depth two is a leaf.

The current nesting boundary deliberately excludes background, writer, Bash,
and `auto` nesting. Attached background remains owned by the live saved-session
process; there are no detached workers. Writer workspaces do not share the
user's writable checkout.

## Responsibility split

The model decides whether and how to split eligible work, which profile to use,
whether sibling work is independent, how much child evidence to recheck, and
how to synthesize the answer. Runtime rules are limited to risks that would
otherwise break authority, resource, lifecycle, persistence, delivery, or
workspace correctness. Tool traces are execution facts, not semantic proof,
and Keel does not add per-tool evidence adapters or case-specific routers.

## Core invariant audit

Slice 6.2 audited the current product against the seven completion invariants.
Each row names the production owner and the focused behavior tests that own the
risk. The audit found no uncovered core boundary requiring a new runtime rule
or coverage-only test.

| Invariant | Production owner | Core BDD evidence |
| --- | --- | --- |
| Authority | `subagent-capability.ts`, `subagent-profile.ts`, Supervisor admission, and CLI capability derivation | Static policy/batch/accounting contracts in [`subagent-type-contracts.test.ts`](../tests/invariants/subagent-type-contracts.test.ts); unknown profile, unleased Skill/MCP, writer, and continuation narrowing cases in [`subagent-supervisor.test.ts`](../tests/agent/subagent-supervisor.test.ts); real nested catalog derivation in [`subagent-delegation.test.ts`](../tests/cli/main/subagent-delegation.test.ts) |
| Identity and idempotency | Supervisor delegation receipts plus the agent-tree store's AgentThread/AgentRun model | Fresh/replay delivery and duplicate admission cases in [`subagent-supervisor.test.ts`](../tests/agent/subagent-supervisor.test.ts); identity, ordering, lineage, and terminal immutability replay in [`agent-tree-store.test.ts`](../tests/cli/agent-tree-store.test.ts); durable parent/child Run linkage in [`subagent-history.test.ts`](../tests/cli/main/subagent-history.test.ts) |
| Budget and admission | `subagent-tree-admission.ts`, `subagent-tree-budget.ts`, and `subagent-tree-provider.ts` | Aggregate continuation/result reservation in [`subagent-tree-budget.test.ts`](../tests/agent/subagent-tree-budget.test.ts); active/total admission, reserve/settle, replay, and root continuation cases in [`subagent-supervisor.test.ts`](../tests/agent/subagent-supervisor.test.ts); provider-slot, retry, and circuit sharing in [`subagent-tree-provider.test.ts`](../tests/agent/subagent-tree-provider.test.ts) |
| Lifecycle | Supervisor structured concurrency and saved-session owner runtime | Parent cancellation, sibling isolation, provider abort certification, timeout, and settlement races in [`subagent-supervisor.test.ts`](../tests/agent/subagent-supervisor.test.ts); owner shutdown and live control in [`interactive-subagent-session.test.ts`](../tests/cli/interactive-subagent-session.test.ts); real CLI cancellation in [`subagent-delegation.test.ts`](../tests/cli/main/subagent-delegation.test.ts) |
| Persistence | `agent-tree-store.ts` and its bounded JSONL/transcript boundary | Replay, interrupted recovery, lineage, redaction, and invalid transition cases in [`agent-tree-store.test.ts`](../tests/cli/agent-tree-store.test.ts); partial append, durable publication, rollback, and transcript setup failpoints in [`agent-tree-store-failures.test.ts`](../tests/cli/agent-tree-store-failures.test.ts) |
| Delivery | Canonical AgentResult plus pending/delivered reconciliation in the agent-tree store | Terminal-to-pending and parent-message-to-delivered crash windows in [`agent-tree-store-failures.test.ts`](../tests/cli/agent-tree-store-failures.test.ts); real process recovery and exactly-once parent notification in [`subagent-background.test.ts`](../tests/cli/main/subagent-background.test.ts) |
| Workspace | `subagent-workspace.ts` domain lease and CLI Git/worktree adapter | Root containment, frozen repository identity, single-owner acquisition, Git config side effects, bounded patch, continuation reacquisition, and parent-checkout preservation in [`subagent-workspace.test.ts`](../tests/cli/subagent-workspace.test.ts); end-to-end writer isolation in [`subagent-delegation.test.ts`](../tests/cli/main/subagent-delegation.test.ts) |

Inside the process, enabled policy, prepared delegation, lifecycle state,
delivery outcome, capability lease, and workspace ownership use discriminated
TypeScript types so illegal combinations are not optional runtime shapes.
Runtime parsing remains at real trust boundaries: model/tool arguments,
provider responses, CLI/config input, persisted JSONL/transcripts, filesystem
and Git state, MCP/network identity, and machine-readable reports.

## Reports and durable inspection

`keel --report <file>` schema 22 is an invocation-level accounting report.
Subagent provider operations use `purpose: "subagent_turn"` and carry
`attribution` with the delegation ID, child Run ID, profile, and effort. Their
usage, attempts, and cost roll into root totals, which lets evals count distinct
child Runs without treating multiple turns by one child as multiple children.
One-shot reports also expose an invocation-owned `subagents` lifecycle snapshot.
Graduation evals count only terminal `completed` Runs; a failed, limited,
cancelled, interrupted, queued, or running child cannot satisfy a positive
selection gate merely because it attempted a provider operation.

The report is not the durable lifecycle database and does not claim that a
child conclusion is correct. Saved interactive reports mark this snapshot
`unavailable`; `/agents` and the independent agent-tree/transcript ledgers
remain canonical for Run lineage, status, terminal result, delivery, workspace
artifacts, and recovery.

## Evaluation and limitations

The frozen Slice 6.2 product-graduation protocol and result are under
[`evals/experiments/subagent-slice-6-2/`](../evals/experiments/subagent-slice-6-2/).
It compares `off` controls with explicit and auto treatments under the same
task prompt, model, root budget, and pristine workspace. Task success,
interventions, selection, turns, tokens, wall time, cost, repeated Main work,
and failures are reported separately.

The first frozen window kept correctness at 18/18 arms, but did not graduate
the broader product: explicit treatments delegated in 3/3 yet selected multiple
children in only 2/3 and improved none of the frozen value medians; auto
selected no child in the parallel task. The full failed window is retained
rather than repaired sample by sample.

Subagents are not assumed to be cheaper or faster for every task. The supported
explicit path is useful when the user chooses independent investigation or
review; `auto` remains opt-in and default-off. Broader nesting or write modes
require a separate user need and gate rather than following automatically from
runtime reliability.
