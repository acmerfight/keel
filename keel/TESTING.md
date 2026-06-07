# Testing

## Principles

1. **Only mock LLM in agent-facing tests.** `fake` provider is the agent seam. Everything else — filesystem, processes, git — is real. Provider contract tests may use a local protocol server instead of the real upstream API. Isolation means tmpdir, not mock.
2. **BDD.** Tests are written in business language using GWTE (Given-When-Then-Expect). PM can read `vitest --reporter=verbose` output as product spec — no code knowledge required.
3. **Tests = product documentation.** If a behavior isn't in the test suite, it doesn't exist. If a test passes, the feature works.

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

## Do NOT

- Mock anything except LLM
- Test private functions
- Put implementation language in test names
