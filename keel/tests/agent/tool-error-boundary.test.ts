import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../src/agent/events.ts";
import { runAgent } from "../../src/agent/loop.ts";
import { defaultStopPolicy } from "../../src/agent/stop-policy.ts";
import type { LLMProvider } from "../../src/llm/types.ts";

const ZERO_USAGE = {
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

describe("Tool Error Boundary", () => {
  test.skipIf(process.platform === "win32")(
    `Given a tool hits a filesystem permission error,
    When the agent receives the tool result,
    Then it continues the conversation instead of crashing`,
    async () => {
      // Given
      const workspace = await mkdtemp(join(tmpdir(), "keel-agent-tool-error-"));
      const lockedPath = join(workspace, "locked");
      await mkdir(lockedPath);
      await chmod(lockedPath, 0);
      let turn = 0;
      let toolFeedback = "";
      const provider: LLMProvider = {
        id: "fake",
        async *stream(options) {
          turn++;
          if (turn === 1) {
            yield {
              type: "tool_call",
              id: "ls_1",
              tool: "ls",
              path: "locked",
            };
            yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
            return;
          }
          toolFeedback =
            options.messages.findLast((message) => message.role === "tool")
              ?.content ?? "";
          yield { type: "text", text: "I will use another path." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
        },
      };

      try {
        // When
        const events = await collect(
          runAgent({
            workspace,
            provider,
            userMessage: "list the locked directory",
            systemPrompt: "You are a helpful assistant.",
            signal: new AbortController().signal,
            bash: { kind: "disabled" },
            stopPolicy: defaultStopPolicy(),
          }),
        );

        // Then
        expect(events).toContainEqual({
          type: "tool_end",
          toolCall: {
            id: "ls_1",
            tool: "ls",
            path: "locked",
          },
          ok: false,
        });
        expect(toolFeedback).toContain("Tool failed:");
        expect(toolFeedback).toContain("permission denied");
        expect(toolFeedback).toContain("Recovery:");
        expect(events).toContainEqual({
          type: "text",
          text: "I will use another path.",
        });
      } finally {
        await chmod(lockedPath, 0o700);
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );
});
