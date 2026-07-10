# Testing

## Principles

1. **Only mock the LLM by default.** In agent-facing tests, the `fake` provider is the agent seam. Everything else — filesystem, processes, git — is real unless listed under Permitted Exceptions. Provider contract tests may use a local protocol server instead of the real upstream API. Isolation means tmpdir, not mock.
2. **BDD.** Tests use GWTE (Given-When-Then-Expect) language for the audience that owns the boundary. `agent/` and `cli/` titles describe product behavior; `tools/`, `providers/`, and `invariants/` titles describe contracts.
3. **Slice acceptance is user-visible.** A behavior slice needs at least one BDD test that proves the user-runnable command or agent workflow and its observable result.
4. **Test behavior, not implementation.** Assert boundary output or state: CLI output and exit status, file or state changes, emitted events, local-server requests, error codes/messages, or tool results. Do not assert private control flow, helper calls, random samples, sleep decisions, or loop shape.
5. **Tests are executable specifications.** Every supported product promise and boundary contract has an owning test.

## BDD Shape

Every title is documentation: write `Given/When/Then` with observable setup, trigger, and result. Keep fixture and protocol language out of `agent/` and `cli/` titles; put it in the test body.

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

## Ownership And Boundaries

Each product promise or boundary contract has one exhaustive owner. Choose the boundary that owns the risk and gives a clear, stable failure.

| Boundary | Owns |
| --- | --- |
| `tests/agent/` | User-visible agent behavior and loop decisions across LLM turns, tool results, recovery, stopping, and final output |
| `tests/cli/` | User entrypoint, environment handling, process exit, stdout/stderr, and signals; keep this coverage smoke-level |
| `tests/providers/` | Provider protocol contracts such as stream parsing, history serialization, usage, aborts, and upstream errors |
| `tests/tools/` | Tool contracts such as path safety, validation, resource limits, output shape, and error codes |
| `tests/invariants/` | Architecture relationships and module boundaries |

- Provider history contracts preserve the complete model-visible message graph across turns, including content, tool calls/results, and their linkage.
- Slice acceptance proves the product promise through the first supported product boundary that can show it. A lower-level test is not acceptance if the user-visible path could break while it still passes.
- Boundary contract tests prove narrower protocol, safety, persistence, state-machine, or architecture risks only where owned. Their titles and assertions must name that contract, not borrow a user behavior they do not exercise.
- A test at another boundary remains only for distinct wiring, recovery, or an owned contract. Agent tests cover control-flow classes, not every tool/provider sequence; add one only for a new agent decision or recoverable/terminal result class.
- Exercise caller-owned recovery, retry, timeout, cleanup, and exit behavior with uncooperative callees. Inject failures through the fake provider, a local server, the test runtime, or a permitted exception below, never a production-only hook.
- Derive safety tests from invariants, not implementation shape, and assert the policy for every security-relevant representation.

## Duplicate Tests

Tests are duplicates only when they exercise the same supported boundary, trigger, observable outcome, and failure signal. Similar titles or equal coverage do not establish equivalence.

Coverage, speed, and convenience are not reasons to keep a duplicate. After deletion, compare absolute covered branches, functions, and lines as a regression check, then triage any loss; coverage is not proof that two tests specify the same behavior.

Before adding or keeping a test, answer:

1. What product promise or boundary contract does it specify, and which boundary owns it?
2. Would breaking the supported user or contract path fail it?
3. Do its assertions observe boundary output/state rather than internal values or control flow?
4. Does it add a distinct trigger, outcome, failure signal, wiring path, or owned risk?

## Coverage Triage

Coverage gaps require triage, not automatic tests. Do not manufacture impossible internal states just to satisfy coverage.

- If a branch is reachable through a supported boundary, cover its observable behavior with BDD.
- If it is unreachable under current invariants, remove or refactor it.
- If it is a necessary guard, give it a named contract or invariant test.

State-bearing slices must prove the state lifecycle through the first supported boundary that can set and observe it. Durable state acceptance must include the persistence and resume, fork, or snapshot paths the feature supports.

When a gap exposes duplicated state, prefer one source of truth plus derived state over tests for inconsistent combinations.

## Infrastructure And Verification

Test support code, such as CLI harnesses and fixture factories, lives in `src/testing/` and is excluded from coverage.

Use an explicit Vitest path, `pnpm test:changed`, `pnpm test:unit`, or `pnpm test:cli` for iteration. Before pushing or merging, run `pnpm test:coverage`; CI's sharded equivalent is not a substitute for this local final check.

After coverage, run `pnpm coverage:patch` on branches that change coverable code. It checks changed measured lines and branches against `coverage/lcov.info`; Codecov remains the authoritative merge gate.

## Permitted Exceptions

- `vi.spyOn(process.stderr, "write")` may capture process output when the boundary is an in-process function that writes directly to stderr/stdout. Prefer a subprocess when the CLI entrypoint supports it.
- `vi.doMock("node:fs")` is permitted only in dedicated `*-race.test.ts` files for deterministic TOCTOU races between synchronous filesystem calls. Restore it with `vi.doUnmock` and `vi.resetModules` in `afterEach`. Use real filesystem manipulation when it can reproduce the failure.
- `vi.doMock("node:child_process")` is permitted only in dedicated `*-race.test.ts` files for deterministic lifecycle races that otherwise require mutating installed binaries or exhausting the host. Restore it with `vi.doUnmock` and `vi.resetModules` in `afterEach`. Use a real subprocess, local protocol server, or filesystem manipulation when it can reproduce the behavior.
