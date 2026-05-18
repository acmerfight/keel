import { describe, expect, test } from "vitest";
import { type AgentEvent, runAgent } from "../../src/agent/loop.ts";
import {
  createFakeProvider,
  fakeResponse,
} from "../../src/llm/providers/fake.ts";
import type { LLMProvider } from "../../src/llm/types.ts";

type TextEvent = Extract<AgentEvent, { readonly type: "text" }>;
type EndEvent = Extract<AgentEvent, { readonly type: "end" }>;

function isText(e: AgentEvent): e is TextEvent {
  return e.type === "text";
}

function isEnd(e: AgentEvent): e is EndEvent {
  return e.type === "end";
}

async function collect(
  source: AsyncIterable<AgentEvent>,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of source) {
    events.push(event);
  }
  return events;
}

describe("Text Reply", () => {
  test(`Given user sends a message,
    When agent responds,
    Then agent replies with text`, async () => {
    // Given
    const provider = createFakeProvider([
      fakeResponse("Hello! How can I help?"),
    ]);

    // When
    const events = await collect(
      runAgent({
        provider,
        userMessage: "hi",
        systemPrompt: "You are a helpful assistant.",
      }),
    );

    // Then
    const textEvents = events.filter(isText);
    expect(textEvents.length).toBeGreaterThan(0);
    expect(textEvents.map((e) => e.text).join("")).toBe(
      "Hello! How can I help?",
    );

    const endEvents = events.filter(isEnd);
    expect(endEvents).toHaveLength(1);
  });

  test(`Given user sends a message,
    When agent responds,
    Then the reply streams token by token`, async () => {
    // Given
    const provider = createFakeProvider([fakeResponse("Hi", true)]);

    // When
    const events = await collect(
      runAgent({
        provider,
        userMessage: "hello",
        systemPrompt: "You are a helpful assistant.",
      }),
    );

    // Then
    const textEvents = events.filter(isText);
    expect(textEvents).toHaveLength(2);
    expect(textEvents[0]?.text).toBe("H");
    expect(textEvents[1]?.text).toBe("i");
  });

  test(`Given user sends a message,
    When agent finishes replying,
    Then agent reports token usage`, async () => {
    // Given
    const provider = createFakeProvider([
      fakeResponse("Done.", false, { inputTokens: 100, outputTokens: 10 }),
    ]);

    // When
    const events = await collect(
      runAgent({
        provider,
        userMessage: "summarize",
        systemPrompt: "You are a helpful assistant.",
      }),
    );

    // Then
    const endEvent = events.find(isEnd);
    expect(endEvent?.usage).toEqual({ inputTokens: 100, outputTokens: 10 });
  });

  test(`Given the LLM stream ends unexpectedly,
    When agent detects missing stop signal,
    Then agent throws an error`, async () => {
    // Given
    const brokenProvider: LLMProvider = {
      id: "broken",
      async *stream() {
        yield { type: "text", text: "partial respon" };
      },
    };

    // When / Then
    await expect(
      collect(
        runAgent({
          provider: brokenProvider,
          userMessage: "hi",
          systemPrompt: "You are helpful.",
        }),
      ),
    ).rejects.toThrow("LLM stream ended without stop event");
  });
});
