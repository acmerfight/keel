import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../src/agent/events.ts";
import { runAgentTurn } from "../../src/agent/loop.ts";
import { defaultStopPolicy } from "../../src/agent/stop-policy.ts";
import type { SessionGoal } from "../../src/core/session-goal.ts";
import type { LLMProvider, Message, Usage } from "../../src/llm/types.ts";

const ZERO_USAGE: Usage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  uncachedInputTokens: 0,
  outputTokens: 0,
};

async function collect(
  source: AsyncIterable<AgentEvent>,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of source) {
    events.push(event);
  }
  return events;
}

function freshSignal(): AbortSignal {
  return new AbortController().signal;
}

describe("Task Progress", () => {
  test(`Given a model updates its task plan during a turn,
    When the agent continues after the tool call,
    Then the user sees task progress and the model receives the task update result`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-task-progress-"));
    const messages: Message[] = [
      { role: "user", content: "Fix the bug and verify it." },
    ];
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
              { step: "Run verification", status: "pending" },
            ],
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        yield { type: "text", text: "I am inspecting the failure." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    try {
      // When
      const events = await collect(
        runAgentTurn({
          workspace,
          provider,
          messages,
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(events).toContainEqual({
        type: "task_progress_updated",
        messageOrdinal: 3,
        taskProgress: {
          tasks: [
            { step: "Inspect the failure", status: "in_progress" },
            { step: "Patch the bug", status: "pending" },
            { step: "Run verification", status: "pending" },
          ],
        },
      });
      expect(providerRequests).toHaveLength(2);
      expect(providerRequests[1]).toEqual([
        { role: "user", content: "Fix the bug and verify it." },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "plan_1",
              tool: "update_plan",
              plan: [
                { step: "Inspect the failure", status: "in_progress" },
                { step: "Patch the bug", status: "pending" },
                { step: "Run verification", status: "pending" },
              ],
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "plan_1",
          content: expect.stringContaining(
            "Task progress updated: 0/3 completed; current: Inspect the failure.",
          ),
        },
      ]);
      expect(messages.at(-1)).toEqual({
        role: "assistant",
        content: "I am inspecting the failure.",
        toolCalls: [],
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a model marks an active session goal completed without command evidence,
    When the agent continues after the tool call,
    Then Keel keeps the goal active and returns a recovery message to the model`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-goal-progress-"));
    const messages: Message[] = [
      { role: "user", content: "Finish the durable session goal." },
    ];
    const providerRequests: (readonly Message[])[] = [];
    const sessionGoal: SessionGoal = {
      objective: "Finish the durable session goal",
      status: "active",
    };
    const provider: LLMProvider = {
      id: "goal-progress-provider",
      async *stream(options) {
        providerRequests.push(structuredClone([...options.messages]));
        if (providerRequests.length === 1) {
          yield {
            type: "tool_call",
            id: "goal_1",
            tool: "update_goal",
            status: "completed",
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        yield {
          type: "text",
          text: "The session goal still needs command evidence.",
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    try {
      // When
      const events = await collect(
        runAgentTurn({
          workspace,
          provider,
          messages,
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
          sessionGoal,
        }),
      );

      // Then
      expect(
        events.some((event) => event.type === "session_goal_updated"),
      ).toBe(false);
      expect(providerRequests).toHaveLength(2);
      expect(providerRequests[1]).toEqual([
        { role: "user", content: "Finish the durable session goal." },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "goal_1",
              tool: "update_goal",
              status: "completed",
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "goal_1",
          content: expect.stringContaining(
            "Tool failed: update_goal failed: no completion command is set",
          ),
        },
      ]);
      expect(messages.at(-1)).toEqual({
        role: "assistant",
        content: "The session goal still needs command evidence.",
        toolCalls: [],
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a model verifies an active session goal with its completion command,
    When the model proposes completion after the successful command,
    Then Keel persists the completed goal and returns the goal result`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-goal-command-evidence-"),
    );
    const messages: Message[] = [
      { role: "user", content: "Finish the durable session goal." },
    ];
    const providerRequests: (readonly Message[])[] = [];
    const sessionGoal: SessionGoal = {
      objective: "Finish the durable session goal",
      status: "active",
      completionCommand: 'node -e "process.exit(0)"',
    };
    const provider: LLMProvider = {
      id: "goal-command-evidence-provider",
      async *stream(options) {
        providerRequests.push(structuredClone([...options.messages]));
        if (providerRequests.length === 1) {
          yield {
            type: "tool_call",
            id: "verify_1",
            tool: "bash",
            command: 'node -e "process.exit(0)"',
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        if (providerRequests.length === 2) {
          yield {
            type: "tool_call",
            id: "goal_1",
            tool: "update_goal",
            status: "completed",
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        yield { type: "text", text: "The session goal is complete." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    try {
      // When
      const events = await collect(
        runAgentTurn({
          workspace,
          provider,
          messages,
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          allowBash: true,
          stopPolicy: defaultStopPolicy(),
          sessionGoal,
        }),
      );

      // Then
      expect(events).toContainEqual({
        type: "session_goal_updated",
        messageOrdinal: 5,
        goal: {
          objective: "Finish the durable session goal",
          status: "completed",
          completionCommand: 'node -e "process.exit(0)"',
        },
      });
      expect(providerRequests).toHaveLength(3);
      expect(providerRequests[2]).toEqual([
        { role: "user", content: "Finish the durable session goal." },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "verify_1",
              tool: "bash",
              command: 'node -e "process.exit(0)"',
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "verify_1",
          content: "Exit code: 0\n\n(no output)",
        },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "goal_1",
              tool: "update_goal",
              status: "completed",
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "goal_1",
          content: "Session goal completed: Finish the durable session goal.",
        },
      ]);
      expect(messages.at(-1)).toEqual({
        role: "assistant",
        content: "The session goal is complete.",
        toolCalls: [],
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a model mutates the workspace after running the completion command,
    When the model proposes completion from stale command evidence,
    Then Keel keeps the goal active and asks for fresh evidence`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-goal-stale-command-evidence-"),
    );
    const messages: Message[] = [
      { role: "user", content: "Finish the durable session goal." },
    ];
    const providerRequests: (readonly Message[])[] = [];
    const sessionGoal: SessionGoal = {
      objective: "Finish the durable session goal",
      status: "active",
      completionCommand: 'node -e "process.exit(0)"',
    };
    const provider: LLMProvider = {
      id: "goal-stale-command-evidence-provider",
      async *stream(options) {
        providerRequests.push(structuredClone([...options.messages]));
        if (providerRequests.length === 1) {
          yield {
            type: "tool_call",
            id: "verify_1",
            tool: "bash",
            command: 'node -e "process.exit(0)"',
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        if (providerRequests.length === 2) {
          yield {
            type: "tool_call",
            id: "write_1",
            tool: "write",
            path: "note.txt",
            content: "changed after verification\n",
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        if (providerRequests.length === 3) {
          yield {
            type: "tool_call",
            id: "goal_1",
            tool: "update_goal",
            status: "completed",
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        yield { type: "text", text: "I need to rerun verification." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    try {
      // When
      const events = await collect(
        runAgentTurn({
          workspace,
          provider,
          messages,
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          allowBash: true,
          stopPolicy: defaultStopPolicy(),
          sessionGoal,
        }),
      );

      // Then
      expect(
        events.some((event) => event.type === "session_goal_updated"),
      ).toBe(false);
      expect(providerRequests).toHaveLength(4);
      expect(providerRequests[3]?.at(-1)).toEqual({
        role: "tool",
        toolCallId: "goal_1",
        content: expect.stringContaining(
          "Tool failed: update_goal failed: completion command evidence is stale",
        ),
      });
      expect(messages.at(-1)).toEqual({
        role: "assistant",
        content: "I need to rerun verification.",
        toolCalls: [],
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
