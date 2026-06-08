# Testing

## Principles

1. **Only mock LLM in agent-facing tests.** `fake` provider is the agent seam. Everything else — filesystem, processes, git — is real. Provider contract tests may use a local protocol server instead of the real upstream API. Isolation means tmpdir, not mock.
2. **BDD.** Tests are written in GWTE (Given-When-Then-Expect) language for the audience that owns that boundary. `agent/` and `cli/` titles should read as product behavior. `tools/`, `providers/`, and `invariants/` titles should read as tool, protocol, or architecture contracts.
3. **Tests = executable specification.** If a behavior isn't in the test suite, it doesn't exist. If a test passes, the feature works.

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

Test support code, such as fake providers and fixture factories, lives in `src/testing/`.
This directory is excluded from coverage reports.

## Verification

Use `pnpm test:coverage` for final verification before pushing or merging. `pnpm test` is acceptable for fast local iteration, but PR-ready verification must run the coverage command so regressions in covered branches are visible.

## Choosing A Test Boundary

Prefer the highest product boundary that still gives a clear, stable failure:

1. **New user-visible agent behavior starts in `tests/agent/`.** These tests are the product spec for how Keel reasons across LLM turns, tool calls, tool results, recovery, and final output.
2. **CLI-visible behavior gets a `tests/cli/` smoke test.** Use CLI tests for env handling, process exit, stdout/stderr, signals, and the main user entrypoint.
3. **Provider protocol details stay in `tests/providers/`.** Use provider tests for HTTP/SSE parsing, upstream error classification, usage accounting, abort behavior, and tool-call protocol contracts.
4. **Tool safety and resource boundaries stay in `tests/tools/`.** Use tool tests for path safety, binary rejection, exact edit semantics, output caps, and memory-sensitive file behavior.
5. **Architecture rules stay in `tests/invariants/`.** Use invariants when the behavior is a module boundary, not a user workflow.

Any tool behavior that changes agent control flow also needs at least one `tests/agent/` case. Tool tests prove the tool boundary; agent tests prove the loop reacts correctly. This applies to recoverable tool failures, retry paths, stop conditions, tool-call limits, and any tool result that should change the next LLM turn.

This means new user-facing behavior should usually add agent coverage, CLI-visible behavior should add a CLI smoke test, and control-flow-sensitive tool behavior should add agent coverage. It does not mean provider or tool boundary tests should be promoted into agent or CLI tests when the risk lives at that narrower boundary.

For safety boundaries, derive tests from invariants instead of implementation shape. Include cases where the requested input and resolved target differ, and assert the policy holds for every security-relevant representation.

## Avoiding Combinatorial Explosion

BDD describes product behavior, but agent tests must not enumerate every possible tool sequence. As Keel gains more tools, providers, state, and retry paths, exhaustive end-to-end combinations become unmaintainable.

Cover behavior at the boundary that owns the risk:

1. **Tool tests cover tool contracts.** Each tool owns path safety, input validation, resource limits, output shape, and error codes.
2. **Provider tests cover protocol contracts.** Each provider owns stream parsing, tool-call decoding, usage accounting, abort behavior, and upstream error classification.
3. **Agent tests cover control-flow classes.** Add agent coverage when behavior changes the loop: recoverable errors, retry decisions, stop conditions, tool-call limits, budget stops, compaction handoff, or final response behavior.
4. **Stateful systems need invariant tests.** Compaction, persisted sessions, cost budgets, and concurrency should be tested with invariants or focused state-machine cases before broad CLI/E2E coverage.
5. **CLI tests are smoke tests.** Use them for the user entrypoint, environment handling, process exit, stdout/stderr, and signals, not for duplicating every tool/provider case.

Do not add an agent test for every tool if the loop behavior is already covered by an equivalent control-flow class. When adding a new tool, add exhaustive `tests/tools/` coverage first; add `tests/agent/` coverage only if the tool introduces a new agent decision path or a new recoverable/terminal result class.

## Do NOT

- Mock anything except LLM
- Test private functions
- Put fixture or protocol language in `agent/` and `cli/` test names
