import { describe, expect, test } from "vitest";
import { type AgentEvent, runAgent } from "../../src/agent/loop.ts";
import { createFakeProvider } from "../../src/llm/providers/fake.ts";

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
  test("Given a fake LLM, When user sends a message, Then agent replies with text", async () => {
    // Given
    const provider = createFakeProvider([{ text: "Hello! How can I help?" }]);

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

  test("Given a fake LLM that streams token-by-token, When user sends a message, Then agent emits each token as a separate text event", async () => {
    // Given
    const provider = createFakeProvider([{ text: "Hi", tokenize: true }]);

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

  test("Given a fake LLM with usage info, When agent finishes, Then end event contains usage", async () => {
    // Given
    const provider = createFakeProvider([
      { text: "Done.", usage: { inputTokens: 100, outputTokens: 10 } },
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

  test("Given a fake LLM with multiple turns scripted, When agent runs, Then only the first turn is consumed for a text-only reply", async () => {
    // Given
    const provider = createFakeProvider([
      { text: "First reply." },
      { text: "Second reply (should not be reached)." },
    ]);

    // When
    const events = await collect(
      runAgent({
        provider,
        userMessage: "hi",
        systemPrompt: "You are helpful.",
      }),
    );

    // Then
    const textContent = events
      .filter(isText)
      .map((e) => e.text)
      .join("");
    expect(textContent).toBe("First reply.");
  });
});
