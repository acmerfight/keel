import { describe, expect, test } from "vitest";
import { type AgentEvent, runAgent } from "../../src/agent/loop.ts";
import type { LLMProvider } from "../../src/llm/types.ts";
import {
  createFakeProvider,
  fakeResponse,
} from "../../src/testing/fake-provider.ts";

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

function freshSignal(): AbortSignal {
  return new AbortController().signal;
}

function workspace(): string {
  return process.cwd();
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
        workspace: workspace(),
        provider,
        userMessage: "hi",
        systemPrompt: "You are a helpful assistant.",
        signal: freshSignal(),
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
        workspace: workspace(),
        provider,
        userMessage: "hello",
        systemPrompt: "You are a helpful assistant.",
        signal: freshSignal(),
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
      fakeResponse("Done.", false, {
        inputTokens: 100,
        cachedInputTokens: 0,
        uncachedInputTokens: 100,
        outputTokens: 10,
      }),
    ]);

    // When
    const events = await collect(
      runAgent({
        workspace: workspace(),
        provider,
        userMessage: "summarize",
        systemPrompt: "You are a helpful assistant.",
        signal: freshSignal(),
      }),
    );

    // Then
    const endEvent = events.find(isEnd);
    expect(endEvent?.usage).toEqual({
      inputTokens: 100,
      cachedInputTokens: 0,
      uncachedInputTokens: 100,
      outputTokens: 10,
    });
  });

  test(`Given a request has an abort signal,
    When agent calls the LLM provider,
    Then the same signal is passed through`, async () => {
    // Given
    const controller = new AbortController();
    let providerSignal: AbortSignal | null = null;
    const provider: LLMProvider = {
      id: "observed",
      async *stream(options) {
        providerSignal = options.signal;
        yield {
          type: "stop",
          usage: {
            inputTokens: 1,
            cachedInputTokens: 0,
            uncachedInputTokens: 1,
            outputTokens: 1,
          },
        };
      },
    };

    // When
    await collect(
      runAgent({
        workspace: workspace(),
        provider,
        userMessage: "hi",
        systemPrompt: "You are helpful.",
        signal: controller.signal,
      }),
    );

    // Then
    expect(providerSignal).toBe(controller.signal);
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
          workspace: workspace(),
          provider: brokenProvider,
          userMessage: "hi",
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
        }),
      ),
    ).rejects.toThrow("LLM stream ended without stop event");
  });

  test(`Given the LLM keeps asking to read files,
    When the agent exceeds its tool turn limit,
    Then agent throws a tool call limit error`, async () => {
    // Given
    const loopingProvider: LLMProvider = {
      id: "looping-tools",
      async *stream() {
        yield {
          type: "tool_call",
          id: "read_package",
          tool: "read",
          path: "package.json",
        };
        yield {
          type: "stop",
          usage: {
            inputTokens: 1,
            cachedInputTokens: 0,
            uncachedInputTokens: 1,
            outputTokens: 1,
          },
        };
      },
    };

    // When / Then
    await expect(
      collect(
        runAgent({
          workspace: workspace(),
          provider: loopingProvider,
          userMessage: "inspect forever",
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
        }),
      ),
    ).rejects.toMatchObject({
      code: "agent_tool_call_limit_exceeded",
      message: "Agent exceeded tool call limit",
    });
  });
});
