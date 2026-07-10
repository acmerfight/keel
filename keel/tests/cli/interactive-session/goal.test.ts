import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../../src/agent/events.ts";
import {
  formatInteractiveGoal,
  parseInteractiveCommand,
} from "../../../src/cli/interactive-session/commands.ts";
import { runInteractiveSession } from "../../../src/cli/interactive-session.ts";
import {
  createSessionStore,
  persistSessionGoal,
} from "../../../src/cli/session-store.ts";
import {
  SESSION_GOAL_COMPLETION_EVIDENCE_REASON_MAX_LENGTH,
  type SessionGoal,
} from "../../../src/core/session-goal.ts";
import type { LLMProvider, Message } from "../../../src/llm/types.ts";
import {
  ForcedExit,
  withTimeout,
  ZERO_COST_MODEL,
  ZERO_USAGE,
} from "../../../src/testing/interactive-session-fixtures.ts";
import { runtime } from "../../../src/testing/session-store-fixtures.ts";

function unusedProvider(id: string): LLMProvider {
  return {
    id,
    async *stream() {
      if (id === "") {
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
        return;
      }
      throw new Error("Provider should not be called for local goal commands");
    },
  };
}

async function runLocalGoalCommandScenario(options: {
  readonly commands: readonly string[];
  readonly initialGoal?: SessionGoal;
  readonly persistence: "normal" | "missing" | "throw";
}): Promise<{
  readonly stdout: string;
  readonly stderr: string;
  readonly persistedGoals: readonly SessionGoal[];
}> {
  const input = new PassThrough();
  let stdout = "";
  let stderr = "";
  const persistedGoals: SessionGoal[] = [];
  const session = runInteractiveSession({
    cliArgs: { bashMode: "disabled" },
    workspace: process.cwd(),
    platform: process.platform,
    ...(options.initialGoal !== undefined
      ? { initialSessionGoal: options.initialGoal }
      : {}),
    input,
    writeStdout: (text) => {
      stdout += text;
    },
    writeStderr: (text) => {
      stderr += text;
    },
    onSigint: () => {},
    offSigint: () => {},
    setExitCode: () => {},
    forceExit: (code) => {
      throw new ForcedExit(code);
    },
    ...(options.persistence === "missing"
      ? {}
      : {
          persistSessionGoal: ({
            goal,
          }: {
            readonly goal: SessionGoal | null;
          }) => {
            if (options.persistence === "throw") {
              throw new Error("goal persistence failed");
            }
            if (goal === null) return undefined;
            persistedGoals.push(goal);
            return goal;
          },
        }),
    resolveProvider: () => ({
      provider: unusedProvider(""),
      providerId: "fake",
      model: "fake",
      costModel: ZERO_COST_MODEL,
    }),
    requireKnownCostModel: () => ZERO_COST_MODEL,
    printAgentEvents: async () => undefined,
    formatCostReport: () => "",
  });
  input.end(`${options.commands.join("\n")}\n`);
  await session;
  return { stdout, stderr, persistedGoals };
}

const REDACTION_EXPANDING_SECRET = " sk-aaaa";
const REDACTION_EXPANDING_SECRET_REPETITIONS = 40;

function redactionExpandingText(maxLength: number): string {
  return `${"x".repeat(
    maxLength -
      REDACTION_EXPANDING_SECRET.length *
        REDACTION_EXPANDING_SECRET_REPETITIONS,
  )}${REDACTION_EXPANDING_SECRET.repeat(
    REDACTION_EXPANDING_SECRET_REPETITIONS,
  )}`;
}

