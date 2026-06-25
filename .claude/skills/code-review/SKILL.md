---
name: code-review
description: 'Review Keel changes against the project documentation. Use for `/code-review`, `/code-review PR #123`, GitHub PR review URLs, `review this branch`, or `客观 review 当前 PR`. Do not edit files. Read the relevant repo docs first, prioritize correctness findings, cite exact files and lines, include a structured merge recommendation, and post the final review as a PR comment when the target is a GitHub PR.'
argument-hint: "[target]"
user-invocable: true
---

# Code Review

Use this workflow to review code, docs, or skill changes without modifying files.
If the review recommends `Merge now` and the user asks to merge, use `/merge-pr <target>` for the merge and cleanup steps.

## Fast Invocation

- `/code-review`
- `/code-review PR #123`
- `/code-review origin/main...HEAD`
- `review https://github.com/acmerfight/keel/pull/123`
- `review this branch`

If the target is omitted, infer it only when the current conversation or git state has one unambiguous review target. Otherwise ask for the PR, branch, commit range, or file set.

## Authorities

Read only the docs needed for the touched area. Do not duplicate the rules in the review; cite them when they matter. Do not cite a project rule you have not read in this session.

Load docs conditionally based on what the diff touches:

| Diff touches | Must read |
|---|---|
| any file in `keel/` | `keel/CLAUDE.md`, `keel/DEVELOPMENT.md` |
| `tests/` or test-adjacent code | `keel/TESTING.md` |
| `src/cli/`, `src/agent/`, or vertical-slice scope | `keel/SLICING.md` |
| `ROADMAP.md`, or PR claims priority/scope | `keel/ROADMAP.md` |
| `evals/`, `EVALS.md`, or eval workflow | `keel/EVALS.md` |
| submodule paths or root boundaries | root `AGENTS.md` |

## Execution

Complete the review in one pass within the main conversation context.
Do not use the Workflow tool, spawn subagents, or fan out parallel reviewers.
Read the diff once, inspect key surrounding code, then produce findings.

## Review Method

1. Identify the exact review target and base. Prefer the PR base or `origin/main...HEAD`.
2. Inspect the diff first, then read owning code, tests, and only the relevant repo docs.
3. Review against reachable behavior, safety invariants, and repo boundaries from the docs.
4. For GitHub PRs, check PR CI status with `gh pr checks` before local verification. If the current PR head already has passing CI, do not run local `pnpm` checks unless checks are stale/missing/failing or the diff exposes a specific uncovered risk.
5. Treat submodules as read-only references unless the review target explicitly includes submodule changes.

## PR Comment

When the target is a GitHub PR, post the final review as one PR comment after completing the review.

- Use `gh pr comment <number> --body-file <file>` when GitHub CLI auth is available.
- If the PR number is inferred, verify it with `gh pr view` before commenting.
- If GitHub auth or network access is unavailable, say that the PR comment could not be posted and include the exact review text in the final answer.
- Do not post duplicate comments for the same completed review.
- The PR comment must include the same structured merge recommendation as the final answer.

## Output

Use this structure:

1. Docs loaded (one-line list of doc names read for this review)
2. Findings
3. Merge Recommendation
4. Summary

Lead with findings, grouped by severity in this order:

- Blocking
- High
- Medium
- Low
- Nit / Info

For any empty severity group, write `None`. Do not omit the group.

For each finding include:

- severity
- exact file and line
- what is wrong
- why it matters
- concrete fix or decision needed

In `Merge Recommendation`, choose exactly one:

- `Merge now`
- `Merge after fixes`
- `Do not merge`

Include a one-sentence rationale tied to the findings and verification state.

Do not include separate open questions, assumptions, verification, or residual-risk sections. If an assumption or missing verification materially affects the decision, include it in the relevant finding or merge recommendation.

After the merge recommendation, include only a short summary of what changed.

If there are no findings, say that clearly and still include a merge recommendation and a short summary.
