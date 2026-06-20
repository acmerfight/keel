---
name: code-review
description: 'Review Keel changes against the project documentation. Use for `/code-review`, `/code-review PR #123`, `review this branch`, or `客观 review 当前 PR`. Do not edit files. Read the relevant repo docs first, prioritize correctness/regression/test/safety findings, cite exact files and lines, include a structured merge recommendation, and post the final review as a PR comment when the target is a GitHub PR.'
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
- `review this branch`

If the target is omitted, infer it only when the current conversation or git state has one unambiguous review target. Otherwise ask for the PR, branch, commit range, or file set.

## Authorities

Read only the docs needed for the touched area. Do not duplicate the rules in the review; cite them when they matter.

- root `AGENTS.md` for repo boundaries and submodule rules
- `keel/AGENTS.md` and `keel/CLAUDE.md` for architecture, style, merge workflow, and development rules
- `keel/TESTING.md` for test boundaries, GWTE naming, coverage triage, and reachable-behavior rules
- `keel/SLICING.md` for vertical-slice expectations
- `keel/ROADMAP.md` when reviewing priority, scope, or roadmap claims
- `keel/EVALS.md` when reviewing eval tasks, quality claims, or eval workflow changes

## Review Method

1. Identify the exact review target and base. Prefer the PR base or `origin/main...HEAD`.
2. Inspect the diff before forming conclusions.
3. Read the owning code and tests around each changed behavior.
4. Check whether tests cover reachable behavior at the owning boundary. Do not ask for artificial tests for impossible states.
5. Check safety boundaries, provider/tool protocol contracts, session/state persistence, cost/accounting, and abort/rollback behavior when touched.
6. For docs or skill-only changes, review invocation syntax, host-specific paths, metadata validity, and alignment with the authoritative docs.
7. Treat submodules as read-only references unless the review target explicitly includes a submodule change.

## PR Comment

When the target is a GitHub PR, post the final review as one PR comment after completing the review.

- Use `gh pr comment <number> --body-file <file>` when GitHub CLI auth is available.
- If the PR number is inferred, verify it with `gh pr view` before commenting.
- If GitHub auth or network access is unavailable, say that the PR comment could not be posted and include the exact review text in the final answer.
- Do not post duplicate comments for the same completed review.
- The PR comment must include the same structured merge recommendation as the final answer.

## Output

Use this structure:

1. Findings
2. Merge Recommendation
3. Open Questions Or Assumptions
4. Verification And Residual Risk
5. Summary

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

After the merge recommendation, include:

- open questions or assumptions
- missing verification or residual risk
- short summary of what changed

If there are no findings, say that clearly and still include a merge recommendation, any test gaps or residual risk, and a short summary.
