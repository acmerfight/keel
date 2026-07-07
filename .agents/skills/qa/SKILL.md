---
name: qa
description: 'Professional black-box QA for the Keel agent. Design a comprehensive, research-grounded test suite for a scope and run it against real providers with the locally configured keys. Use for `$qa`, `$qa PR #123`, `$qa origin/main...HEAD`, `$qa provider auth`, `黑盒测试`, `全面 QA`, `设计 case 测 agent`, `对 agent 做黑盒测试`. Design happy, edge, adversarial, and regression cases; execute through the real CLI harness; grade observable behavior (exit code, stdout, stderr tool trajectory, filesystem, --report JSON, wire requests); and report structured findings with repro steps. Default provider deepseek under a strict cost cap; cross-check kimi/qwen only on request or provider-specific findings. Do not merge.'
---

# QA

Use this workflow to run deep, standalone black-box QA against the Keel agent: design a
comprehensive test suite for a scope, execute it against real providers with the locally
configured keys, grade observable behavior, and report structured findings. Confirmed
bugs can then be graduated into committed BDD regression tests.

This is an execution-heavy adversarial pass. It is distinct from and complementary to:

- `$code-review` — reads a diff, cites rules, does not execute the agent.
- `$slice` QA — build, lint, typecheck, coverage, plus one real-provider smoke.

`$qa` is the exhaustive black-box run: many designed cases, real model behavior, oracles.
Never merge from this workflow; hand findings back to the user.

## Fast Invocation

Accept a concrete QA target:

- `$qa PR #123` — resolve the PR base with `gh`, derive touched surfaces from the diff.
- `$qa origin/main...HEAD` — a branch or commit range.
- `$qa provider auth` / `$qa edit tool` — a named feature or area.
- `$qa` (bare) — whole-agent smoke over core tool and loop paths.

If the target is omitted, infer it only when the current thread or git state has exactly
one unambiguous QA target. Otherwise ask for the PR, range, feature, or "smoke".

## Scope Resolution

1. Identify the exact scope and, for a diff-based target, the base
   (prefer the PR base or `origin/main...HEAD`).
2. For a PR or range, read the diff first, then the owning code, to find the real risk
   surface. Mine it the way `.claude/plans/qa-blackbox-pr370.md` mined the auth PR:
   trim/normalize edges, resolution-priority interplay, overwrite/idempotency,
   symlink/path edges, partial state, schema poisoning, and the E2E critical path.
3. For a named feature, read that module plus its tests to learn its contract.
4. For whole-agent smoke, cover the built-in tool contracts and the loop control-flow
   classes (the `keel/qa-blackbox.ts` scenario set is the reference starting point).
## Environment And Keys

Run everything from `keel/`. Use the real black-box seam — never assert on internals.

- **In-process harness** (preferred, matches `keel/qa-blackbox.ts`): build a runtime with
  `createRuntime(args, { cwd, env })` from `src/testing/cli-runtime-fixtures.ts`, then call
  `runCliMain(fixture.runtime)` from `src/cli/index.ts`. Read `fixture.stdout()`,
  `fixture.stderr()`, and the returned exit code. Run the scratch harness with
  `node --experimental-strip-types <harness>.ts`.
- **Subprocess alternative** when you need the true process boundary (signals, real TTY):
  `node --experimental-strip-types src/cli/index.ts …`.
- **Key precedence** (`src/cli/provider-selection.ts`): a non-empty env key wins, else the
  stored `auth.json` key; `--provider` and `--model` override selection. Env keys:
  `DEEPSEEK_API_KEY`, `KIMI_API_KEY`, `DASHSCOPE_API_KEY` or `QWEN_API_KEY` (with
  `QWEN_BASE_URL`). The keyless `fake` provider is for deterministic control-flow cases.
- **Isolation**: every case gets its own `mkdtemp` workspace; stored-auth cases also get
  their own `KEEL_HOME`. Always clean up in `finally`. Never touch the real repo or `$HOME`.
- **Cost discipline**: always pass `--max-cost` and keep the whole run under a stated cap.
  Default provider is `deepseek`; cross-check `kimi`/`qwen` only on request or when a
  finding looks provider-specific.
- **Safety**: never fabricate a real-provider result, and never print raw API key values.

## Case Design

Design before you run. Budget the case mix roughly: ~40% happy path, ~30% edge, ~20%
adversarial/safety, ~10% regression (past incidents and prior findings).

Apply a task-quality gate to every case before it counts:

- Two reviewers would independently reach the same pass/fail verdict.
- Everything the grader checks is stated in the prompt (no hidden expectations).
- The task is solvable and you know a reference outcome. A 0%-pass across trials usually
  means a broken case or grader, not an incapable agent — fix the case first.

Adversarial seeds worth covering: prompt-injection through file or tool-result content,
contradictory instructions, ambiguous or missing information, out-of-scope or forbidden
tool requests (for example bash when disabled), doom-loop bait, and impossible
"know when to fold" tasks that should be refused rather than faked.

## Grading

Grade observable outcomes and state, not the exact tool order — the agent may reach a
valid result by an unanticipated path, and that must pass.

Deterministic oracles first: exit code; file and directory state; the `Tool: <name>`
trajectory in stderr; local HTTP/SSE request capture for what hits the wire; the
`--report` JSON (`turns`, `stopReason`, `usage`, `costUsd`, `schemaVersion`); and
`--transcript` JSONL when needed. Use an LLM-judge only for open-ended output, with a
narrow single-dimension rubric and an explicit "Unknown" escape.

When a tool case fails, name which of the four layers broke: tool selection, argument
extraction, result utilization, or error recovery.
## Non-Determinism

For behavioral cases whose result can vary between runs, run N trials (default 3) and
report both `pass@k` (at least one success) and `pass^k` (every trial succeeds); note when
they diverge. Treat a single-trial pass on a behavioral case as weak evidence. Purely
deterministic CLI, config, and schema cases need one run.

## Findings Report

The report is the primary artifact. Structure it as:

1. Scope and base, providers used, total cost, and trial counts.
2. Case matrix: id, category, prompt, oracle, provider, `pass@k` / `pass^k`, verdict.
3. Findings grouped Blocking / High / Medium / Low / Nit-Info. Each finding states a
   concrete failure scenario (inputs or state → wrong output or state), a repro command,
   and the offending `file:line` when identifiable. Write `None` for any empty group.
4. Failure-mode distribution (for example wrong-tool vs bad-args vs no-recovery) so fixes
   can be prioritized, plus a cost-of-pass note where relevant.

## Graduating Regressions

Only on request, and only for a *confirmed* bug, author a committed BDD regression test.
Place it at the boundary that owns the risk per `keel/TESTING.md`
(`agent/`, `cli/`, `providers/`, `tools/`, or `invariants/`), with a Given/When/Then title
and an assertion on observable output or state. Use real tools, the `fake` provider seam,
or a local server as the boundary dictates. Follow the pre-release rule: no compatibility
shims, migrations, or legacy-schema tests unless explicitly requested.

## Stop Condition

Do not merge. Finish with:

- scope and base
- providers used and total cost
- case matrix summary
- findings grouped by severity, with repro steps
- any graduated regression tests
- remaining risks or follow-up issues to file
