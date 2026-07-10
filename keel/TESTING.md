# Testing

## Principles

1. **Only mock the LLM.** In agent-facing tests, the `fake` provider is the agent seam. Everything else — filesystem, processes, git — is real. Provider contract tests may use a local protocol server instead of the real upstream API. Isolation means tmpdir, not mock.
2. **BDD.** Tests are written in GWTE (Given-When-Then-Expect) language for the audience that owns that boundary. `agent/` and `cli/` titles should read as product behavior. `tools/`, `providers/`, and `invariants/` titles should read as tool, protocol, or architecture contracts.
3. **Slice acceptance is user-visible.** A behavior slice needs at least one BDD test that proves the user-runnable command or agent workflow and its observable result.
4. **Test observable behavior, not implementation.** Assert the result visible at the boundary that owns the risk: CLI output and exit status, file or state changes, emitted events, requests sent to a local server, error codes/messages, or tool results. Do not assert private control flow, helper calls, random samples, sleep decisions, loop shape, or other implementation details.
5. **Tests = executable specification.** If a behavior isn't in the test suite, it doesn't exist. If a test passes, the feature works.

## Test Titles

Every title is documentation: write `Given/When/Then` with observable setup, trigger, and result.

Use the directory audience: `agent/` and `cli/` titles describe product behavior; `tools/`, `providers/`, and `invariants/` titles describe contracts. Keep fixture/protocol words out of `agent/` and `cli/` titles; put them in the test body.

## Shape

```typescript
test("Given a buggy file, When user asks to fix it, Then the file is corrected", () => {
  // Given
  const workspace = createWorkspace({ "main.ts": "const name = user.profile.name;" });
  const fake = scriptFake([
    toolCall("edit", { path: "main.ts", oldString: "user.profile.name", newString: "user.profile?.name" }),
    text("Fixed."),
  ]);
  // When
  runAgent({ workspace, provider: fake, prompt: "fix the TypeError" });
  // Expect
  expect(readFileSync(join(workspace, "main.ts"), "utf8")).toContain("user.profile?.name");
});
```

PM sees:

```
File Editing
  ✓ Given a buggy file, When user asks to fix it, Then the file is corrected
  ✓ Given a multi-file project, When user renames a variable, Then all references are updated
Error Recovery
  ✓ Given a read-only file, When agent tries to edit it, Then agent reports the failure
Cost Control
  ✓ Given a session cost limit, When cost exceeds the limit, Then agent stops
```

## Structure

```
tests/
  agent/       — runAgent behaviors with fake LLM and real tools/filesystem
  cli/         — CLI subprocess behavior and user-visible process results
  providers/   — Provider protocol contracts with local HTTP/SSE servers
  tools/       — Direct tool boundaries, safety checks, and resource limits
  invariants/  — Architecture guards (module boundary assertions)
```

## Test Infrastructure

Test support code, such as CLI harnesses and fixture factories, lives in `src/testing/`.
This directory is excluded from coverage reports.

## Verification

Use `pnpm test:coverage` for final verification before pushing or merging. For fast local iteration, use an explicit Vitest path, `pnpm test:changed`, `pnpm test:unit`, or `pnpm test:cli`; `pnpm test` remains available when the full non-coverage suite is useful. PR-ready verification must still run the coverage command so regressions in covered branches are visible.

CI produces equivalent full-suite coverage by running shards and merging their reports before Codecov upload. The coverage shard and merge scripts are CI plumbing, not substitutes for the local final-verification command.

Run `pnpm coverage:patch` after `pnpm test:coverage` before pushing PR branches that change coverable code. It compares `origin/main...HEAD` against `coverage/lcov.info`, fails on changed measured lines with zero hits, and fails on changed measured branch lines with untaken `BRDA` records. This is a local preflight check; Codecov remains the authoritative merge gate.

## Coverage Triage

Coverage gaps require triage, not automatic tests.

Tests must verify reachable product behavior through real CLI, API, config, or external entrypoints. Do not manufacture impossible internal states just to satisfy coverage.

State-bearing slices must prove the state lifecycle, not just the handler. Any user-visible or agent-control state introduced by a slice must be tested through the first real product boundary that can set and observe it. If the state is durable, acceptance must prove it survives the persistence and resume, fork, or snapshot paths supported by that feature.

If a branch is reachable through a supported boundary, cover its observable behavior with BDD.
If it is unreachable under current invariants, remove or refactor it.
If it is a necessary guard, document the invariant it protects.

When a coverage gap exposes duplicated state, prefer one source of truth plus derived state over tests for inconsistent combinations.

For safety boundaries, prefer one authoritative execution path. Parallel allow/deny paths drift over time and can leave dead code that only looks protective.

## Acceptance vs Contract Tests

Test code falls into one role: slice acceptance, boundary contract, or test support. Do not let one role pretend to be another.

- Slice acceptance proves the product promise through the first supported product boundary that can show it, then asserts the observable result: CLI output, interactive behavior, agent workflow result, persisted state, file change, process result, or external entrypoint result.
- Boundary contract tests prove narrower behavior only when that boundary owns the risk: provider protocol, tool safety, persistence/schema invariant, state-machine invariant, or architecture rule.
- A test below the first observable boundary is not acceptance if the user-visible path could break while the test still passes.
- If a higher-boundary test already proves the same observable promise, do not keep a lower-boundary duplicate only for coverage, speed, or convenience.
- Coverage is not a reason to keep duplicate lower-boundary tests. After deleting one, apply coverage triage: reachable behavior is covered through the supported boundary, unreachable code is removed or refactored, and necessary guards keep named contract or invariant tests.
- If a lower-boundary contract test remains, its title and assertions must name the contract it owns, not a user behavior it does not exercise.

