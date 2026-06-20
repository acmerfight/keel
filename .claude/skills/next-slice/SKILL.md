---
name: next-slice
description: 'Recommend the next Keel slice from latest main, project goals, open issues, current implementation state, and peer-agent evidence. Use for `/next-slice`, `what should we do next`, `which slice now`, or `基于最新 main 分析该做什么`. Produce a fact-grounded recommendation, not code changes, unless the user explicitly asks to implement.'
argument-hint: "[focus=<area>]"
user-invocable: true
---

# Next Slice

Use this workflow to decide what Keel should work on next. The output is a recommendation with evidence, not an implementation PR.

## Workflow Position

Use this first when the next unit of work is unclear.

- Use `/next-slice` to choose the next slice.
- Use `/agent-research <question>` when a candidate needs deeper peer-agent or industry research before it is ready to implement.
- Use `/slice <issue-or-slice>` only after the implementation target is clear.

Keep peer-agent comparison deep enough to rank candidates. Do not fully design every candidate; hand off unresolved design questions to `/agent-research`.

## Fast Invocation

- `/next-slice`
- `/next-slice focus=<area>`
- `what should we do next`
- `which slice now`

If the user gives a focus area, evaluate the next slice inside that area. Otherwise evaluate the whole project.

## Hard Boundary

Do not implement code. Do not open or update a PR. Do not create issues unless the user explicitly asks. This skill stops after recommending the next slice and explaining the evidence.

## Evidence Sources

Use current state, not memory.

1. Sync and inspect latest `main`:
   - Fetch `origin/main`.
   - If not already on `main`, compare against `origin/main` and avoid treating branch-local work as landed unless the user asks for branch-specific analysis.
2. Read project intent and process:
   - root `AGENTS.md`
   - `keel/AGENTS.md` and `keel/CLAUDE.md`
   - `keel/ROADMAP.md`
   - `keel/SLICING.md`
   - `keel/TESTING.md`
   - `keel/EVALS.md` when evals or quality measurement affect priority
   - other repo docs directly relevant to the candidate area
3. Inspect issue and PR evidence:
   - Use `gh issue list` and `gh issue view` when available.
   - Include open issues, recently updated issues, and issues referenced in recent PRs when they affect priority.
   - If GitHub access is unavailable, say so and use local docs/git history as weaker evidence.
4. Inspect Keel current capability:
   - Search `keel/src` and `keel/tests` with `rg`.
   - Identify what already exists, what is missing, and what recent slices changed.
5. Use reference agents only where relevant:
   - `codex/`
   - `claude-code/`
   - `opencode/`
   - `kimi-code/`
   - `pi/`

Do not modify submodule contents. Treat reference agents as read-only evidence.

## Analysis Method

1. State the project goal you are optimizing for.
2. Treat `keel/ROADMAP.md` as the default source for priority order and `keel/SLICING.md` as the source for how to cut the chosen work.
3. List 3-5 plausible next slices. Include the evidence that made each candidate plausible.
4. Score each candidate qualitatively:
   - user value
   - dependency unlock
   - risk reduction
   - fit with current architecture
   - testability
   - implementation size
5. Compare with peer agents when a candidate overlaps a known agent capability. Cite local source files and line numbers for each factual claim.
6. Prefer foundational gaps over eval-only or polish work when basic product capabilities are incomplete.
7. Prefer narrow vertical slices over broad infrastructure unless the infrastructure is blocking multiple high-value slices.
8. Mark inferences explicitly. Do not present guesses as facts.

## Output

Return:

1. Recommended next slice
2. Why this is the best next slice now
3. Evidence from project docs, issues, current Keel code, and peer agents
4. Why the other candidates are lower priority
5. Proposed slice boundary
6. BDD-style test cases expected for the slice
7. Risks, open questions, and what would change the recommendation

End with a short handoff prompt that can be used with `/slice` if the user wants to implement the recommended slice.
