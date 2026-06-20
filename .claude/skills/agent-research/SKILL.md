---
name: agent-research
description: 'Research how peer coding agents in this repository solve a specific problem, then propose the best Keel design. Use for `/agent-research context compaction`, `/agent-research session persistence`, `deeply compare other agents`, `how do codex/claude/opencode/pi/kimi solve this`, or `give Keel a best方案 based on source evidence and recent industry practice`. Require factual source-code evidence from repo submodules, current external research or community evidence when available, clear separation of facts from inference, and a concrete recommendation for Keel.'
argument-hint: "<question>"
user-invocable: true
---

# Agent Research

Use this workflow to answer one architecture or product-design question by comparing Keel with the reference agents in this repo and current industry practice.

## Fast Invocation

Accept a concrete research target:

- `/agent-research context compaction`
- `/agent-research session persistence`
- `/agent-research how should Keel implement <capability>`
- `deeply compare other agents on <problem>`

If the request omits the research target, infer it only when the current conversation has exactly one unambiguous active problem. Otherwise ask for the problem statement.

## Scope

Use the repo as primary evidence.

- Keel implementation: `keel/`
- Reference agents: `codex/`, `claude-code/`, `opencode/`, `kimi-code/`, `pi/`
- Project guidance: root `AGENTS.md`, plus `keel/AGENTS.md`, `keel/TESTING.md`, `keel/SLICING.md`, and `keel/ROADMAP.md` when they affect the recommendation

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
- risks and open questions
- evidence summary with local source references and external links

If evidence is insufficient, do not overstate. Say what is unknown and what additional inspection or experiment would resolve it.