Before adding or keeping a test, answer:

1. What product promise or boundary contract does this test specify?
2. What is the first supported boundary where that promise is observable?
3. Would breaking the real user path fail this test?
4. Are the assertions on boundary output/state, or on internal return values/control flow?
5. If this contract supports a user-visible promise, where is the acceptance test?

## Choosing A Test Boundary

Prefer the highest product boundary that still gives a clear, stable failure:

1. **New user-visible agent behavior starts in `tests/agent/`.** These tests are the product spec for how Keel reasons across LLM turns, tool calls, tool results, recovery, and final output.
2. **CLI-visible behavior gets a `tests/cli/` smoke test.** Use CLI tests for env handling, process exit, stdout/stderr, signals, and the main user entrypoint.
3. **Provider protocol details stay in `tests/providers/`.** Use provider tests for HTTP/SSE parsing, upstream error classification, usage accounting, abort behavior, and tool-call protocol contracts.
4. **Tool safety and resource boundaries stay in `tests/tools/`.** Use tool tests for path safety, binary rejection, exact edit semantics, output caps, and memory-sensitive file behavior.
5. **Architecture rules stay in `tests/invariants/`.** Use invariants when the behavior is a module boundary, not a user workflow.

Any tool behavior that changes agent control flow also needs at least one `tests/agent/` case. Tool tests prove the tool boundary; agent tests prove the loop reacts correctly. This applies to recoverable tool failures, retry paths, stop conditions, tool-call limits, and any tool result that should change the next LLM turn.

When testing real failure paths, include uncooperative callees if the caller owns user-visible recovery, retry, timeout, cleanup, or exit behavior. Inject failures through test boundaries such as the fake provider, a local server, or the test runtime, not production-only hooks. Env switches are acceptable only for documented runtime behavior.

This means new user-facing behavior should usually add agent coverage, CLI-visible behavior should add a CLI smoke test, and control-flow-sensitive tool behavior should add agent coverage. It does not mean provider or tool boundary tests should be promoted into agent or CLI tests when the risk lives at that narrower boundary.

Do not confuse implementation risk with slice acceptance. Provider, tool, and invariant tests prove narrow contracts; they cannot replace the user-visible BDD case when the PR promise is observable through CLI or agent behavior.

For safety boundaries, derive tests from invariants instead of implementation shape. Include cases where the requested input and resolved target differ, and assert the policy holds for every security-relevant representation.

## Avoiding Combinatorial Explosion

BDD describes product behavior, but agent tests must not enumerate every possible tool sequence. As Keel gains more tools, providers, state, and retry paths, exhaustive end-to-end combinations become unmaintainable.

Cover behavior at the boundary that owns the risk:

1. **Tool tests cover tool contracts.** Each tool owns path safety, input validation, resource limits, output shape, and error codes.
2. **Provider tests cover protocol contracts.** Each provider owns stream parsing, tool-call decoding, usage accounting, abort behavior, and upstream error classification.
3. **Agent tests cover control-flow classes.** Add agent coverage when behavior changes the loop: recoverable errors, retry decisions, stop conditions, tool-call limits, budget stops, or final response behavior.
4. **Stateful systems need invariant tests.** Persisted sessions, cost budgets, and concurrency should be tested with invariants or focused state-machine cases before broad CLI/E2E coverage.
5. **CLI tests are smoke tests.** Use them for the user entrypoint, environment handling, process exit, stdout/stderr, and signals, not for duplicating every tool/provider case.

Do not add an agent test for every tool if the loop behavior is already covered by an equivalent control-flow class. When adding a new tool, add exhaustive `tests/tools/` coverage first; add `tests/agent/` coverage only if the tool introduces a new agent decision path or a new recoverable/terminal result class.

Provider history replay must preserve all model-visible context across turns. Do not drop assistant text, tool-call metadata, tool results, or their linkage during protocol serialization, because the harness depends on the prior plan, rationale, constraints, and tool/result continuity to keep multi-turn tasks on track.

## Do NOT

- Mock anything except LLM
- Test implementation details
- Test private functions
- Put fixture or protocol language in `agent/` and `cli/` test names

## Permitted Exceptions

- `vi.spyOn(process.stderr, "write")` for capturing process output assertions when the test boundary is an in-process function that writes to stderr/stdout directly. Prefer subprocess when the CLI entrypoint supports it.
- `vi.doMock("node:fs")` in dedicated `*-race.test.ts` files for deterministic TOCTOU race simulation between synchronous filesystem calls. Must restore with `vi.doUnmock` + `vi.resetModules` in `afterEach`. Not permitted for failures reproducible through real filesystem manipulation (chmod, full disk, concurrent writes).
- `vi.doMock("node:child_process")` in dedicated `*-race.test.ts` files for deterministic child-process lifecycle races that cannot be reproduced without mutating installed binaries or exhausting the host. Must restore with `vi.doUnmock` + `vi.resetModules` in `afterEach`. Not permitted when a real subprocess, local protocol server, or normal filesystem manipulation can exercise the same behavior.
