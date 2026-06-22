import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../src/agent/loop.ts";
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

describe("Searching Code", () => {
  test(`Given the assistant searches with a multi-line pattern,
    When the agent handles the failed search,
    Then it reports the failure with a recovery hint and continues instead of crashing`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-grep-agent-"));
    await writeFile(join(workspace, "app.ts"), "alpha\nbeta\n", "utf8");

    let toolFeedback = "";
    let turn = 0;
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        turn++;
        if (turn === 1) {
          yield {
            type: "tool_call",
            id: "g1",
            tool: "grep",
            pattern: "alpha\nbeta",
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        toolFeedback =
          options.messages.findLast((m) => m.role === "tool")?.content ?? "";
        yield { type: "text", text: "Retrying with a single-line search." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "find the alpha/beta block",
          systemPrompt: "You are a helpful assistant.",
          signal: new AbortController().signal,
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then — the loop recovered and reached a second turn instead of crashing
      const text = events
        .filter((e) => e.type === "text")
        .map((e) => e.text)
        .join("");
      expect(text).toContain("Retrying with a single-line search.");

      // and the failed search was returned to the model with a recovery hint
      expect(toolFeedback).toContain("Tool failed: grep failed");
      expect(toolFeedback).toContain("Recovery:");
      expect(toolFeedback).toContain("single line");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
