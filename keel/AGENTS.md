# keel

AI coding agent. TypeScript 6, Node 24, pnpm.

## Commands

```bash
pnpm dev            # Run with --watch
pnpm build          # tsc
pnpm typecheck      # Typecheck src, tests, scripts, and config
pnpm lint           # biome check --error-on-warnings
pnpm lint:fix       # biome check --write --error-on-warnings
pnpm test           # vitest run
pnpm test:unit      # Run the non-CLI test project
pnpm test:cli       # Run the CLI test project
pnpm test:changed   # Run tests related to changes from origin/main
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
  runtime/     -> Mode-neutral Agent invocation and prompt assembly
  llm/         -> Provider abstraction (DeepSeek, Kimi, Qwen, fake, OpenAI-compatible shared runtime)
  permissions/ -> Tool permission policies
  testing/     -> Test support code (CLI harnesses, fixture factories)
  tools/       -> read, ls, glob, grep, git_status, git_diff, edit, write, apply_patch, bash,
                  update_plan, update_goal, memory_*, skill, skill_*, mcp_search (19 total)
  mcp/         -> MCP client runtime, discovery, OAuth
  skills/      -> Skill discovery, audit, catalog, activation lifecycle
  eval/        -> Harness eval runner and result comparison
```

Layer rules are enforced by `tests/invariants/boundaries.test.ts`:

- `agent/` does not import `fs`, `child_process`, or `cli/`
- `llm/` does not import `cli/` or `agent/`
- `runtime/` does not import `cli/`
- `cli/` does not import `testing/`
- `eval/` does not import `agent/`, `llm/`, `cli/`, or `testing/`, so evals measure
  keel only through the spawned CLI

That file also owns facade, single-owner, and no-wildcard-re-export rules beyond
these four. Read it before moving a module or adding a re-export.

## Core Principles

Build user-runnable vertical slices. After each PR, a user should be able to run a command or exercise an agent workflow and observe the improvement; avoid shipping only internal architecture unless it directly unlocks the slice.

Keel is pre-release. Implement only the latest product model. Do not add compatibility shims, migrations, fallback readers, old CLI aliases, legacy schema support, or compatibility tests for old internal data, draft schemas, or unfinished command shapes unless explicitly requested. Keep each slice runnable and preserve safety boundaries.

Prioritize unresolved daily-use roadmap gaps before expansion work. Add eval tasks when they are tied to a product fix or preserved failure.

Behavior changes start with a failing GWTE test that proves the user-visible slice result, followed by narrower tests for boundary-owned risks. Pure documentation or mechanical refactors with no behavior change need no new test. Do not test implementation details.

Keep safety boundaries explicit. Preserve every representation that can carry authorization meaning, validate both requested and resolved paths before acting, and parse external data through schemas before business logic.

Be honest about shell and provider visibility. Bash approval is user consent, not sandboxing. Live provider requests may include raw user text and tool output; transcript/session redaction is only best-effort at-rest hygiene.

Use types as contracts. Required runtime data should be required in the type, absence should be semantic, and guards should not defend against states trusted internal types already exclude.

Prefer concrete code. Keep control flow local and linear; add abstraction only for current proven duplication or a real boundary.

## Topic Docs

- [CONTRIBUTING.md](CONTRIBUTING.md) - contribution rules, including the PR title protocol.
- [DEVELOPMENT.md](DEVELOPMENT.md) - code style, type precision, safety and trust boundaries, ownership, and abstraction discipline.
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

## Pull Requests

Before creating, editing, or recommending a PR title, follow the PR title
protocol in [CONTRIBUTING.md](CONTRIBUTING.md). Use one of these Conventional
Commit forms:

```text
<type>(<scope>): <summary>
<type>(<scope>)!: <summary>
```

Allowed types: feat, fix, perf, refactor, docs, test, build, ci, chore, revert.
Scopes are required. Use `!` only for breaking changes. Do not create or update
a PR with a non-conforming title.

## Merge To Main

Never push directly to `main`.

1. Create a feature branch.
2. Push and open a PR.
3. Wait for the required `check` status (static verification plus merged coverage) and Codecov.
4. Squash merge to `main`; it is the only allowed merge strategy.

PR summary format, written in English against latest `main`:

- **Problem:** what was wrong or missing
- **Solution:** what this PR changes
- **Why:** why this approach solves the problem
- **Effect:** what improves after merge
