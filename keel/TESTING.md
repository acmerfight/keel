# Testing

## Principles

1. **Only mock LLM.** `fake` provider is the sole seam. Everything else — filesystem, processes, git — is real. Isolation means tmpdir, not mock.
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

## Test Layers

Six runtime layers + three static checks. Each catches a distinct class of bug.

### Static (zero runtime cost)

- **tsc strict** — type errors (noUncheckedIndexedAccess, exactOptionalPropertyTypes)
- **Biome lint** — code style, suspicious patterns
- **knip** — dead exports and unused dependencies

### Runtime

```
tests/
  invariants/    — Module boundary assertions (~50 lines)
  property/      — fast-check random input tests for pure functions (edit, normalize, ...)
  e2e/           — Agent behaviors via Fake Provider, named by capability
  cassettes/     — VCR recorded responses per provider (Phase 1)
  adversarial/   — Hand-written hostile LLM scenarios that must terminate
  stability/     — Multi-round resource monitoring (Phase 1)
```

| # | Layer | What it catches | Example of real-world bug it prevents |
|---|-------|----------------|--------------------------------------|
| 1 | Invariant | Architecture violations | Pi agent-session.ts grew to 3,110 lines / god object |
| 2 | Property | Edge cases in pure functions | Cline 60-70% edit success rate (#4384) |
| 3 | Fake E2E | Agent behavior regressions | Functional correctness of tool call loop |
| 4 | VCR Cassettes | Wire format parse errors | Dropped tool calls, lost thinking blocks |
| 5 | Adversarial | Hangs, infinite loops, crashes | Codex indefinite hang (#14048), Goose mid-stop (#3739) |
| 6 | Soak | Resource leaks over many rounds | OpenCode 63GB memory (#22018), 318GB disk (#9290) |

### Layer details

**Invariant** — Tests that `agent/` does not import `fs`/`child_process`/`cli/`, etc. Enforces module boundaries via source code inspection. Already implemented.

**Property** — fast-check generates thousands of random inputs for pure functions (edit algorithm, Unicode normalization, output truncation). Asserts invariants like "either succeeds correctly or returns an actionable error." Not a substitute for E2E; catches boundaries that hand-written tests miss.

**Fake E2E** — Fake Provider emits pre-scripted `LLMEvent` sequences. Agent Loop + real tools execute in a real tmpdir. Tests are named by capability (file-editing, error-recovery, cost-control). This is the primary test layer.

**VCR Cassettes** (Phase 1) — Recorded real API responses replayed to provider adapters. One cassette directory per provider (`cassettes/anthropic/`, `cassettes/openai/`). Tests that adapter correctly transforms wire format into unified `LLMEvent`. Includes edge cassettes: chunk split mid-UTF-8, event spanning chunks, multiple events in one chunk.

**Adversarial** — Hand-written hostile scenarios injected via Fake Provider: abrupt stream end, malformed tool call JSON, 10,000 consecutive tool calls, empty stream, 10MB text event. Each scenario asserts the loop terminates with `end` or `error` within a timeout. This is NOT coverage-guided fuzzing (AFL/libFuzzer); it is a curated set of adversarial inputs. The name reflects this: "adversarial", not "fuzz."

**Soak** (Phase 1) — Runs 200+ rounds of tool calls via Fake Provider, measures heap via `--expose-gc` + forced GC + `v8.getHeapStatistics()` (not raw RSS, which is unreliable under V8's lazy GC). Asserts heap delta stays below threshold. 50 rounds is insufficient for slow leaks; 200+ with forced GC is the minimum credible bar.

### Known gaps (future phases)

- **Real LLM eval** — SWE-bench, CORE-Bench, or a custom task suite against live APIs. Required to measure actual agent quality. No amount of Fake Provider testing substitutes for this.
- **Prompt regression** — Fixed task suite re-run after system prompt or tool description changes, against a real LLM, to detect silent behavior degradation. Fake Provider cannot catch this (responses are pre-scripted regardless of prompt).
- **Security** — Path traversal, command injection, sandbox escape. Not yet designed.

## Do NOT

- Mock anything except LLM
- Test private functions
- Put implementation language in test names
- Call hand-written adversarial scenarios "fuzz testing" — reserve that term for coverage-guided automated fuzzing
