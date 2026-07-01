import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../src/agent/events.ts";
import { runAgentTurn } from "../../src/agent/loop.ts";
import { defaultStopPolicy } from "../../src/agent/stop-policy.ts";
import type {
  ToolOutputArtifactSaveInput,
  ToolOutputArtifactStore,
} from "../../src/agent/tool-output-artifacts.ts";
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

describe("Agent Tool Output Artifacts", () => {
  test(`Given one turn has several medium outputs over the aggregate budget,
    When Keel settles the tool results,
    Then it artifacts the largest outputs until the turn is back under budget`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-agent-artifacts-"));
    await writeFile(
      join(workspace, "first.log"),
      ["FIRST_START", "a".repeat(700), "FIRST_END"].join("\n"),
      "utf8",
    );
    await writeFile(
      join(workspace, "second.log"),
      ["SECOND_START", "b".repeat(700), "SECOND_END"].join("\n"),
      "utf8",
    );
    await writeFile(
      join(workspace, "third.log"),
      ["THIRD_START", "c".repeat(700), "THIRD_END"].join("\n"),
      "utf8",
    );
    const saved: ToolOutputArtifactSaveInput[] = [];
    const store: ToolOutputArtifactStore = {
      exists: async () => false,
      save: async (input) => {
        saved.push(input);
        return { status: "stored", ref: `tool-output:test/${saved.length}` };
      },
    };
    const messages: Message[] = [{ role: "user", content: "inspect the logs" }];
    let requestCount = 0;
    const provider: LLMProvider = {
      id: "aggregate-largest-artifact-provider",
      async *stream(options) {
        requestCount++;
        if (requestCount === 1) {
          yield {
            type: "tool_call",
            id: "read_first",
            tool: "read",
            path: "first.log",
          };
          yield {
            type: "tool_call",
            id: "read_second",
            tool: "read",
            path: "second.log",
          };
          yield {
            type: "tool_call",
            id: "read_third",
            tool: "read",
            path: "third.log",
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        const toolMessages = options.messages.filter(
          (message) => message.role === "tool",
        );
        const aggregateHandled =
          toolMessages[0]?.content.includes("keel artifacts show") === true &&
          toolMessages[1]?.content.includes("keel artifacts show") === true &&
          toolMessages[2]?.content.includes("THIRD_END") === true &&
          toolMessages[2]?.content.includes("keel artifacts show") === false;
        yield {
          type: "text",
          text: aggregateHandled ? "aggregate handled" : "aggregate missing",
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
          toolOutputArtifacts: {
            store,
            maxInlineChars: 1_000,
            maxAggregateInlineChars: 1_000,
            aggregatePreviewChars: 10,
          },
        }),
      );

      // Then
      expect(events).toContainEqual({
        type: "text",
        text: "aggregate handled",
      });
      expect(saved.map((artifact) => artifact.toolCallId)).toEqual([
        "read_first",
        "read_second",
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
