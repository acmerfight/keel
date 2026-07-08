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
      input.write("/status\n");
      input.end("continue with the next fix\n");
      await session;

      // Then
      expect(persistedGoal).toEqual({
        objective: "Fix every failing checkout test and run the checkout suite",
        status: "active",
      });
      expect(stdout).toContain("Goal set: active\n");
      expect(stdout).toContain(
        "  goal: active - Fix every failing checkout test and run the checkout suite\n",
      );
      expect(stdout).toContain("Continuing goal.\n");
      expect(providerPrompts).toHaveLength(1);
      expect(providerPrompts[0]).toContain("Session goal:");
      expect(providerPrompts[0]).toContain(
        "Fix every failing checkout test and run the checkout suite",
      );
      expect(providerMessages).toEqual([
        [{ role: "user", content: "continue with the next fix" }],
      ]);
      expect(stderr).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
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
    expect(stdout).toContain("Session goal: active - Refine status output\n");
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
    input.write("/goal complete\n");
    input.end("/goal clear\n");
    await session;

    // Then
    expect(stderr).toBe(
      "Error: /goal requires a saved session. Start without --ephemeral, or use --session or --resume.\n".repeat(
        3,
      ),
    );
  });

  test(`Given no goal is set in a saved session,
    When the user tries to complete it,
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
    input.end("/goal complete\n");
    await session;

    // Then
    expect(stderr).toBe("Error: no session goal is set.\n");
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
    input.write("/goal complete\n");
    input.end("/goal clear\n");
    await session;

    // Then
    expect(stderr).toBe("goal store unavailable\n".repeat(3));
  });

  test(`Given an active goal is completed,
    When the user sends another prompt,
    Then Keel shows the completed goal without injecting it into the provider request`, async () => {
    // Given
    const input = new PassThrough();
    let stdout = "";
    let persistedGoal: SessionGoal | undefined = {
      objective: "Ship the release notes",
      status: "active",
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
      writeStderr: () => {},
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
    input.write("/status\n");
    input.end("answer a normal follow-up\n");
    await session;

    // Then
    expect(persistedGoal).toEqual({
      objective: "Ship the release notes",
      status: "completed",
    });
    expect(stdout).toContain("Goal completed: Ship the release notes\n");
    expect(stdout).toContain("  goal: completed - Ship the release notes\n");
    expect(providerPrompts).toHaveLength(1);
    expect(providerPrompts[0]).not.toContain("Session goal:");
  });
});