describe("Interactive Session - Goals", () => {
  test(`Given a goal has no completion evidence,
    When the interactive goal status is formatted,
    Then Keel does not print an empty evidence line`, () => {
    expect(
      formatInteractiveGoal({
        objective: "Continue checkout",
        status: "active",
        budget: {},
        usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
        criterionKind: "command",
        completionCriterion: "pnpm test",
      }),
    ).toBe(
      "Session goal: active - Continue checkout; criterion(command): pnpm test\n",
    );
  });

  test(`Given a completed goal has completion evidence,
    When the interactive goal status is formatted,
    Then Keel prints the evidence on a separate line`, () => {
    expect(
      formatInteractiveGoal({
        objective: "Ship checkout",
        status: "completed",
        budget: {},
        usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
        completionEvidence: { kind: "user_override" },
      }),
    ).toBe(
      "Session goal: completed - Ship checkout; criterion: missing\n" +
        "Session goal evidence: user explicitly completed the goal with /goal complete\n",
    );
  });

  test(`Given a goal has a singular token budget and a punctuated limit reason,
    When the interactive status is formatted with accounting,
    Then Keel uses singular grammar and a clean reason separator`, () => {
    expect(
      formatInteractiveGoal({
        objective: "Respect one token",
        status: "budget_limited",
        statusReason: "Session goal budget reached: tokens 2/1.",
        budget: { tokens: 1 },
        usage: { turns: 1, tokens: 2, activeTimeMs: 0 },
      }),
    ).toBe(
      "Session goal: budget_limited - Respect one token; criterion: missing; reason: Session goal budget reached: tokens 2/1; usage: 1 turn, 2 tokens, 0ms active; budget: 1 token\n",
    );
  });

  test(`Given the goal command receives an objective,
    When the interactive command is parsed,
    Then Keel treats it as a local goal command instead of a prompt`, () => {
    expect(parseInteractiveCommand("/goal Fix checkout tests")).toEqual({
      kind: "goal",
      action: "set",
      objective: "Fix checkout tests",
    });
    expect(parseInteractiveCommand("/goal")).toEqual({
      kind: "goal",
      action: "show",
    });
    expect(parseInteractiveCommand("/goal status")).toEqual({
      kind: "goal",
      action: "show",
    });
    expect(parseInteractiveCommand("/goal complete")).toEqual({
      kind: "goal",
      action: "complete",
    });
    expect(parseInteractiveCommand("/goal pause")).toEqual({
      kind: "goal",
      action: "pause",
    });
    expect(parseInteractiveCommand("/goal resume")).toEqual({
      kind: "goal",
      action: "resume",
    });
    expect(parseInteractiveCommand("/goal budget")).toEqual({
      kind: "goal",
      action: "show_budget",
    });
    expect(
      parseInteractiveCommand(
        "/goal budget --turns 20 --tokens 50000 --time 30m",
      ),
    ).toEqual({
      kind: "goal",
      action: "budget",
      budget: {
        turns: 20,
        tokens: 50_000,
        activeTimeMs: 30 * 60 * 1000,
      },
    });
    expect(parseInteractiveCommand("/goal budget clear")).toEqual({
      kind: "goal",
      action: "clear_budget",
    });
    expect(parseInteractiveCommand("/goal budget --turns 0")).toEqual({
      kind: "invalid",
      message: "Error: --turns must be a positive integer.",
      scope: "goal",
    });
    expect(
      parseInteractiveCommand("/goal budget --turns 999999999999999999999999"),
    ).toEqual({
      kind: "invalid",
      message: "Error: --turns must be a positive integer.",
      scope: "goal",
    });
    expect(parseInteractiveCommand("/goal budget --time nope")).toEqual({
      kind: "invalid",
      message:
        "Error: --time must be a positive duration using ms, s, m, or h.",
      scope: "goal",
    });
    expect(parseInteractiveCommand("/goal budget --time")).toEqual({
      kind: "invalid",
      message:
        "Error: --time must be a positive duration using ms, s, m, or h.",
      scope: "goal",
    });
    expect(
      parseInteractiveCommand("/goal budget --time 999999999999999999999h"),
    ).toEqual({
      kind: "invalid",
      message:
        "Error: --time must be a positive duration using ms, s, m, or h.",
      scope: "goal",
    });
    expect(
      parseInteractiveCommand(
        "/goal budget --time 5ms --time 6s --time 7m --time 8h",
      ),
    ).toEqual({
      kind: "goal",
      action: "budget",
      budget: { activeTimeMs: 8 * 60 * 60 * 1000 },
    });
    expect(parseInteractiveCommand("/goal budget --wat 1")).toEqual({
      kind: "invalid",
      message: 'Error: unknown /goal budget option "--wat".',
      scope: "goal",
    });
    expect(parseInteractiveCommand("/goal verify pnpm test")).toEqual({
      kind: "goal",
      action: "verify",
      command: "pnpm test",
    });
    expect(
      parseInteractiveCommand("/goal done-when release notes cover every flag"),
    ).toEqual({
      kind: "goal",
      action: "criterion",
      criterionKind: "assertion",
      criterion: "release notes cover every flag",
    });
    expect(parseInteractiveCommand("/goal verify")).toEqual({
      kind: "invalid",
      message: "Error: /goal verify requires a command.",
      scope: "goal",
    });
    expect(parseInteractiveCommand("/goal done-when")).toEqual({
      kind: "invalid",
      message: "Error: /goal done-when requires a completion criterion.",
      scope: "goal",
    });
    expect(parseInteractiveCommand("/goal clear")).toEqual({
      kind: "goal",
      action: "clear",
    });
  });

  test(`Given goal budget commands are used across unsupported local states,
    When Keel handles them without running a provider turn,
    Then every command reports a recoverable error and valid immediate limits preserve the goal contract`, async () => {
    const missingPersistence = await runLocalGoalCommandScenario({
      commands: [
        "/goal budget",
        "/goal budget --turns 2",
        "/goal budget clear",
      ],
      persistence: "missing",
    });
    expect(missingPersistence.stdout).toContain("Session goal: none\n");
    expect(missingPersistence.stderr).toBe(
      "Error: /goal requires a saved session. Start without --ephemeral, or use --session or --resume.\n".repeat(
        2,
      ),
    );

    const missingAndCompletedGoals = await runLocalGoalCommandScenario({
      commands: [
        "/goal budget --turns 2",
        "/goal budget clear",
        "/goal Ship checkout",
        "/goal complete",
        "/goal budget --turns 2",
        "/goal budget clear",
      ],
      persistence: "normal",
    });
    expect(missingAndCompletedGoals.stderr).toBe(
      [
        "Error: no session goal is set.\n",
        "Error: no session goal is set.\n",
        "Error: completed session goals cannot change budgets. Set a new goal first.\n",
        "Error: completed session goals cannot change budgets. Set a new goal first.\n",
      ].join(""),
    );

    const persistenceFailures = await runLocalGoalCommandScenario({
      commands: ["/goal budget --turns 2", "/goal budget clear"],
      initialGoal: {
        objective: "Keep persisted accounting",
        status: "paused",
        budget: {},
        usage: { turns: 1, tokens: 10, activeTimeMs: 100 },
      },
      persistence: "throw",
    });
    expect(persistenceFailures.stderr).toBe(
      "goal persistence failed\n".repeat(2),
    );

    const belowBudget = await runLocalGoalCommandScenario({
      commands: ["/goal budget --turns 2"],
      initialGoal: {
        objective: "Stay below budget",
        status: "active",
        budget: {},
        usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
      },
      persistence: "normal",
    });
    expect(belowBudget.persistedGoals.at(-1)?.status).toBe("active");

    const exhaustedWithCriterion = await runLocalGoalCommandScenario({
      commands: ["/goal budget --turns 1"],
      initialGoal: {
        objective: "Limit immediately",
        status: "active",
        budget: {},
        usage: { turns: 1, tokens: 0, activeTimeMs: 0 },
        criterionKind: "command",
        completionCriterion: "pnpm test",
      },
      persistence: "normal",
    });
    expect(exhaustedWithCriterion.persistedGoals.at(-1)).toMatchObject({
      status: "budget_limited",
      criterionKind: "command",
      completionCriterion: "pnpm test",
    });

    const exhaustedWithoutCriterion = await runLocalGoalCommandScenario({
      commands: ["/goal budget --turns 1"],
      initialGoal: {
        objective: "Limit immediately without criterion",
        status: "active",
        budget: {},
        usage: { turns: 1, tokens: 0, activeTimeMs: 0 },
      },
      persistence: "normal",
    });
    expect(exhaustedWithoutCriterion.persistedGoals.at(-1)).toMatchObject({
      status: "budget_limited",
      budget: { turns: 1 },
    });
  });

  test(`Given a saved goal is limited at its current budget,
    When the user tries to resume, raises the budget, resumes, and clears it,
    Then Keel enforces an explicit usable budget before preserving lifecycle state`, async () => {
    // Given
    const input = new PassThrough();
    let stdout = "";
    let stderr = "";
    const persistedGoals: SessionGoal[] = [];
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      sessionId: "goal-budget-lifecycle",
      initialSessionGoal: {
        objective: "Finish the budgeted checkout goal",
        status: "budget_limited",
        statusReason: "Session goal budget reached: turns 2/2.",
        budget: { turns: 2 },
        usage: { turns: 2, tokens: 200, activeTimeMs: 1_000 },
        criterionKind: "assertion",
        completionCriterion: "The budgeted checkout goal is finished",
      },
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      persistSessionGoal: ({ goal }) => {
        if (goal === null) return undefined;
        persistedGoals.push(goal);
        return goal;
      },
      resolveProvider: () => ({
        provider: unusedProvider(""),
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => undefined,
      formatCostReport: () => "",
    });

    // When
    input.end(
      [
        "/goal resume",
        "/goal budget --turns 3 --tokens 1000 --time 5s",
        "/goal resume",
        "/goal budget clear",
        "/goal pause",
        "/goal",
        "",
      ].join("\n"),
    );
    await session;

    // Then
    expect(stderr).toBe(
      "Error: Session goal budget reached: turns 2/2. Raise or clear the goal budget before resuming.\n",
    );
    expect(persistedGoals).toEqual([
      {
        objective: "Finish the budgeted checkout goal",
        status: "budget_limited",
        statusReason: "Session goal budget reached: turns 2/2.",
        budget: { turns: 3, tokens: 1_000, activeTimeMs: 5_000 },
        usage: { turns: 2, tokens: 200, activeTimeMs: 1_000 },
        criterionKind: "assertion",
        completionCriterion: "The budgeted checkout goal is finished",
      },
      {
        objective: "Finish the budgeted checkout goal",
        status: "active",
        budget: { turns: 3, tokens: 1_000, activeTimeMs: 5_000 },
        usage: { turns: 2, tokens: 200, activeTimeMs: 1_000 },
        criterionKind: "assertion",
        completionCriterion: "The budgeted checkout goal is finished",
      },
      {
        objective: "Finish the budgeted checkout goal",
        status: "active",
        budget: {},
        usage: { turns: 2, tokens: 200, activeTimeMs: 1_000 },
        criterionKind: "assertion",
        completionCriterion: "The budgeted checkout goal is finished",
      },
      {
        objective: "Finish the budgeted checkout goal",
        status: "paused",
        budget: {},
        usage: { turns: 2, tokens: 200, activeTimeMs: 1_000 },
        criterionKind: "assertion",
        completionCriterion: "The budgeted checkout goal is finished",
      },
    ]);
    expect(stdout).toContain("Goal budget updated.\n");
    expect(stdout).toContain(
      "Goal resumed: Finish the budgeted checkout goal\n",
    );
    expect(stdout).toContain("Goal budget cleared.\n");
    expect(stdout).toContain(
      "usage: 2 turns, 200 tokens, 1s active; budget: none\n",
    );
    expect(stdout).toContain(
      "Session goal: paused - Finish the budgeted checkout goal; criterion(assertion): The budgeted checkout goal is finished\n",
    );
  });

  test(`Given a saved interactive session has an active goal,
    When the user checks status and sends a follow-up,
    Then Keel shows the goal and keeps it visible to the provider`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-goal-"));
    const input = new PassThrough();
    let stdout = "";
    let stderr = "";
    let persistedGoal: SessionGoal | undefined;
    const providerPrompts: string[] = [];
    const providerMessages: (readonly Message[])[] = [];
    const provider: LLMProvider = {
      id: "goal-provider",
      async *stream(options) {
        providerPrompts.push(options.systemPrompt);
        providerMessages.push(structuredClone([...options.messages]));
        yield { type: "text", text: "Continuing goal." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace,
      platform: process.platform,
      sessionId: "goal-session",
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      persistSessionGoal: ({ goal }) => {
        persistedGoal = goal ?? undefined;
        return persistedGoal;
      },
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
          }
          if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    try {
      // When
      input.write(
        "/goal Fix every failing checkout test and run the checkout suite\n",
      );
      input.write("/goal verify pnpm test\n");
      input.write("/status\n");
      input.write("continue with the next fix\n");
      input.end("/status\n");
      await session;

      // Then
      expect(persistedGoal).toEqual({
        objective: "Fix every failing checkout test and run the checkout suite",
        status: "active",
        budget: {},
        usage: { turns: 1, tokens: 0, activeTimeMs: expect.any(Number) },
        criterionKind: "command",
        completionCriterion: "pnpm test",
      });
      expect(stdout).toContain("Goal set: active\n");
      expect(stdout).toContain("Goal verification command set: pnpm test\n");
      expect(stdout).toContain(
        "Note: bash is disabled in this run, so the agent cannot run this verification command. Resume with --bash-policy ask or --bash-policy trusted, or use /goal complete after checking it manually.\n",
      );
      expect(stdout).toContain(
        "  goal: active - Fix every failing checkout test and run the checkout suite; criterion(command): pnpm test\n",
      );
      expect(stdout).toContain("Continuing goal.\n");
      expect(providerPrompts).toHaveLength(1);
      expect(providerPrompts[0]).toContain("Session goal:");
      expect(providerPrompts[0]).toContain(
        "Fix every failing checkout test and run the checkout suite",
      );
      expect(providerPrompts[0]).toContain(
        "Completion criterion (command): pnpm test",
      );
      expect(providerPrompts[0]).toContain(
        "Bash is disabled in this run, so you cannot run the command completion criterion yourself.",
      );
      expect(providerPrompts[0]).not.toContain(
        "Before proposing completion, run the command completion criterion with bash",
      );
      expect(providerMessages).toEqual([
        [{ role: "user", content: "continue with the next fix" }],
      ]);
      expect(stderr).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a saved interactive session has no goal,
    When the user enters one goal completion condition,
    Then Keel persists a complete assertion goal and starts work immediately`, async () => {
    // Given
    const condition = "Every checkout test passes and lint is clean";
    const input = new PassThrough();
    let stdout = "";
    let stderr = "";
    const persistedGoals: SessionGoal[] = [];
    const providerPrompts: string[] = [];
    const providerMessages: (readonly Message[])[] = [];
    const provider: LLMProvider = {
      id: "goal-activation-provider",
      async *stream(options) {
        providerPrompts.push(options.systemPrompt);
        providerMessages.push(structuredClone([...options.messages]));
        yield { type: "text", text: "Goal work started." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      sessionId: "goal-activation-session",
      goalAutomaticContinuationTurnLimit: 1,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      persistSessionGoal: ({ goal }) => {
        if (goal === null) return undefined;
        persistedGoals.push(goal);
        return goal;
      },
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });
    input.end(`/goal ${condition}\n`);

    // When
    await withTimeout(session, 5000, "goal activation did not start work");

    // Then
    expect(persistedGoals[0]).toEqual({
      objective: condition,
      status: "active",
      budget: {},
      usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
      criterionKind: "assertion",
      completionCriterion: condition,
    });
    expect(providerPrompts).toHaveLength(1);
    expect(providerPrompts[0]).toContain(`Objective: ${condition}`);
    expect(providerPrompts[0]).toContain(
      `Completion criterion (assertion): ${condition}`,
    );
    expect(providerMessages[0]?.at(-1)).toEqual({
      role: "user",
      content: expect.stringContaining('source="goal_activation"'),
    });
    expect(stdout).toContain("Goal set: active\n");
    expect(stdout).toContain("Goal work started.\n");
    expect(stderr).toContain(
      "Automatic goal continuation stopped after 1 continuation turns without completing the active goal.",
    );
  });

  test(`Given a new goal and real user input are already queued,
    When Keel reaches the goal activation boundary,
    Then the real user input drives the first provider turn instead of synthetic activation`, async () => {
    // Given
    const condition = "The checkout failure has been diagnosed";
    const steeringInput = "Inspect the checkout trace before changing code";
    const input = new PassThrough();
    let stderr = "";
    let persistedGoal: SessionGoal | undefined;
    const providerMessages: (readonly Message[])[] = [];
    const provider: LLMProvider = {
      id: "queued-goal-activation-provider",
      async *stream(options) {
        providerMessages.push(structuredClone([...options.messages]));
        yield { type: "text", text: "Inspecting the trace." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      sessionId: "queued-goal-activation-session",
      input,
      writeStdout: () => {},
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      persistSessionGoal: ({ goal }) => {
        persistedGoal = goal ?? undefined;
        return persistedGoal;
      },
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "end") finalEnd = event;
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });
    input.end(`/goal ${condition}\n/goal budget --turns 1\n${steeringInput}\n`);

    // When
    await withTimeout(session, 5000, "queued input did not drive the goal");

    // Then
    expect(providerMessages).toHaveLength(1);
    expect(providerMessages[0]?.at(-1)).toEqual({
      role: "user",
      content: steeringInput,
    });
    expect(
      providerMessages[0]?.some(
        (message) =>
          message.role === "user" &&
          message.content.includes('source="goal_activation"'),
      ),
    ).toBe(false);
    expect(persistedGoal).toMatchObject({
      objective: condition,
      status: "budget_limited",
      criterionKind: "assertion",
      completionCriterion: condition,
      budget: { turns: 1 },
      usage: { turns: 1 },
    });
    expect(stderr).toContain("Session goal budget reached: turns 1/1");
  });

  test(`Given goal activation is pending and a queued budget persistence update fails,
    When the input queue drains,
    Then Keel cancels activation before spending a provider call`, async () => {
    // Given
    const condition = "The checkout suite passes";
    const input = new PassThrough();
    let stderr = "";
    let providerCalls = 0;
    let persistenceCalls = 0;
    let persistedGoal: SessionGoal | undefined;
    const provider: LLMProvider = {
      id: "failed-pending-goal-budget-provider",
      async *stream() {
        providerCalls++;
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      sessionId: "failed-pending-goal-budget-session",
      goalAutomaticContinuationTurnLimit: 1,
      input,
      writeStdout: () => {},
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      persistSessionGoal: ({ goal }) => {
        persistenceCalls++;
        if (persistenceCalls === 2) {
          throw new Error("goal budget store unavailable");
        }
        persistedGoal = goal ?? undefined;
        return persistedGoal;
      },
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "end") finalEnd = event;
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });
    input.end(`/goal ${condition}\n/goal budget --turns 1\n`);

    // When
    await withTimeout(
      session,
      5000,
      "failed budget update left the session running",
    );

    // Then
    expect(persistenceCalls).toBe(2);
    expect(providerCalls).toBe(0);
    expect(persistedGoal).toMatchObject({
      objective: condition,
      status: "active",
      budget: {},
      criterionKind: "assertion",
      completionCriterion: condition,
    });
    expect(stderr).toBe("goal budget store unavailable\n");
  });

  test.each([
    {
      label: "goal configuration",
      invalidCommand: "/goal budget --turns nope",
      expectedProviderCalls: 0,
      expectedStatus: "active",
      expectedError: "Error: --turns must be a positive integer.",
    },
    {
      label: "unrelated local command",
      invalidCommand: "/status unexpected",
      expectedProviderCalls: 1,
      expectedStatus: "usage_limited",
      expectedError: "Error: /status does not accept arguments.",
    },
  ] as const)(`Given goal activation is pending and a queued $label is invalid,
    When the input queue drains,
    Then Keel only cancels activation for invalid goal configuration`, async ({
    invalidCommand,
    expectedProviderCalls,
    expectedStatus,
    expectedError,
  }) => {
    // Given
    const condition = "The checkout suite passes within its budget";
    const input = new PassThrough();
    let stderr = "";
    let providerCalls = 0;
    let persistedGoal: SessionGoal | undefined;
    const provider: LLMProvider = {
      id: "invalid-pending-local-command-provider",
      async *stream() {
        providerCalls++;
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      sessionId: "invalid-pending-goal-budget-session",
      goalAutomaticContinuationTurnLimit: 1,
      input,
      writeStdout: () => {},
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      persistSessionGoal: ({ goal }) => {
        persistedGoal = goal ?? undefined;
        return persistedGoal;
      },
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "end") finalEnd = event;
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });
    input.end(`/goal ${condition}\n${invalidCommand}\n`);

    // When
    await withTimeout(
      session,
      5000,
      "invalid local command left goal activation running",
    );

    // Then
    expect(providerCalls).toBe(expectedProviderCalls);
    expect(persistedGoal).toMatchObject({
      objective: condition,
      status: expectedStatus,
      budget: {},
      criterionKind: "assertion",
      completionCriterion: condition,
    });
    expect(stderr).toContain(`${expectedError}\n`);
  });

  test(`Given a saved interactive session has an active goal,
    When the user pauses and resumes it,
    Then Keel keeps the paused goal visible without injecting it as active work`, async () => {
    // Given
    const input = new PassThrough();
    let stdout = "";
    let stderr = "";
    let persistedGoal: SessionGoal | undefined = {
      objective: "Finish lifecycle states",
      status: "active",
      budget: {},
      usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
      criterionKind: "command",
      completionCriterion: "pnpm test",
    };
    const providerPrompts: string[] = [];
    const providerMessages: (readonly Message[])[] = [];
    const provider: LLMProvider = {
      id: "goal-pause-provider",
      async *stream(options) {
        providerPrompts.push(options.systemPrompt);
        providerMessages.push(structuredClone([...options.messages]));
        yield {
          type: "text",
          text: providerPrompts.length === 1 ? "Paused turn." : "Resumed turn.",
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      sessionId: "goal-pause-session",
      initialSessionGoal: persistedGoal,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      persistSessionGoal: ({ goal }) => {
        persistedGoal = goal ?? undefined;
        return persistedGoal;
      },
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
          }
          if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    // When
    input.write("/goal pause\n");
    input.write("/status\n");
    input.write("handle a side request while paused\n");
    input.write("/goal resume\n");
    input.write("/status\n");
    input.write("continue the durable goal\n");
    input.end("/status\n");
    await session;

    // Then
    expect(persistedGoal).toEqual({
      objective: "Finish lifecycle states",
      status: "active",
      budget: {},
      usage: { turns: 1, tokens: 0, activeTimeMs: expect.any(Number) },
      criterionKind: "command",
      completionCriterion: "pnpm test",
    });
    expect(stdout).toContain("Goal paused: Finish lifecycle states\n");
    expect(stdout).toContain(
      "  goal: paused - Finish lifecycle states; criterion(command): pnpm test\n",
    );
    expect(stdout).toContain("Paused turn.\n");
    expect(stdout).toContain("Goal resumed: Finish lifecycle states\n");
    expect(stdout).toContain(
      "  goal: active - Finish lifecycle states; criterion(command): pnpm test\n",
    );
    expect(stdout).toContain("Resumed turn.\n");
    expect(providerPrompts).toHaveLength(2);
    expect(providerPrompts[0]).not.toContain("Session goal:");
    expect(providerPrompts[1]).toContain("Session goal:");
    expect(providerPrompts[1]).toContain("Finish lifecycle states");
    expect(providerMessages).toEqual([
      [{ role: "user", content: "handle a side request while paused" }],
      [
        { role: "user", content: "handle a side request while paused" },
        { role: "assistant", content: "Paused turn.", toolCalls: [] },
        { role: "user", content: "continue the durable goal" },
      ],
    ]);
    expect(stderr).toBe("");
  });

  test(`Given a saved interactive session has non-active lifecycle goals,
    When the user pauses or resumes invalid states,
    Then Keel enforces the user-owned lifecycle boundaries`, async () => {
    // Given
    const input = new PassThrough();
    let stdout = "";
    let stderr = "";
    let persistedGoal: SessionGoal | undefined = {
      objective: "Finish lifecycle guard coverage",
      status: "completed",
      budget: {},
      usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
      completionEvidence: { kind: "user_override" },
    };
    const provider = unusedProvider("unused-goal-lifecycle-guards-provider");
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      sessionId: "goal-lifecycle-guards-session",
      initialSessionGoal: persistedGoal,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      persistSessionGoal: ({ goal }) => {
        persistedGoal = goal ?? undefined;
        return persistedGoal;
      },
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => undefined,
      formatCostReport: () => "",
    });

    // When
    input.write("/goal pause\n");
    input.write("/goal resume\n");
    input.write("/goal Blocked objective\n");
    input.write("/goal pause\n");
    input.write("/goal resume\n");
    input.write("/goal Blocked objective\n");
    input.write("/goal pause\n");
    input.write("/goal resume\n");
    input.write("/goal pause\n");
    input.end("/goal\n");
    await session;

    // Then
    expect(persistedGoal).toEqual({
      objective: "Blocked objective",
      status: "paused",
      budget: {},
      usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
      criterionKind: "assertion",
      completionCriterion: "Blocked objective",
    });
    expect(stderr).toBe(
      "Error: only active session goals can be paused.\n" +
        "Error: only paused, blocked, or limited session goals can be resumed.\n",
    );
    expect(stdout).toContain("Goal paused: Blocked objective\n");
    expect(stdout).toContain("Goal resumed: Blocked objective\n");
    expect(stdout).toContain(
      "Session goal: paused - Blocked objective; criterion(assertion): Blocked objective\n",
    );
  });

  const resumableGoalCases: ReadonlyArray<{
    readonly label: string;
    readonly initialGoal: SessionGoal;
  }> = [
    {
      label: "blocked",
      initialGoal: {
        objective: "Continue blocked goal",
        status: "blocked",
        budget: {},
        usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
        statusReason: "Need credentials.",
        criterionKind: "command",
        completionCriterion: "pnpm test",
      },
    },
    {
      label: "usage-limited",
      initialGoal: {
        objective: "Continue usage-limited goal",
        status: "usage_limited",
        budget: {},
        usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
        statusReason: "Automatic continuation stopped.",
        criterionKind: "command",
        completionCriterion: "pnpm test",
      },
    },
    {
      label: "budget-limited",
      initialGoal: {
        objective: "Continue budget-limited goal",
        status: "budget_limited",
        budget: {},
        usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
        statusReason: "Session budget stopped continuation.",
        criterionKind: "command",
        completionCriterion: "pnpm test",
      },
    },
  ];

  test.each(
    resumableGoalCases,
  )(`Given a saved interactive session has a $label goal,
    When the user resumes it,
    Then Keel clears the status reason and starts resumed work immediately`, async ({
    initialGoal,
  }) => {
    // Given
    const input = new PassThrough();
    let stdout = "";
    let stderr = "";
    let persistedGoal: SessionGoal | undefined = initialGoal;
    const providerMessages: (readonly Message[])[] = [];
    const provider: LLMProvider = {
      id: "goal-resume-provider",
      async *stream(options) {
        providerMessages.push(structuredClone([...options.messages]));
        yield { type: "text", text: "Resumed goal work." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      sessionId: "goal-resume-session",
      goalAutomaticContinuationTurnLimit: 1,
      initialSessionGoal: persistedGoal,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      persistSessionGoal: ({ goal }) => {
        persistedGoal = goal ?? undefined;
        return persistedGoal;
      },
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "end") finalEnd = event;
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    // When
    input.end("/goal resume\n");
    await session;

    // Then
    expect(persistedGoal).toEqual({
      objective: initialGoal.objective,
      status: "usage_limited",
      statusReason:
        "Automatic goal continuation stopped after 1 continuation turns without completing the active goal.",
      budget: {},
      usage: { turns: 1, tokens: 0, activeTimeMs: expect.any(Number) },
      criterionKind: "command",
      completionCriterion: "pnpm test",
    });
    expect(stdout).toContain(`Goal resumed: ${initialGoal.objective}\n`);
    expect(providerMessages).toHaveLength(1);
    expect(providerMessages[0]?.at(-1)).toEqual({
      role: "user",
      content: expect.stringContaining('source="goal_resumption"'),
    });
    expect(stderr).toContain(
      "Automatic goal continuation stopped after 1 continuation turns without completing the active goal.",
    );
  });

  test(`Given a paused goal has no completion criterion,
    When the user resumes it,
    Then Keel rejects activation before persistence or provider spend`, async () => {
    // Given
    const input = new PassThrough();
    let stderr = "";
    let persistenceCalls = 0;
    const initialGoal: SessionGoal = {
      objective: "Incomplete goal",
      status: "paused",
      budget: {},
      usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
    };
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      sessionId: "incomplete-goal-resume-session",
      initialSessionGoal: initialGoal,
      input,
      writeStdout: () => {},
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      persistSessionGoal: ({ goal }) => {
        persistenceCalls++;
        return goal ?? undefined;
      },
      resolveProvider: () => ({
        provider: unusedProvider("incomplete-goal-resume-provider"),
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => undefined,
      formatCostReport: () => "",
    });
    input.end("/goal resume\n");

    // When
    await session;

    // Then
    expect(persistenceCalls).toBe(0);
    expect(stderr).toBe(
      "Error: the session goal has no completion criterion. Set a new goal before resuming.\n",
    );
  });

  test(`Given a saved interactive session has an active goal,
    When the user sets an assertion completion criterion,
    Then Keel shows the criterion without contacting the provider`, async () => {
    // Given
    const input = new PassThrough();
    let stdout = "";
    let stderr = "";
    let persistedGoal: SessionGoal | undefined = {
      objective: "Publish release notes",
      status: "active",
      budget: {},
      usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
    };
    const provider = unusedProvider("unused-assertion-criterion-provider");
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      sessionId: "goal-assertion-criterion-session",
      initialSessionGoal: persistedGoal,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      persistSessionGoal: ({ goal }) => {
        persistedGoal = goal ?? undefined;
        return persistedGoal;
      },
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => undefined,
      formatCostReport: () => "",
    });

    // When
    input.write("/goal done-when release notes cover every changed command\n");
    input.end("/status\n");
    await session;

    // Then
    expect(persistedGoal).toEqual({
      objective: "Publish release notes",
      status: "active",
      budget: {},
      usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
      criterionKind: "assertion",
      completionCriterion: "release notes cover every changed command",
    });
    expect(stdout).toContain(
      "Goal assertion criterion set: release notes cover every changed command\n",
    );
    expect(stdout).toContain(
      "  goal: active - Publish release notes; criterion(assertion): release notes cover every changed command\n",
    );
    expect(stderr).toBe("");
  });

  test(`Given a saved interactive session has an active goal,
    When the user mistypes a goal criterion subcommand,
    Then Keel reports the unknown subcommand and keeps the goal unchanged`, async () => {
    // Given
    const input = new PassThrough();
    let stdout = "";
    let stderr = "";
    let persistedGoal: SessionGoal | undefined = {
      objective: "Original",
      status: "active",
      budget: {},
      usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
    };
    const provider = unusedProvider("unused-goal-subcommand-typo-provider");
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      sessionId: "goal-subcommand-typo-session",
      initialSessionGoal: persistedGoal,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      persistSessionGoal: ({ goal }) => {
        persistedGoal = goal ?? undefined;
        return persistedGoal;
      },
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        for await (const _event of stream) {
          throw new Error(
            "Provider should not be called for local goal commands",
          );
        }
        return undefined;
      },
      formatCostReport: () => "",
    });

    // When
    input.write("/goal done-whenX loads fast\n");
    input.write("/goal verifyX pnpm test\n");
    input.end("/status\n");
    await session;

    // Then
    expect(persistedGoal).toEqual({
      objective: "Original",
      status: "active",
      budget: {},
      usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
    });
    expect(stdout).toContain("  goal: active - Original; criterion: missing\n");
    expect(stderr).toBe(
      'Error: unknown /goal subcommand "done-whenX". Did you mean /goal done-when <criterion>?\n' +
        'Error: unknown /goal subcommand "verifyX". Did you mean /goal verify <command>?\n',
    );
  });

  test(`Given bash is enabled for a saved interactive session with an active goal,
    When the user sets a goal verification command,
    Then Keel preserves the command criterion text without warning that automatic verification is unavailable`, async () => {
    // Given
    const input = new PassThrough();
    let stdout = "";
    let stderr = "";
    let persistedGoal: SessionGoal | undefined = {
      objective: "Ship the checkout fix",
      status: "active",
      budget: {},
      usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
    };
    const provider = unusedProvider("unused-enabled-goal-provider");
    const session = runInteractiveSession({
      cliArgs: { bashMode: "trusted" },
      workspace: process.cwd(),
      platform: process.platform,
      sessionId: "goal-enabled-bash-session",
      initialSessionGoal: persistedGoal,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      persistSessionGoal: ({ goal }) => {
        persistedGoal = goal ?? undefined;
        return persistedGoal;
      },
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => undefined,
      formatCostReport: () => "",
    });

    // When
    input.write('/goal verify node  -e "process.exit(0)"\n');
    input.end("/status\n");
    await session;

    // Then
    expect(persistedGoal).toEqual({
      objective: "Ship the checkout fix",
      status: "active",
      budget: {},
      usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
      criterionKind: "command",
      completionCriterion: 'node  -e "process.exit(0)"',
    });
    expect(stdout).toContain(
      'Goal verification command set: node  -e "process.exit(0)"\n',
    );
    expect(stdout).toContain(
      '  goal: active - Ship the checkout fix; criterion(command): node  -e "process.exit(0)"\n',
    );
    expect(stderr).toBe("");
  });

  test(`Given a saved interactive session has a goal,
    When the user shows and clears it,
    Then Keel updates the local goal state without contacting the provider`, async () => {
    // Given
    const input = new PassThrough();
    let stdout = "";
    let persistedGoal: SessionGoal | undefined = {
      objective: "Refine status output",
      status: "active",
      budget: {},
      usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
    };
    const provider = unusedProvider("unused-goal-provider");
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      sessionId: "goal-clear-session",
      initialSessionGoal: persistedGoal,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stdout += text;
      },
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      persistSessionGoal: ({ goal }) => {
        persistedGoal = goal ?? undefined;
        return persistedGoal;
      },
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => undefined,
      formatCostReport: () => "",
    });

    // When
    input.write("/goal\n");
    input.write("/goal clear\n");
    input.end("/goal\n");
    await session;

    // Then
    expect(persistedGoal).toBeUndefined();
    expect(stdout).toContain(
      "Session goal: active - Refine status output; criterion: missing\n",
    );
    expect(stdout).toContain("Goal cleared.\n");
    expect(stdout).toContain("Session goal: none\n");
  });

  test(`Given goal commands run without saved-session persistence,
    When the user tries to change the goal,
    Then Keel reports that the commands require a saved session`, async () => {
    // Given
    const input = new PassThrough();
    let stderr = "";
    const provider = unusedProvider("unused-ephemeral-goal-provider");
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: () => {},
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => undefined,
      formatCostReport: () => "",
    });

    // When
    input.write("/goal Fix checkout tests\n");
    input.write("/goal verify pnpm test\n");
    input.write("/goal pause\n");
    input.write("/goal resume\n");
    input.write("/goal complete\n");
    input.write("/goal done-when release notes cover every command\n");
    input.end("/goal clear\n");
    await session;

    // Then
    expect(stderr).toBe(
      "Error: /goal requires a saved session. Start without --ephemeral, or use --session or --resume.\n".repeat(
        7,
      ),
    );
  });

  test(`Given no goal is set in a saved session,
    When the user tries to complete or set a completion criterion,
    Then Keel reports that no goal exists`, async () => {
    // Given
    const input = new PassThrough();
    let stderr = "";
    const provider = unusedProvider("unused-empty-goal-provider");
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      sessionId: "no-goal-session",
      input,
      writeStdout: () => {},
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      persistSessionGoal: () => undefined,
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => undefined,
      formatCostReport: () => "",
    });

    // When
    input.write("/goal complete\n");
    input.write("/goal pause\n");
    input.write("/goal resume\n");
    input.write("/goal verify pnpm test\n");
    input.end("/goal done-when release notes cover every command\n");
    await session;

    // Then
    expect(stderr).toBe("Error: no session goal is set.\n".repeat(5));
  });

  test(`Given goal persistence fails,
    When the user sets, pauses, completes, or clears a goal,
    Then Keel reports the local command failure`, async () => {
    // Given
    const input = new PassThrough();
    let stderr = "";
    const provider = unusedProvider("unused-failing-goal-provider");
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      sessionId: "failing-goal-session",
      initialSessionGoal: {
        objective: "Persist every goal state",
        status: "active",
        budget: {},
        usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
      },
      input,
      writeStdout: () => {},
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      persistSessionGoal: () => {
        throw new Error("goal store unavailable");
      },
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => undefined,
      formatCostReport: () => "",
    });

    // When
    input.write("/goal Replace the goal\n");
    input.write("/goal verify pnpm test\n");
    input.write("/goal pause\n");
    input.write("/goal complete\n");
    input.write("/goal done-when release notes cover every command\n");
    input.end("/goal clear\n");
    await session;

    // Then
    expect(stderr).toBe("goal store unavailable\n".repeat(6));
  });

  test(`Given goal resume persistence fails,
    When the user resumes a paused goal,
    Then Keel reports the local command failure`, async () => {
    // Given
    const input = new PassThrough();
    let stderr = "";
    const provider = unusedProvider("unused-failing-goal-resume-provider");
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      sessionId: "failing-goal-resume-session",
      initialSessionGoal: {
        objective: "Resume persistence failure",
        status: "paused",
        budget: {},
        usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
        criterionKind: "assertion",
        completionCriterion: "Resume persistence succeeds",
      },
      input,
      writeStdout: () => {},
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      persistSessionGoal: () => {
        throw new Error("goal resume store unavailable");
      },
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => undefined,
      formatCostReport: () => "",
    });

    // When
    input.end("/goal resume\n");
    await session;

    // Then
    expect(stderr).toBe("goal resume store unavailable\n");
  });

  test(`Given an active goal is completed,
    When the user sends another prompt,
    Then Keel shows the completed goal without injecting it into the provider request`, async () => {
    // Given
    const input = new PassThrough();
    let stdout = "";
    let stderr = "";
    let persistedGoal: SessionGoal | undefined = {
      objective: "Ship the release notes",
      status: "active",
      budget: {},
      usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
      criterionKind: "command",
      completionCriterion: "pnpm test",
    };
    const providerPrompts: string[] = [];
    const provider: LLMProvider = {
      id: "goal-complete-provider",
      async *stream(options) {
        providerPrompts.push(options.systemPrompt);
        yield { type: "text", text: "Normal prompt." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      sessionId: "completed-goal-session",
      initialSessionGoal: persistedGoal,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      persistSessionGoal: ({ goal }) => {
        persistedGoal = goal ?? undefined;
        return persistedGoal;
      },
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
          }
          if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    // When
    input.write("/goal complete\n");
    input.write("/goal verify pnpm lint\n");
    input.write("/goal done-when release notes cover every command\n");
    input.write("/status\n");
    input.end("answer a normal follow-up\n");
    await session;

    // Then
    expect(persistedGoal).toEqual({
      objective: "Ship the release notes",
      status: "completed",
      budget: {},
      usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
      criterionKind: "command",
      completionCriterion: "pnpm test",
      completionEvidence: { kind: "user_override" },
    });
    expect(stdout).toContain("Goal completed: Ship the release notes\n");
    expect(stdout).toContain(
      "  goal: completed - Ship the release notes; criterion(command): pnpm test\n",
    );
    expect(stdout).toContain(
      "  goal evidence: user explicitly completed the goal with /goal complete\n",
    );
    expect(stderr).toBe(
      "Error: only active session goals can change the completion criterion. Resume the goal or set a new goal first.\n".repeat(
        2,
      ),
    );
    expect(providerPrompts).toHaveLength(1);
    expect(providerPrompts[0]).not.toContain("Session goal:");
  });

  test(`Given a saved interactive session has an active goal,
    When the model marks the goal completed during a turn and the user checks status,
    Then Keel persists and displays the completed goal`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-goal-tool-"));
    let turnEnded: () => void = () => {};
    const turnDone = new Promise<void>((resolve) => {
      turnEnded = resolve;
    });
    const input = new PassThrough();
    let stdout = "";
    let stderr = "";
    let persistedGoal: SessionGoal | undefined = {
      objective: "Finish the checkout goal",
      status: "active",
      budget: {},
      usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
      criterionKind: "command",
      completionCriterion: 'node -e "process.exit(0)"',
    };
    let providerRequestCount = 0;
    const provider: LLMProvider = {
      id: "goal-tool-provider",
      async *stream() {
        providerRequestCount++;
        if (providerRequestCount === 1) {
          yield {
            type: "tool_call",
            id: "verify_1",
            tool: "bash",
            command: 'node -e "process.exit(0)"',
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        if (providerRequestCount === 2) {
          yield {
            type: "tool_call",
            id: "goal_1",
            tool: "update_goal",
            status: "completed",
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        yield { type: "text", text: "Goal finished." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const session = runInteractiveSession({
      cliArgs: { bashMode: "trusted" },
      workspace,
      platform: process.platform,
      sessionId: "goal-tool-session",
      initialSessionGoal: persistedGoal,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      persistSessionGoal: ({ goal }) => {
        persistedGoal = goal ?? undefined;
        return persistedGoal;
      },
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
          }
          if (event.type === "end") {
            finalEnd = event;
            turnEnded();
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    try {
      // When
      input.write("finish the saved goal\n");
      await withTimeout(turnDone, 5000, "goal turn did not finish");
      input.end("/status\n");
      await session;

      // Then
      expect(persistedGoal).toEqual({
        objective: "Finish the checkout goal",
        status: "completed",
        budget: {},
        usage: { turns: 1, tokens: 0, activeTimeMs: expect.any(Number) },
        criterionKind: "command",
        completionCriterion: 'node -e "process.exit(0)"',
        completionEvidence: {
          kind: "command",
          command: 'node -e "process.exit(0)"',
          cwd: workspace,
          exitCode: 0,
          freshness: "after_latest_workspace_mutation",
        },
      });
      expect(stdout).toContain("Goal finished.\n");
      expect(stdout).toContain(
        '  goal: completed - Finish the checkout goal; criterion(command): node -e "process.exit(0)"\n',
      );
      expect(stdout).toContain(
        `  goal evidence: node -e "process.exit(0)" exited 0 after the latest workspace mutation in ${workspace}`,
      );
      expect(stderr).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given assertion completion evidence expands during redaction,
    When the model completes the goal during an interactive turn,
    Then Keel persists the completed goal and keeps the session alive`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-session-goal-assertion-redaction-"),
    );
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const store = createSessionStore({
      sessionId: "goal-assertion-redaction-session",
      workspace,
      runtime: runtime(home),
    });
    let timestamp = 1;
    let turnEnded: () => void = () => {};
    const turnDone = new Promise<void>((resolve) => {
      turnEnded = resolve;
    });
    const input = new PassThrough();
    let stdout = "";
    let stderr = "";
    const initialGoal: SessionGoal = {
      objective: "Publish the release notes",
      status: "active",
      budget: {},
      usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
      criterionKind: "assertion",
      completionCriterion: "release notes explain every changed command",
    };
    const persistedGoals: SessionGoal[] = [];
    const expandingReason = redactionExpandingText(
      SESSION_GOAL_COMPLETION_EVIDENCE_REASON_MAX_LENGTH,
    );
    let providerRequestCount = 0;
    const provider: LLMProvider = {
      id: "goal-assertion-redaction-provider",
      async *stream(options) {
        if (options.toolChoice === "none") {
          yield {
            type: "text",
            text: JSON.stringify({
              completed: true,
              reason: expandingReason,
            }),
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        providerRequestCount++;
        if (providerRequestCount === 1) {
          yield {
            type: "tool_call",
            id: "goal_1",
            tool: "update_goal",
            status: "completed",
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        yield { type: "text", text: "Goal finished after evaluation." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace,
      platform: process.platform,
      sessionId: "goal-assertion-redaction-session",
      initialSessionGoal: initialGoal,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      persistSessionGoal: ({ goal, consumedInputIds }) => {
        const persistedGoal = persistSessionGoal({
          session: store,
          goal,
          runtime: runtime(home, timestamp++),
          ...(consumedInputIds !== undefined ? { consumedInputIds } : {}),
        });
        if (persistedGoal !== undefined) {
          persistedGoals.push(persistedGoal);
        }
        return persistedGoal;
      },
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
          }
          if (event.type === "end") {
            finalEnd = event;
            turnEnded();
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    try {
      // When
      input.write("finish the saved assertion goal\n");
      await withTimeout(turnDone, 5000, "goal turn did not finish");
      input.end("/status\n");
      await session;

      // Then
      const persistedGoal = persistedGoals.at(-1);
      if (persistedGoal?.status !== "completed") {
        throw new Error("expected completed goal");
      }
      expect(persistedGoal.completionEvidence.kind).toBe("assertion_evaluator");
      if (persistedGoal.completionEvidence.kind !== "assertion_evaluator") {
        throw new Error("expected assertion evaluator evidence");
      }
      expect(
        persistedGoal.completionEvidence.reason.length,
      ).toBeLessThanOrEqual(SESSION_GOAL_COMPLETION_EVIDENCE_REASON_MAX_LENGTH);
      expect(persistedGoal.completionEvidence.reason).toContain(
        "[REDACTED_SECRET]",
      );
      expect(persistedGoal.completionEvidence.reason).not.toContain("sk-aaaa");
      expect(stdout).toContain("Goal finished after evaluation.\n");
      expect(stdout).toContain(
        "  goal: completed - Publish the release notes; criterion(assertion): release notes explain every changed command\n",
      );
      expect(stdout).toContain("  goal evidence: evaluator approved: ");
      expect(stderr).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given the model completes a goal during a turn,
    When the turn is interrupted before persistence,
    Then Keel restores the active goal and does not save completion`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-goal-abort-"));
    let cancelTextSeen: () => void = () => {};
    const cancelTextReceived = new Promise<void>((resolve) => {
      cancelTextSeen = resolve;
    });
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    const persistedGoalUpdates: SessionGoal[] = [];
    const initialGoal: SessionGoal = {
      objective: "Finish the interrupted goal",
      status: "active",
      budget: {},
      usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
      criterionKind: "command",
      completionCriterion: 'node -e "process.exit(0)"',
    };
    let providerRequestCount = 0;
    const provider: LLMProvider = {
      id: "goal-abort-provider",
      async *stream(options) {
        providerRequestCount++;
        if (providerRequestCount === 1) {
          yield {
            type: "tool_call",
            id: "verify_1",
            tool: "bash",
            command: 'node -e "process.exit(0)"',
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        if (providerRequestCount === 2) {
          yield {
            type: "tool_call",
            id: "goal_1",
            tool: "update_goal",
            status: "completed",
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        yield { type: "text", text: "Cancel after goal" };
        if (!options.signal.aborted) {
          await new Promise<void>((resolve) => {
            options.signal.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
        }
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const session = runInteractiveSession({
      cliArgs: { bashMode: "trusted" },
      workspace,
      platform: process.platform,
      sessionId: "goal-abort-session",
      initialSessionGoal: initialGoal,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: (handler) => {
        sigintHandlers.add(handler);
      },
      offSigint: (handler) => {
        sigintHandlers.delete(handler);
      },
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      persistSessionGoal: ({ goal }) => {
        if (goal !== null) {
          persistedGoalUpdates.push(goal);
        }
        return goal ?? undefined;
      },
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
            if (event.text === "Cancel after goal") {
              cancelTextSeen();
              for (const handler of [...sigintHandlers]) {
                handler();
              }
              input.end("/status\n");
            }
          }
          if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    try {
      // When
      input.write("finish then interrupt\n");
      await withTimeout(
        cancelTextReceived,
        5000,
        "goal abort turn did not start",
      );
      await withTimeout(session, 5000, "goal abort session did not finish");

      // Then
      expect(persistedGoalUpdates).toEqual([]);
      expect(stdout).toContain("Cancel after goal");
      expect(stdout).toContain(
        '  goal: active - Finish the interrupted goal; criterion(command): node -e "process.exit(0)"\n',
      );
      expect(stderr).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an active goal turn throws after interruption,
    When the user checks status after the abort,
    Then Keel restores the pre-turn goal before continuing`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-session-goal-throw-abort-"),
    );
    let cancelTextSeen: () => void = () => {};
    const cancelTextReceived = new Promise<void>((resolve) => {
      cancelTextSeen = resolve;
    });
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    const provider: LLMProvider = {
      id: "goal-throw-abort-provider",
      async *stream(options) {
        yield { type: "text", text: "Throw after abort" };
        if (!options.signal.aborted) {
          await new Promise<void>((resolve) => {
            options.signal.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
        }
        throw new Error("stream failed after abort");
      },
    };
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace,
      platform: process.platform,
      sessionId: "goal-throw-abort-session",
      initialSessionGoal: {
        objective: "Keep the goal after abort errors",
        status: "active",
        budget: {},
        usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
      },
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: (handler) => {
        sigintHandlers.add(handler);
      },
      offSigint: (handler) => {
        sigintHandlers.delete(handler);
      },
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      persistSessionGoal: () => {
        throw new Error("interrupted turn should not persist a goal");
      },
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
            if (event.text === "Throw after abort") {
              cancelTextSeen();
              for (const handler of [...sigintHandlers]) {
                handler();
              }
              input.end("/status\n");
            }
          }
          if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    try {
      // When
      input.write("throw after interrupt\n");
      await withTimeout(
        cancelTextReceived,
        5000,
        "goal throw-abort turn did not start",
      );
      await withTimeout(
        session,
        5000,
        "goal throw-abort session did not finish",
      );

      // Then
      expect(stdout).toContain("Throw after abort");
      expect(stdout).toContain(
        "  goal: active - Keep the goal after abort errors; criterion: missing\n",
      );
      expect(stderr).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
