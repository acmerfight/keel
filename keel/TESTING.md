# Testing

## Principles

1. **Only mock LLM.** `fake` provider is the sole seam. Everything else — filesystem, processes, git — is real. Isolation means tmpdir, not mock.
2. **BDD.** GWTE format (Given-When-Then-Expect). Business language. `vitest --reporter=verbose` output reads as product spec.
3. **If it's not tested, it doesn't exist.**

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

## Layers

```
tests/
  invariants/    — Module boundary assertions
  property/      — fast-check random inputs for pure functions
  e2e/           — Agent behaviors via Fake Provider + real tools in tmpdir
  cassettes/     — VCR recorded responses per provider (Phase 1)
  adversarial/   — Hand-written hostile LLM scenarios (not coverage-guided fuzz)
  stability/     — 200+ round soak, forced GC, heap delta assertion (Phase 1)
```

## Do NOT

- Mock anything except LLM
- Test private functions
- Put implementation language in test names
