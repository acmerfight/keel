# keel (monorepo root)

AI coding agent built from scratch for maximum harness execution quality. TypeScript 6, Node 24, pnpm.

All development happens in `keel/`. See [`keel/CLAUDE.md`](keel/CLAUDE.md) for architecture, style, and workflow.

## Submodules

Read-only reference agents for architectural study.

- `claude-code/` — Anthropic Claude Code CLI (leaked source, Mar 2026)
- `codex/` — OpenAI Codex CLI (local coding agent)
- `kimi-code/` — Moonshot AI Kimi Code CLI (terminal coding agent)
- `opencode/` — opencode.ai (Effect TS coding agent)
- `pi/` — Pi Agent Harness (pi.dev, self-extensible coding agent)

## Boundaries

- Do not create source files, install dependencies, or run commands at root level
- Do not commit changes to submodule contents
- If working directory is root, `cd keel` before development
