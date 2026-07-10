---
name: agent-research
description: 'Explicit-only research workflow for peer-agent implementations or external industry practice on one unresolved Keel architecture or product-design question before implementation. Use when the user invokes `/agent-research <question>` to compare codex/claude/opencode/pi/kimi, research industry practice, or decide an unclear design. Do not use implicitly during `/slice` implementation, PR review, QA, CI fixing, merge cleanup, or ordinary best-practice checks.'
argument-hint: "<question>"
user-invocable: true
---

# Agent Research

Use this workflow before implementation to answer one unresolved architecture or product-design question by comparing Keel with the reference agents in this repo and current industry practice.

## Hard Boundary

Do not run during an active `/slice` implementation. If `/slice` is already selected and the target is clear, continue the slice workflow. Use this only if the user explicitly asks to pause implementation for peer-agent or external research.

## Workflow Position

Use this before `/slice` starts, after `/next-slice` identifies a promising direction but the design, tradeoffs, or peer-agent precedent are still unclear. Also use it directly when the user explicitly invokes `/agent-research` with a concrete technical or product-design question.

- Do not rank the whole project backlog; use `/next-slice` for that.
- Do not implement the result; use `/slice <issue-or-slice>` after the design is clear.
- End with a concrete handoff recommendation when the research supports implementation.

## Fast Invocation

Accept a concrete research target:

- `/agent-research context compaction`
- `/agent-research session persistence`
- `/agent-research how should Keel implement <capability>`
- `/agent-research deeply compare other agents on <problem>`

If the request omits the research target, infer it only when the current conversation has exactly one unambiguous active problem. Otherwise ask for the problem statement.

## Scope

Use the repo as primary evidence.

- Keel implementation: `keel/`
- Reference agents: `codex/`, `claude-code/`, `opencode/`, `kimi-code/`, `pi/`
- Project guidance: root `AGENTS.md`, plus `keel/CLAUDE.md`, `keel/DEVELOPMENT.md`, `keel/TESTING.md`, `keel/SLICING.md`, `keel/ROADMAP.md`, and `keel/EVALS.md` when they affect the recommendation

Do not modify submodule contents. Treat reference agents as read-only evidence.

## Research Discipline

1. Restate the exact question and the Keel decision that needs an answer.
2. Inspect Keel first enough to understand current architecture, constraints, and already completed slices.
3. Search each relevant reference agent with `rg` before reading files. Use targeted terms from the problem domain and adjacent concepts.
4. For each agent, cite concrete source evidence with file paths and line numbers. If an agent has no relevant implementation, say what was searched and why the evidence is absent.
5. Use current external evidence when the question asks for recent or industry best practice, or when the answer would benefit from current state of the art. Prefer sources in this order:
   - peer-reviewed papers or arXiv papers with dates
   - official docs, release notes, design docs, or standards
   - project issues, PRs, and maintainer discussions
   - reputable engineering posts
   - community discussions only as weak supporting evidence
6. Cite external sources with links and dates. Do not rely on memory for "latest" or "recent" claims.
7. Separate facts, inferences, and recommendations. Mark inferences explicitly.
8. Prefer Keel-fit design over copying another agent. Account for Keel's size, existing abstractions, tests, provider model, and roadmap.

## Comparison Matrix

When at least two reference agents have relevant behavior, include a compact matrix:

- Agent
- Source files inspected
- Strategy
- Strengths
- Weaknesses or tradeoffs
- What Keel should copy, avoid, or adapt

## Recommendation

End with a concrete Keel proposal.

Include:

- recommended design
- why it fits Keel now
- why alternatives are worse for Keel
- implementation slices, ordered by dependency and value
- expected tests, using BDD style when behavior changes
- the `keel/SLICING.md` sentence for any implementation handoff: "After this, a user can run ___ and see ___."
- risks and open questions
- evidence summary with local source references and external links

If evidence is insufficient, do not overstate. Say what is unknown and what additional inspection or experiment would resolve it.
