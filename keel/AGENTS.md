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
pnpm test:coverage  # vitest run --coverage
pnpm knip           # Dead code detection
```

## Architecture

```
src/
  cli/         → Entry point
  core/        → Config, error, logger, git, cost, rules
  agent/       → Agent loop, context, compaction
  llm/         → Provider abstraction (anthropic, openai, fake)
  tools/       → bash, edit, find, grep, read, write
  mcp/         → MCP client and registry
```

Layer rules (enforced by `tests/invariants/boundaries.test.ts`):
- `agent/` does not import `fs`, `child_process`, or `cli/`
- `llm/` does not import `cli/` or `agent/`

## Code Style

- Biome handles formatting and linting. Do not use ESLint or Prettier.
- No comments unless the WHY is non-obvious.
- All interface properties `readonly`.
- Pre-commit hook auto-formats staged files.

## Development

**BDD: test first, then implement.** Every feature starts with a failing test in GWTE format. Write the test, watch it fail, then write the minimum code to make it pass. Do not write implementation code without a corresponding test.

**Vertical slicing.** Every deliverable is end-to-end: a user can run it and get a result. See [SLICING.md](SLICING.md).

## Merge to Main

Never push directly to main. Always use a PR and wait for CI to pass. Workflow:

1. Create a feature branch
2. Push and open a PR
3. Wait for CI (typecheck → lint → test → knip) to pass
4. Squash merge to main (only merge strategy allowed)

PR summary format (English, diff against latest main before writing):

- **Problem:** what was wrong or missing
- **Solution:** what this PR changes
- **Why:** why this approach solves the problem
- **Effect:** what improves after merge

## Testing

See [TESTING.md](TESTING.md). Summary:

1. Only mock LLM (`fake` provider). Everything else is real.
2. BDD with GWTE format. Business language. Tests = product spec.
3. No vi.mock, no mocking internals, no testing private functions.
