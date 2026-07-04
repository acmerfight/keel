# Contributing

## PR Title Protocol

PR titles must follow one of these Conventional Commit forms:

```text
<type>(<scope>): <summary>
<type>(<scope>)!: <summary>
```

Allowed types:

```text
feat, fix, perf, refactor, docs, test, build, ci, chore, revert
```

Rules:

- Treat the PR title as the eventual squash commit title.
- Include a scope in every PR title.
- Use a concise behavior-oriented summary.
- Use a stable scope such as a package, module, product area, or subsystem.
- Use `!` only for breaking changes.
- Put issue links such as `Fixes #123` in the PR body, not in the title.
- Do not use `WIP:` in the title; create a draft PR instead.

Examples:

```text
feat(cli): add session replay command
fix(provider): preserve tool error metadata
refactor(runtime)!: replace event envelope format
docs(agent): document PR title protocol
```

## PR Title Enforcement

The `Validate PR title` GitHub Actions check enforces this protocol for pull
requests. Keep that check required in branch protection.

Repository squash-merge settings should default the squash commit title to the
PR title.
