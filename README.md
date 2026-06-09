# keel

[![CI](https://github.com/acmerfight/keel/actions/workflows/ci.yml/badge.svg)](https://github.com/acmerfight/keel/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/acmerfight/keel/branch/main/graph/badge.svg)](https://codecov.io/gh/acmerfight/keel)

AI coding agent. Built from scratch for maximum harness execution quality.

Development lives in `keel/`. See `keel/CLAUDE.md` for architecture, commands, and conventions.

## Reference Submodules

Included for study during development. Will be removed once keel is self-sufficient.

| Project | Language | Reference Value |
|---------|----------|-----------------|
| [Pi](https://github.com/earendil-works/pi) | TypeScript | Agent loop, edit algorithm, faux provider testing, compaction |
| [OpenCode](https://github.com/anomalyco/opencode) | TypeScript | Wire protocol, VCR testing, provider/protocol layering |
| [Codex CLI](https://github.com/openai/codex) | Rust | Sandbox execution, apply-patch edit strategy |
| [Claude Code](https://github.com/anthropics/claude-code) | Shell/TS | Tool naming, system prompt design |
| [Kimi Code](https://github.com/MoonshotAI/kimi-code) | TypeScript | Tool scheduler (resource-based concurrency), compaction strategy, sub-agent swarm |

## Setup

```bash
git clone --recurse-submodules git@github.com:acmerfight/keel.git
cd keel/keel
pnpm install
```
