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
pnpm coverage:patch # Local PR patch coverage pre-check against origin/main
pnpm eval:check     # Validate bundled eval task verifiers without provider calls
pnpm knip           # Dead code detection
```

## Architecture

```text
src/
  cli/         -> Entry point
  core/        -> error, logger, git, cost
  agent/       -> Agent loop, prompt
  llm/         -> Provider abstraction (DeepSeek, Kimi, Qwen, fake, OpenAI-compatible shared runtime)
  permissions/ -> Tool permission policies
  testing/     -> Test support code (CLI harnesses, fixture factories)
  tools/       -> bash, edit, glob, grep, ls, read, write
```

Layer rules are enforced by `tests/invariants/boundaries.test.ts`:

- `agent/` does not import `fs`, `child_process`, or `cli/`
- `llm/` does not import `cli/` or `agent/`
- `cli/` does not import `testing/`

## Core Principles

Build user-runnable vertical slices. After each PR, a user should be able to run a command or exercise an agent workflow and observe the improvement; avoid shipping only internal architecture unless it directly unlocks the slice.

Keel is pre-release. Implement only the latest product model. Do not add compatibility shims, migrations, fallback readers, old CLI aliases, legacy schema support, or compatibility tests for old internal data, draft schemas, or unfinished command shapes unless explicitly requested. Keep each slice runnable and preserve safety boundaries.

Prioritize foundational usability before expansion. Interactive/provider/model/context/edit/session/approval gaps come before standalone eval-corpus work, marketplaces, MCP, IDE integration, or sub-agents. Add eval tasks when they are tied to a real product fix or preserved failure.

Test observable behavior before implementation. Start with a failing GWTE test that proves the user-visible slice result, then add narrower provider, tool, or invariant tests for the boundary contracts that own the risk. Do not test implementation details.

Keep safety boundaries explicit. Preserve every representation that can carry authorization meaning, validate both requested and resolved paths before acting, and parse external data through schemas before business logic.

Be honest about shell and provider visibility. Bash approval is user consent, not sandboxing. Live provider requests may include raw user text and tool output; transcript/session redaction is only best-effort at-rest hygiene.

Use types as contracts. Required runtime data should be required in the type, absence should be semantic, and guards should not defend against states trusted internal types already exclude.

Prefer concrete code. Keep control flow local and linear; add abstraction only for current proven duplication or a real boundary.

## Topic Docs

- [DEVELOPMENT.md](DEVELOPMENT.md) - code style, type precision, safety boundaries, shell/provider visibility semantics, and abstraction discipline.
- [TESTING.md](TESTING.md) - BDD style, test boundaries, coverage triage, and verification expectations.
- [SLICING.md](SLICING.md) - vertical slicing rules and how to choose a runnable slice boundary.
- [ROADMAP.md](ROADMAP.md) - north-star goals and priority-ordered capability gaps.
- [EVALS.md](EVALS.md) - harness eval task format, execution, and result interpretation.

When a workflow skill is triggered, follow that skill's description and `SKILL.md` exactly. If it names required files, read each named file directly; do not treat this index as a replacement for skill-specific reading requirements.

## Hard Rules

- Biome handles formatting and linting. Do not use ESLint or Prettier.
- All interface properties are `readonly`; use function property syntax for interface functions.
- No `as` type assertions. Use type guards, `satisfies`, or schema validation. `as const` is allowed.
- Parse external data through explicit Zod schemas before business logic.
- Preserve security-relevant path representations until policy checks are complete.
- Bash is trusted shell mode, not a sandbox. Approved or trusted shell output can be sent to the provider unredacted.
- Transcript/session redaction is best-effort at-rest hygiene. Live provider requests are not a secret boundary.
- Keep implementations concrete. Add abstraction only for current proven duplication or a real boundary.

## Development

BDD first. Every feature starts with a failing GWTE test for observable behavior unless the change is pure mechanical docs/refactor and cannot change behavior.

Every deliverable is a vertical slice: after the PR, a user can run a command or exercise an agent workflow and observe the result. See [SLICING.md](SLICING.md).

Pick the highest-priority roadmap gap that can ship as a bounded vertical slice. Re-check the current product entrypoint before choosing work.

## Merge To Main

Never push directly to `main`.

1. Create a feature branch.
2. Push and open a PR.
3. Wait for CI: typecheck, build, lint, test coverage, knip.
4. Squash merge to `main`; it is the only allowed merge strategy.

PR summary format, written in English against latest `main`:

- **Problem:** what was wrong or missing
- **Solution:** what this PR changes
- **Why:** why this approach solves the problem
- **Effect:** what improves after merge

## Testing

See [TESTING.md](TESTING.md). Short version:

1. Only mock the LLM through the `fake` provider; everything else is real.
2. BDD with GWTE titles.
3. Test observable behavior, not implementation details.
4. PR-ready verification uses `pnpm test:coverage`, then `pnpm coverage:patch` when coverable code changed.
5. The slice acceptance test proves the user-visible result. Add narrower tests at the risk boundary: agent for loop outcomes, provider for protocol, tools for tool contracts, invariants for architecture.
