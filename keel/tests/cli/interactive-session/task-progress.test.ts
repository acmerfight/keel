import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../../src/agent/events.ts";
import { parseInteractiveCommand } from "../../../src/cli/interactive-session/commands.ts";
import {
  createSessionStore,
  forkSessionStore,
  persistSessionMessages,
  persistSessionTaskProgress,
  resumeSessionStore,
} from "../../../src/cli/session-store.ts";
import type { LLMProvider, Message } from "../../../src/llm/types.ts";
import {
  EPHEMERAL_INTERACTIVE_SESSION,
  ForcedExit,
  runInteractiveSessionWithoutMemory as runInteractiveSession,
  savedInteractiveSession,
  withTimeout,
  ZERO_COST_MODEL,
  ZERO_USAGE,
} from "../../../src/testing/interactive-session-fixtures.ts";
import {
  restoredUserMessageId,
  runtime,
} from "../../../src/testing/session-store-fixtures.ts";

describe("Interactive Session - Task Progress", () => {
  test(`Given the tasks command receives extra arguments,
    When the interactive command is parsed,
    Then Keel rejects the command without treating it as a prompt`, () => {
    expect(parseInteractiveCommand("/tasks now")).toEqual({
      kind: "invalid",
      message: "Error: /tasks does not accept arguments.",
    });
  });

  test(`Given an interactive agent turn updates task progress,
    When the user asks for tasks and status,
    Then Keel prints the current task progress without starting another model turn`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-tasks-"));
    let firstTurnEnded: () => void = () => {};
    const firstTurnDone = new Promise<void>((resolve) => {
      firstTurnEnded = resolve;
    });
    const providerRequests: (readonly Message[])[] = [];
    const provider: LLMProvider = {
      id: "task-progress-provider",
      async *stream(options) {
        providerRequests.push(structuredClone([...options.messages]));
        if (providerRequests.length === 1) {
          yield {
            type: "tool_call",
            id: "plan_1",
            tool: "update_plan",
            plan: [
              { step: "Inspect the failure", status: "in_progress" },
              { step: "Patch the bug", status: "pending" },
            ],
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        yield { type: "text", text: "Started." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    let stdout = "";
    let stderr = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace,
      platform: process.platform,
      session: EPHEMERAL_INTERACTIVE_SESSION,
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
            firstTurnEnded();
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    try {
      // When
      input.write("start work\n");
      await withTimeout(firstTurnDone, 5000, "first turn did not finish");
      input.write("/tasks\n");
      input.write("/status\n");
      input.end();
      await session;

      // Then
      expect(providerRequests).toHaveLength(2);
      expect(stdout).toContain("Started.\n");
      expect(stdout).toContain("Session tasks:\n");
      expect(stdout).toContain("  1. [in_progress] Inspect the failure\n");
      expect(stdout).toContain("  2. [pending] Patch the bug\n");
      expect(stdout).toContain(
        "  tasks: 0/2 completed; current: Inspect the failure\n",
      );
      expect(stderr).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given active task progress exists during manual compaction,
    When the compacted session continues,
    Then the checkpoint includes the deterministic task progress block`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-task-compact-"));
    let firstTurnEnded: () => void = () => {};
    const firstTurnDone = new Promise<void>((resolve) => {
      firstTurnEnded = resolve;
    });
    const observedRequestContexts: (readonly Message[])[] = [];
    let requestTurn = 0;
    const provider: LLMProvider = {
      id: "task-compact-provider",
      async *stream(options) {
        if (options.toolChoice === "none") {
          yield { type: "text", text: "Manual checkpoint summary." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        requestTurn++;
        observedRequestContexts.push(structuredClone([...options.messages]));
        if (requestTurn === 1) {
          yield {
            type: "tool_call",
            id: "plan_1",
            tool: "update_plan",
            plan: [
              { step: "Inspect the failure", status: "completed" },
              { step: "Patch the bug", status: "in_progress" },
            ],
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        yield {
          type: "text",
          text: requestTurn === 2 ? "First done" : "Second done",
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    let stdout = "";
    let stderr = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace,
      platform: process.platform,
      session: EPHEMERAL_INTERACTIVE_SESSION,
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
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
        contextCompaction: { keepRecentTokens: 1 },
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
            if (requestTurn === 2) {
              firstTurnEnded();
            }
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    try {
      // When
      input.write("first prompt\n");
      await withTimeout(firstTurnDone, 5000, "first turn did not finish");
      input.write("/compact\n");
      input.write("second prompt\n");
      input.end();
      await session;

      // Then
      const compactedRequest = observedRequestContexts[2];
      expect(compactedRequest?.[0]).toMatchObject({
        role: "user",
        content: expect.stringContaining("## Session Task Progress"),
      });
      expect(compactedRequest?.[0]).toMatchObject({
        role: "user",
        content: expect.stringContaining("[completed] Inspect the failure"),
      });
      expect(compactedRequest?.[0]).toMatchObject({
        role: "user",
        content: expect.stringContaining("[in_progress] Patch the bug"),
      });
      expect(stdout).toContain("First done\nSecond done\n");
      expect(stderr).toContain("Context compacted: manual");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given task progress is updated before injected input in the same turn,
    When the session is forked before the injected user message,
    Then the fork keeps the task progress that existed at that message boundary`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-task-injected-"));
    const home = await mkdtemp(join(tmpdir(), "keel-task-injected-home-"));
    const source = createSessionStore({
      sessionId: "task-injected-source",
      workspace,
      runtime: runtime(home),
    });
    let timestamp = 1;
    const nextRuntime = () => runtime(home, timestamp++);
    let persistedMessages = source.messages;
    let updatePlanRequested: () => void = () => {};
    const updatePlanStarted = new Promise<void>((resolve) => {
      updatePlanRequested = resolve;
    });
    let allowFirstProviderStop: () => void = () => {};
    const firstProviderStopAllowed = new Promise<void>((resolve) => {
      allowFirstProviderStop = resolve;
    });
    let firstTurnEnded: () => void = () => {};
    const firstTurnDone = new Promise<void>((resolve) => {
      firstTurnEnded = resolve;
    });
    const providerRequests: (readonly Message[])[] = [];
    const provider: LLMProvider = {
      id: "task-injected-provider",
      async *stream(options) {
        providerRequests.push(structuredClone([...options.messages]));
        if (providerRequests.length === 1) {
          yield {
            type: "tool_call",
            id: "plan_1",
            tool: "update_plan",
            plan: [
              {
                step: "Handle the first prompt",
                status: "in_progress",
              },
            ],
          };
          updatePlanRequested();
          await firstProviderStopAllowed;
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        yield { type: "text", text: "Handled both prompts." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    let stdout = "";
    let stderr = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace,
      platform: process.platform,
      session: savedInteractiveSession({
        id: source.id,
        persistMessages: ({ messages, reason, consumedInputIds }) => {
          persistedMessages = persistSessionMessages({
            session: source,
            previousMessages: persistedMessages,
            currentMessages: messages,
            reason,
            consumedInputIds,
            runtime: nextRuntime(),
          });
        },
        persistTaskProgress: (update) => {
          persistSessionTaskProgress({
            session: source,
            taskProgress: update.taskProgress,
            messageOrdinal: update.messageOrdinal,
            runtime: nextRuntime(),
          });
        },
      }),

      initialMessages: source.messages,
      initialTaskProgress: source.taskProgress,
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
            firstTurnEnded();
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    try {
      // When
      input.write("first prompt\n");
      await withTimeout(
        updatePlanStarted,
        5000,
        "update_plan was not requested",
      );
      input.write("second prompt\n");
      allowFirstProviderStop();
      await withTimeout(firstTurnDone, 5000, "first turn did not finish");
      input.end();
      await session;
      const resumedSource = resumeSessionStore({
        sessionId: source.id,
        workspace,
        runtime: nextRuntime(),
      });
      const secondPromptId = restoredUserMessageId(
        resumedSource,
        "second prompt",
      );
      const forked = forkSessionStore({
        source: resumedSource,
        targetSessionId: "task-injected-target",
        forkPoint: {
          beforeMessageId: secondPromptId,
          optionName: "--before-message",
        },
        runtime: nextRuntime(),
      });

      // Then
      expect(forked.taskProgress).toEqual({
        tasks: [
          {
            step: "Handle the first prompt",
            status: "in_progress",
          },
        ],
      });
      expect(providerRequests[1]).toEqual([
        { role: "user", content: "first prompt" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "plan_1",
              tool: "update_plan",
              plan: [
                {
                  step: "Handle the first prompt",
                  status: "in_progress",
                },
              ],
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "plan_1",
          content: expect.stringContaining(
            "Task progress updated: 0/1 completed; current: Handle the first prompt.",
          ),
        },
        { role: "user", content: "second prompt" },
      ]);
      expect(stdout).toContain("Handled both prompts.");
      expect(stderr).toBe("");
    } finally {
      input.destroy();
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a turn repeats the same task progress update,
    When the turn is persisted,
    Then Keel stores only the first concrete state change`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-task-repeat-"));
    const provider: LLMProvider = {
      id: "task-repeat-provider",
      async *stream(options) {
        const updateCount = options.messages.filter(
          (message) =>
            message.role === "tool" &&
            message.content.includes("Task progress updated:"),
        ).length;
        if (updateCount < 2) {
          yield {
            type: "tool_call",
            id: `plan_${updateCount + 1}`,
            tool: "update_plan",
            plan: [
              {
                step: "Inspect the failure",
                status: "in_progress",
              },
            ],
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        yield { type: "text", text: "Done." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    const persistedUpdates: {
      readonly messageOrdinal: number;
      readonly taskProgress: unknown;
    }[] = [];
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace,
      platform: process.platform,
      session: savedInteractiveSession({
        id: "test-session",
        persistMessages: () => {},
        persistTaskProgress: (update) => {
          persistedUpdates.push(update);
        },
      }),
      input,
      writeStdout: () => {},
      writeStderr: () => {},
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

      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
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
      input.end("start\n");
      await session;

      // Then
      expect(persistedUpdates).toHaveLength(1);
      expect(persistedUpdates[0]).toMatchObject({
        taskProgress: {
          tasks: [
            {
              step: "Inspect the failure",
              status: "in_progress",
            },
          ],
        },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
