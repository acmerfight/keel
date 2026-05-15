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

## Testing

See [TESTING.md](TESTING.md). Summary:

1. Only mock LLM (`fake` provider). Everything else is real.
2. BDD with GWTE format. Business language. Tests = product spec.
3. No vi.mock, no mocking internals, no testing private functions.
