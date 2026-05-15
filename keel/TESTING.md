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

## Structure

```
tests/
  e2e/           — Agent behaviors, named by capability (file-editing, error-recovery, ...)
  invariants/    — Architecture guards (module boundary assertions)
```

## Do NOT

- Mock anything except LLM
- Test private functions
- Put implementation language in test names
