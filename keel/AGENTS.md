# keel

AI coding agent. TypeScript 6, Node 24, pnpm.

## Commands

```bash
pnpm dev            # Run with --watch
pnpm build          # tsc
pnpm typecheck      # tsc --noEmit
pnpm lint           # biome check --error-on-warnings
pnpm lint:fix       # biome check --write --error-on-warnings
pnpm test           # vitest run
pnpm test:watch     # vitest (watch mode)
pnpm test:coverage  # Final verification: vitest run --coverage
pnpm eval:check     # Validate bundled eval task verifiers without provider calls
pnpm knip           # Dead code detection
```

## Architecture

```
src/
  cli/         → Entry point
  core/        → error, logger, git, cost
  agent/       → Agent loop, prompt
  llm/         → Provider abstraction (DeepSeek, Kimi, OpenAI-compatible shared runtime)
  testing/     → Test support code (fake providers, fixture factories)
  tools/       → bash, edit, grep, read, write
```

Layer rules (enforced by `tests/invariants/boundaries.test.ts`):
- `agent/` does not import `fs`, `child_process`, or `cli/`
- `llm/` does not import `cli/` or `agent/`

## Code Style

- Biome handles formatting and linting. Do not use ESLint or Prettier.
- No comments unless the WHY is non-obvious.
- All interface properties `readonly`.
- Use function property syntax for interface methods (`readonly fn: (x: T) => R`), not method syntax (`fn(x: T): R`). Method syntax bypasses `strictFunctionTypes`.
- No `as` type assertions. Use type guards, `satisfies`, or schema validation (Zod) to prove types. `as const` is allowed.
- External data boundaries must parse `unknown` through an explicit schema before business logic. Use Zod for JSON from HTTP/SSE, LLM/tool arguments, child process stdout, config files, disk JSON, and environment-derived structured data. Do not use `Record<string, unknown>` property-access helpers for known external protocols; model the protocol shape with a schema and access typed data only after `safeParse` or `parse`.
- In review, any `JSON.parse`, process output parsing, HTTP response parsing, or LLM argument parsing must show the schema boundary in the same module.
- Pre-commit hook auto-formats staged files.

### Safety Boundary Discipline

When code normalizes, resolves, parses, or transforms untrusted input before enforcing a policy, preserve every representation that can carry authorization meaning.

Validate both the requested representation and the resolved representation before acting. A helper must not collapse policy-relevant context into one "clean" value before access checks.

### Shell Safety Semantics

Keel's project ignore policy is enforced by the built-in file tools: `read`, `edit`, and `grep`. `bash` is disabled by default. When enabled with `--allow-bash`, it is trusted shell mode: commands run with the current OS user's permissions and may read or modify gitignored files. Do not describe `--allow-bash` as preserving the file-tool ignore boundary unless a real permission or sandbox layer exists.

### Abstraction Discipline

Prefer concrete, linear code. Add abstraction only when it makes current code simpler, not future code imaginable.

- Start with the direct implementation for the slice in front of you.
- Abstract after the second real use case, proven duplication, or a clear external boundary.
- Keep control flow local and sequential when possible.
- Use indirection only when it names a real domain concept or protects a real boundary.
- Remove extension points that are not exercised by current behavior.

## Type Precision

Default to required. Only use `?` or `| undefined` when you can name the semantic reason.

Decision:

1. "Does this field always exist at runtime?" → required
2. "Is absence meaningful (not the same as a default value)?" → `?` (property can be omitted)
3. "Must be present, but value can be explicitly nothing?" → `| null`
4. Never use `| undefined` on data types — with `exactOptionalPropertyTypes`, use `?` for absence or redesign to avoid it

Common mistakes:

- ❌ `?` because "the caller might not pass it" — put defaults in a factory function
- ❌ `?` because "it might be zero/empty string" — zero and empty string are values, not absence
- ❌ `Partial<T>` as the data type — use it only at call boundaries (function params, spread overrides)
- ❌ Broad truthy/falsy checks for sentinel values — use `value === null`, `value !== undefined`, `value === ""`, or `value === 0` to name the exact state being checked

Pattern:

```typescript
// Data type: all required
interface Response {
  readonly text: string;
  readonly tokenize: boolean;
  readonly usage: Usage;
}

// Construction: factory with defaults
function response(text: string, tokenize = false, usage = DEFAULT_USAGE): Response {
  return { text, tokenize, usage };
}
```

When `?` IS correct:

- Config the user may omit (absence = use system default)
- External API fields that may be absent
- PATCH DTOs (only send changed fields)

Litmus test: if you would write `?? defaultValue` every time you read this field, it is required — the default belongs in a factory, not in the type.

## Development

**BDD: test first, then implement.** Every feature starts with a failing test in GWTE format. Write the test, watch it fail, then write the minimum code to make it pass. Do not write implementation code without a corresponding test.

**Vertical slicing.** Every deliverable is end-to-end: a user can run it and get a result. See [SLICING.md](SLICING.md).

Before choosing the next feature, inspect the current product entrypoint. Prefer the smallest user-runnable slice over the next internal architecture step. Examples in SLICING.md are illustrative, not a fixed roadmap.

**Choosing what to build next:** [ROADMAP.md](ROADMAP.md) defines the north-star goals (replace Codex CLI / Claude Code for daily coding; exceed Claude Code / Codex / Kimi Code in measured harness execution quality) and a priority-ordered gap list. Pick the highest-priority gap that can ship as a vertical slice.

## Merge to Main

Never push directly to main. Always use a PR and wait for CI to pass. Workflow:

1. Create a feature branch
2. Push and open a PR
3. Wait for CI (typecheck → build → lint → test:coverage → knip) to pass
4. Squash merge to main (only merge strategy allowed)

PR summary format (English, diff against latest main before writing):

- **Problem:** what was wrong or missing
- **Solution:** what this PR changes
- **Why:** why this approach solves the problem
- **Effect:** what improves after merge

## Testing

See [TESTING.md](TESTING.md). Summary:

1. Only mock LLM (`fake` provider). Everything else is real.
2. BDD with GWTE format. Tests are executable specs for the boundary they cover.
3. Final verification uses `pnpm test:coverage`, not `pnpm test`.
4. No vi.mock, no mocking internals, no testing private functions.
5. Tool behavior that changes agent control flow needs at least one `tests/agent/` case.
6. Agent tests cover control-flow classes, not every tool sequence. Keep tool/provider/state risks at their owning boundary.
7. `agent/` and `cli/` titles must read as product behavior; `tools/`, `providers/`, and `invariants/` titles should read as tool, protocol, or architecture contracts. Keep fixture/protocol words out of `agent/` and `cli/` test titles.
8. Coverage gaps require triage, not automatic tests: cover reachable behavior, remove unreachable branches, document necessary guards, and never mock impossible states just to satisfy coverage.
9. Feature flags and environment switches are acceptable only when they represent documented runtime behavior. Test-only pathological behavior must be injected through test boundaries, not hidden in production CLI/provider code.
