---
name: merge-pr
description: 'Merge a reviewed Keel GitHub PR and clean up afterward. Use for `/merge-pr #123`, `/merge-pr`, `merge PR`, `merge`, `收尾干净`, or `merge and clean up` when the user explicitly asks to merge an open PR. Verify PR status and checks first, use the repository-allowed merge strategy, delete/prune merged branches, sync main, optionally update linked issues, and finish with a clean status report.'
argument-hint: "#<pr>"
user-invocable: true
---

# Merge PR

Use this workflow only when the user explicitly asks to merge a GitHub PR or finish cleanup after a PR merge.

## Fast Invocation

- `/merge-pr #123`
- `/merge-pr`
- `merge PR`
- `merge`
- `收尾干净`

If the target PR is omitted, infer it only when the current branch or current conversation has exactly one unambiguous open PR. Otherwise ask for the PR number.

## Preconditions

Before merging:

1. Confirm the exact PR number, base branch, head branch, and head SHA with `gh pr view`.
2. Confirm the working tree is clean. If it is dirty, stop and report the changed files instead of merging over local work.
3. Confirm the PR is open, not draft, and its latest remote head matches the intended local branch when a local branch is involved.
4. Confirm required GitHub checks, CI, and Codecov are passing. Do not merge with pending, failed, missing, or stale checks unless the user explicitly overrides after seeing the risk.
5. Confirm the repository merge policy with `gh repo view`. For Keel, use squash merge because it is the only allowed strategy in `keel/CLAUDE.md`.
6. Do not perform code review inside this skill. If the PR lacks review confidence, run `/code-review <target>` first or ask the user whether to proceed.

## Merge

Use non-interactive commands.

1. Prefer `gh pr merge <number> --squash --delete-branch` when squash merge and branch deletion are allowed.
2. If branch deletion is not supported by the repository command, merge first, then delete only the PR branch that GitHub reports as merged.
3. If the merge command fails, do not retry blindly. Read the failure, report the blocker, and leave local state unchanged where possible.

## Cleanup

After a successful merge:

1. Fetch and prune remotes with `git fetch --prune origin`.
2. Switch to the PR base branch, usually `main`.
3. Fast-forward the base branch from origin with `git pull --ff-only origin <base>`.
4. Delete the local PR branch only if it still exists locally and is fully merged. Use `git branch -d`, never force-delete unless the user explicitly asks.
5. Confirm the remote tracking branch for the PR head is gone or explain if it remains.
6. Confirm `git status --branch --short` is clean and on the base branch.
7. If a linked issue is unambiguous, update it with the merge result and any remaining follow-up. Close it only when the PR or user explicitly says the issue is complete.

## Output

Return a concise structured report:

1. Merged PR
2. Merge commit
3. Branch cleanup
4. Issue update, or `None`
5. Final local status
6. Any remaining risks or manual follow-up
