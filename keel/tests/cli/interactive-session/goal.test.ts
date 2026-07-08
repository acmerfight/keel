import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../../src/agent/events.ts";
import { parseInteractiveCommand } from "../../../src/cli/interactive-session/commands.ts";
import { runInteractiveSession } from "../../../src/cli/interactive-session.ts";
import type { SessionGoal } from "../../../src/core/session-goal.ts";
import type { LLMProvider, Message } from "../../../src/llm/types.ts";
import {
  ForcedExit,
  withTimeout,
  ZERO_COST_MODEL,
  ZERO_USAGE,
} from "../../../src/testing/interactive-session-fixtures.ts";

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

describe("Interactive Session - Goals", () => {
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
    });
    expect(parseInteractiveCommand("/goal done-when")).toEqual({
      kind: "invalid",
      message: "Error: /goal done-when requires a completion criterion.",
    });
    expect(parseInteractiveCommand("/goal clear")).toEqual({
      kind: "goal",
      action: "clear",
    });
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
      input.end("continue with the next fix\n");
      await session;

      // Then
      expect(persistedGoal).toEqual({
        objective: "Fix every failing checkout test and run the checkout suite",
        status: "active",
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
    input.write("/goal complete\n");
    input.write("/goal done-when release notes cover every command\n");
    input.end("/goal clear\n");
    await session;

    // Then
    expect(stderr).toBe(
      "Error: /goal requires a saved session. Start without --ephemeral, or use --session or --resume.\n".repeat(
        5,
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
    input.write("/goal verify pnpm test\n");
    input.end("/goal done-when release notes cover every command\n");
    await session;

    // Then
    expect(stderr).toBe("Error: no session goal is set.\n".repeat(3));
  });

  test(`Given goal persistence fails,
    When the user sets, completes, or clears a goal,
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
    input.write("/goal complete\n");
    input.write("/goal done-when release notes cover every command\n");
    input.end("/goal clear\n");
    await session;

    // Then
    expect(stderr).toBe("goal store unavailable\n".repeat(5));
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
      criterionKind: "command",
      completionCriterion: "pnpm test",
    });
    expect(stdout).toContain("Goal completed: Ship the release notes\n");
    expect(stdout).toContain(
      "  goal: completed - Ship the release notes; criterion(command): pnpm test\n",
    );
    expect(stderr).toBe(
      "Error: completed session goal cannot change the completion criterion. Set a new goal instead.\n".repeat(
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
        criterionKind: "command",
        completionCriterion: 'node -e "process.exit(0)"',
      });
      expect(stdout).toContain("Goal finished.\n");
      expect(stdout).toContain(
        '  goal: completed - Finish the checkout goal; criterion(command): node -e "process.exit(0)"\n',
      );
      expect(stderr).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
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
