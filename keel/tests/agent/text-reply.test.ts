import { describe, expect, test } from "vitest";
import {
  type AgentEvent,
  runAgent,
  runAgentTurn,
} from "../../src/agent/loop.ts";
import type { LLMProvider, Message } from "../../src/llm/types.ts";
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
  test(`Given user asks for help,
    When agent responds,
    Then the user receives the reply text`, async () => {
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

  test(`Given an in-process session has prior messages,
    When user sends a follow-up message,
    Then the provider receives the earlier context`, async () => {
    // Given
    const messages: Message[] = [{ role: "user", content: "remember alpha" }];
    let turn = 0;
    let secondTurnMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "observed-session",
      async *stream(options) {
        turn++;
        if (turn === 2) {
          secondTurnMessages = [...options.messages];
        }
        yield {
          type: "text",
          text: turn === 1 ? "Remembered alpha." : "You asked about alpha.",
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
    await collect(
      runAgentTurn({
        workspace: workspace(),
        provider,
        messages,
        systemPrompt: "You are helpful.",
        signal: freshSignal(),
      }),
    );
    messages.push({ role: "user", content: "what did I ask you to remember?" });

    // When
    await collect(
      runAgentTurn({
        workspace: workspace(),
        provider,
        messages,
        systemPrompt: "You are helpful.",
        signal: freshSignal(),
      }),
    );

    // Then
    expect(secondTurnMessages).toEqual([
      { role: "user", content: "remember alpha" },
      { role: "assistant", content: "Remembered alpha." },
      { role: "user", content: "what did I ask you to remember?" },
    ]);
  });

  test(`Given a short assistant reply,
    When agent responds,
    Then the reply is emitted incrementally`, async () => {
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

  test(`Given user asks a question,
    When agent finishes replying,
    Then the session reports token usage`, async () => {
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

  test(`Given a request can be cancelled,
    When agent starts the request,
    Then cancellation is preserved`, async () => {
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

  test(`Given an assistant response ends before completion,
    When agent detects the incomplete response,
    Then agent reports an incomplete response error`, async () => {
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

  test(`Given a task needs more than eight tool rounds,
    When the assistant eventually reaches a final reply,
    Then the agent allows the task to complete`, async () => {
    // Given
    let turn = 0;
    const provider: LLMProvider = {
      id: "long-tool-chain",
      async *stream() {
        if (turn < 9) {
          yield {
            type: "tool_call",
            id: `read_package_${turn}`,
            tool: "read",
            path: "package.json",
            limit: turn + 1,
          };
          turn++;
          yield {
            type: "stop",
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              uncachedInputTokens: 1,
              outputTokens: 1,
            },
          };
          return;
        }

        yield { type: "text", text: "Completed the long task." };
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
    const events = await collect(
      runAgent({
        workspace: workspace(),
        provider,
        userMessage: "inspect several files and verify the result",
        systemPrompt: "You are helpful.",
        signal: freshSignal(),
      }),
    );

    // Then
    expect(events).toContainEqual({
      type: "text",
      text: "Completed the long task.",
    });
  });

  test(`Given the assistant keeps requesting new inspections without finishing,
    When the agent exhausts its round limit,
    Then the run ends with a progress summary instead of an error`, async () => {
    // Given
    let round = 0;
    const loopingProvider: LLMProvider = {
      id: "looping-tools",
      async *stream(options) {
        const lastMessage = options.messages.at(-1);
        if (options.messages.length > 1 && lastMessage?.role === "user") {
          yield {
            type: "text",
            text: "Out of rounds: inspected many files, the task is unfinished.",
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
          return;
        }

        round++;
        yield {
          type: "tool_call",
          id: `read_package_${round}`,
          tool: "read",
          path: "package.json",
          limit: round,
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

    // When
    const events = await collect(
      runAgent({
        workspace: workspace(),
        provider: loopingProvider,
        userMessage: "inspect forever",
        systemPrompt: "You are helpful.",
        signal: freshSignal(),
      }),
    );

    // Then
    const executedCalls = events.filter((event) => event.type === "tool_start");
    expect(executedCalls.length).toBeGreaterThan(16);
    expect(events).toContainEqual({
      type: "text",
      text: "Out of rounds: inspected many files, the task is unfinished.",
    });
    expect(events.at(-1)).toMatchObject({ type: "end" });
  });
});
