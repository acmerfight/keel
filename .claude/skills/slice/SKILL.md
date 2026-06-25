---
name: slice
description: 'Execute the standard Keel PR-slice workflow. Use for short requests such as `/slice #123`, `/slice`, `slice`, `slice #123`, or `issue #123`; infer an omitted target only when the current conversation contains exactly one unambiguous active issue or slice. Implement one slice, use strict BDD-first development, perform empty-context review, run real DeepSeek QA when applicable, monitor CI/Codecov, and stop before merge for user review. Do not reroute to `/agent-research` after the slice starts unless the user explicitly pauses implementation for research.'
argument-hint: "#<issue-or-slice>"
user-invocable: true
---

# Slice

Use this workflow for one bounded, user-reviewable Keel PR slice. Keep the slice narrow and vertical.

## Workflow Position

Use this only after the implementation target is clear.

- Use `/next-slice` first when the next slice is unclear.
- Before starting `/slice`, use `/agent-research <question>` only when the target is unclear because a specific peer-agent or architecture question must be answered. After `/slice` starts, do not switch to `/agent-research` unless the user explicitly asks to pause implementation for research.
- Use `/slice <issue-or-slice>` to implement the selected slice and prepare a PR.
- Use `/code-review <target>` for read-only review and `/merge-pr <target>` only after the user explicitly asks to merge.

## Hard Boundary

Once this workflow starts, continue implementation, review, QA, CI triage, and PR updates inside `/slice`. Resolve ordinary best-practice checks from local project docs and the current code. If a genuinely unresolved design question blocks progress, ask whether to pause the slice for `/agent-research` instead of auto-switching.

## Fast Invocation

Accept short requests. The target can be a GitHub issue number, issue URL, PR URL, or plain slice description.

- `/slice #123`
- `/slice`
- `slice #123`
- `slice`
- `issue #123`

When the request omits the target, infer it only if the current conversation contains exactly one unambiguous active issue or slice. Use recent explicit user messages, issue links, PR links, and agreed "next slice" decisions as evidence. If there are zero candidates, multiple candidates, or the evidence depends on stale/compacted context, ask the user for the issue or slice instead of guessing.

The workflow already stops before merge, so the user does not need to say "do not merge" or "暂不合并".
If the user later asks to merge, use `/merge-pr <target>` for merge and cleanup.

## Start

1. Update from latest `main` before implementation.
2. Read the active project guidance before choosing or changing code:
   - root `AGENTS.md`
   - `keel/AGENTS.md` and `keel/CLAUDE.md`
   - `keel/TESTING.md`
   - `keel/SLICING.md`
   - `keel/ROADMAP.md` when choosing or justifying the next slice
   - `keel/EVALS.md` when changing evals or making quality-measurement claims
   - any other repo-local MD file directly relevant to the slice
3. Confirm the current branch, worktree status, existing PR state, and target issue/goal.
4. Protect unrelated user changes. Do not revert files you did not need to touch.

## BDD First

For behavior changes, write the BDD case before production code.

- Define the slice with the `keel/SLICING.md` sentence: "After this, a user can run ___ and see ___."
- Use Given / When / Then style.
- Make the test fail on the old behavior when practical.
- Cover product-visible behavior at the owning boundary.
- Do not test unreachable states or artificial TypeScript-invalid behavior just to raise coverage.
- If the work is a pure mechanical refactor with no behavior change, explain why no new test is needed.

## Implementation

1. Implement the minimum production change that satisfies the BDD case and project style.
2. Follow existing local patterns and module boundaries.
3. Keep abstractions concrete. Add indirection only for current proven duplication or a real boundary.
4. Re-run targeted tests after each meaningful change.

## Review

Before declaring the PR ready, start an empty-context subagent reviewer when subagents are available.

Reviewer prompt requirements:

- Read the project guidance MD files first.
- Review the branch against latest `main` and the PR/slice goal.
- Prioritize blocking, high, and medium correctness issues, missing tests, behavior regressions, and over-defensive or unreachable code.
- Do not edit files.

Fix all valid blocking/high/medium findings. For low/nit findings, apply only changes that improve clarity or correctness without broadening the slice.

## QA

Run professional QA before opening or updating the PR.

- Run Keel commands from `keel/` unless the slice is explicitly repo-level documentation or agent configuration.
- Run targeted tests for iteration.
- After file edits and formatting are complete, run independent local checks in parallel when practical: targeted tests, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm eval:check`, and `pnpm knip`.
- Run `pnpm test:coverage` for PR-ready verification. Use `pnpm test` only for fast local iteration.
- Run `pnpm coverage:patch` after coverage and after commit, before push, when the slice changes coverable code.
- For pure docs/skill-only changes, run the relevant metadata or Markdown validators and explain why the Keel test suite was not run.
- Use a real DeepSeek key for end-to-end QA when the slice has provider-visible behavior and the key is available. Never fake this result.
- Record exact commands and outcomes in the PR body.

## PR

Open or update the PR according to repo conventions.

PR body must include:

- Problem
- Solution
- Why
- Effect
- Verification
- Review notes or remaining risks

After pushing:

1. Watch GitHub CI.
2. Watch Codecov, especially patch coverage.
3. If coverage fails, triage according to project rules:
   - Add meaningful BDD coverage for reachable behavior, or
   - Remove unreachable or over-defensive code.
4. Do not lower coverage gates or add artificial tests for impossible paths.

## Stop Condition

Do not merge unless the user explicitly asks to merge.

Stop with:

- PR link
- head commit
- local validation results
- CI/Codecov status
- empty-context review result
- real DeepSeek QA result or a clear note that it could not be run
- remaining risks or follow-up issues
