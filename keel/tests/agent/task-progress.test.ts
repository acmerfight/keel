import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../src/agent/events.ts";
import { runAgentTurn } from "../../src/agent/loop.ts";
import { defaultStopPolicy } from "../../src/agent/stop-policy.ts";
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
});
