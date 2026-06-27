---
name: modularization-review
description: 'Analyze Keel modularization candidates with taowen-style demand/change evidence. Use before a non-trivial slice when module fit is unclear, or for large files, boundaries, re-exports, barrels, facades, and architecture cleanup. Decide whether to implement the feature directly, do a prerequisite boundary refactor first, or do no architecture work. Produce a verdict and evidence; do not edit code unless the user separately invokes implementation.'
argument-hint: "[target]"
user-invocable: true
---

# Modularization Review

Decide whether Keel should do boundary work before or during a planned slice, especially before implementing a non-trivial feature. `Implement the feature directly` and `No architecture refactor now` are valid outcomes.

## Hard Rule

Do not recommend a split because a file is large, a type is awkward, or a dependency graph looks cleaner afterward. Recommend a prerequisite refactor only when the planned slice or realistic future demands would otherwise be forced into the wrong module, a busy orchestrator, unstable shared code, or repeated coordinated edits.

## Inputs

Use current facts.

1. Sync and inspect latest `main` unless the user explicitly asks for a branch or PR.
2. Read the relevant Keel docs and boundary tests before judging a candidate.
3. Read the candidate source, its facade if any, direct consumers, and tests/invariants that would catch drift.
4. Inspect recent churn, merged PRs, open PRs, and issues for the area.
5. Treat this skill as self-contained. Do not send the agent to external files just to apply the rules below. Open https://github.com/taowen/modularization-examples only when the user explicitly asks for source verification or disputes the interpretation.

## Decision Model

Use these distilled rules from https://github.com/taowen/modularization-examples:

- **New-demand edit map:** the main metric is where the next requirements would be coded. A good split reduces concentrated edits in one busy module or repeated coordinated edits across many modules.
- **Autonomy first:** a module boundary should let one change land in one concrete owner more often. Avoid splits that still require touching every extracted file.
- **Stable shared code:** lower/common modules with many dependents should change less often. Move use-case-specific flags, branches, and dependencies out of shared contracts.
- **No busy top layer:** do not replace one large orchestrator with a new programmable manager/service layer that will attract the same changes.
- **Add concrete modules:** prefer adding a feature-specific module when a new capability brings a new dependency or a distinct direction of change.
- **Volatility over taxonomy:** split by reasons to change, not by process steps or textbook categories.
- **Real interface change:** barrels, interfaces, package moves, or deployment changes are cosmetic if the same fat data contract keeps changing.
- **Loose contracts:** prefer thin IDs, pull/query surfaces, events without return values, UI/composition slots, or narrow facades when they reduce exchanged information.
- **Enforced hiding:** facades and plugin-like boundaries are useful only when tests or lint rules stop wrong imports.
- **Feedback cost matters:** a split must keep reading, tests, logs, and failure attribution clear enough to be worth the indirection.

## Keel-Specific Heuristics

- Compare candidates against recent useful cuts when demand/change evidence is present: compaction restore/read visibility, CLI arg parsing, provider config, and tool-call contracts.
- Good Keel refactors move behavior to concrete owner modules and leave a small router/facade. They do not add generic registries, runtime dependency injection, or speculative extension points.
- Explicit allowlisted facades can be right. Wildcard re-exports and generic `index.ts` barrels are suspect.
- Big cohesive safety/schema files may stay large when they are stable, have one reason to change, or protect a security boundary.

## Rejection Tests

Reject or downgrade a proposal when:

- it cannot name realistic future demands whose edit map improves;
- it mainly reduces line count;
- it follows flow steps but future changes still touch all pieces;
- it only changes import shape, interface syntax, packaging, or deployment;
- the facade exposes raw CRUD/data access instead of a narrow slot, policy, or stable contract;
- it adds a top-level programmable orchestrator above feature modules;
- it makes navigation or debugging materially harder without a compensating boundary gain;
- it centralizes business variation under "consistency" without proving real shared policy or duplicated non-functional behavior.

## Workflow

For each serious candidate:

1. Record current responsibilities, consumers, facade/import shape, tests, and recent churn.
2. Include the planned slice as the first demand scenario when this is used before implementation.
3. Build one or two additional realistic next-demand scenarios.
4. For each scenario, compare files/modules touched before vs. after the proposed split.
5. Check Autonomy, Consistency, and Feedback explicitly.
6. Classify as `Refactor before slice`, `Refactor inside slice`, `Implement feature directly`, `Watch`, or `No architecture refactor now`.

## Output

Return:

1. Verdict.
2. Evidence with file paths, churn/PR facts, import facts, and boundary tests.
3. The before/after demand edit map.
4. Why tempting alternatives are lower priority.
5. If doing work: whether the boundary refactor is a prerequisite slice or part of the feature slice, exact boundary, forbidden imports, invariant tests, and acceptance criteria.
6. If not doing work: what evidence would change the answer.

## Implementation Handoff

When the user asks to implement after a positive verdict, hand off to `/slice` with a bounded goal. State whether the boundary work should be a prerequisite slice or part of the feature slice; let the slice workflow own implementation, testing, review, and PR mechanics.
