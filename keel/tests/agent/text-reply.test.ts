import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../src/agent/events.ts";
import { runAgent, runAgentTurn } from "../../src/agent/loop.ts";
import { defaultStopPolicy } from "../../src/agent/stop-policy.ts";
import type { CostModel } from "../../src/core/cost.ts";
import { KeelError } from "../../src/core/error.ts";
import {
  createFakeProvider,
  fakeResponse,
} from "../../src/llm/providers/fake.ts";
import type { LLMProvider, Message } from "../../src/llm/types.ts";

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

const budgetModel: CostModel = {
  type: "fixed",
  uncachedInputPerMillionTokens: 1,
  cachedInputPerMillionTokens: 0,
  outputPerMillionTokens: 0,
};

const ZERO_USAGE = {
  inputTokens: 0,
  cachedInputTokens: 0,
  uncachedInputTokens: 0,
  outputTokens: 0,
};

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
        allowBash: false,
        stopPolicy: defaultStopPolicy(),
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

  test(`Given an in-process turn starts with an empty transcript,
    When agent responds,
    Then the assistant reply starts the transcript`, async () => {
    // Given
    const messages: Message[] = [];
    const provider = createFakeProvider([fakeResponse("Session started.")]);

    // When
    await collect(
      runAgentTurn({
        workspace: workspace(),
        provider,
        messages,
        systemPrompt: "You are helpful.",
        signal: freshSignal(),
        allowBash: false,
        stopPolicy: defaultStopPolicy(),
      }),
    );

    // Then
    expect(messages).toEqual([
      { role: "assistant", content: "Session started.", toolCalls: [] },
    ]);
  });

  test(`Given an in-process turn produces no visible text,
    When user sends a follow-up message,
    Then the empty turn adds no assistant message to the transcript`, async () => {
    // Given
    const messages: Message[] = [{ role: "user", content: "stay silent" }];
    let turn = 0;
    let secondTurnMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "silent-session",
      async *stream(options) {
        turn++;
        if (turn === 2) {
          secondTurnMessages = [...options.messages];
        }
        if (turn === 1) {
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        yield { type: "text", text: "Now responding." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    await collect(
      runAgentTurn({
        workspace: workspace(),
        provider,
        messages,
        systemPrompt: "You are helpful.",
        signal: freshSignal(),
        allowBash: false,
        stopPolicy: defaultStopPolicy(),
      }),
    );
    messages.push({ role: "user", content: "are you there?" });

    // When
    await collect(
      runAgentTurn({
        workspace: workspace(),
        provider,
        messages,
        systemPrompt: "You are helpful.",
        signal: freshSignal(),
        allowBash: false,
        stopPolicy: defaultStopPolicy(),
      }),
    );

    // Then
    expect(secondTurnMessages).toEqual([
      { role: "user", content: "stay silent" },
      { role: "user", content: "are you there?" },
    ]);
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
          reason: "stop",
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
        allowBash: false,
        stopPolicy: defaultStopPolicy(),
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
        allowBash: false,
        stopPolicy: defaultStopPolicy(),
      }),
    );

    // Then
    expect(secondTurnMessages).toEqual([
      { role: "user", content: "remember alpha" },
      { role: "assistant", content: "Remembered alpha.", toolCalls: [] },
      { role: "user", content: "what did I ask you to remember?" },
    ]);
  });

  test(`Given a session turn stops after exceeding its cost budget,
    When user sends a follow-up message,
    Then the provider still receives the visible assistant reply`, async () => {
    // Given
    const messages: Message[] = [{ role: "user", content: "summarize alpha" }];
    let turn = 0;
    let secondTurnMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "budgeted-session",
      async *stream(options) {
        turn++;
        if (turn === 2) {
          secondTurnMessages = [...options.messages];
        }
        yield {
          type: "text",
          text: turn === 1 ? "Alpha summary before budget stop." : "Follow-up.",
        };
        yield {
          type: "stop",
          reason: "stop",
          usage: {
            inputTokens: turn === 1 ? 1_000_000 : 1,
            cachedInputTokens: 0,
            uncachedInputTokens: turn === 1 ? 1_000_000 : 1,
            outputTokens: 0,
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
        allowBash: false,
        stopPolicy: defaultStopPolicy(),
        costTracking: {
          model: budgetModel,
          maxCostUsd: 0.5,
        },
      }),
    );
    messages.push({ role: "user", content: "continue from that summary" });

    // When
    await collect(
      runAgentTurn({
        workspace: workspace(),
        provider,
        messages,
        systemPrompt: "You are helpful.",
        signal: freshSignal(),
        allowBash: false,
        stopPolicy: defaultStopPolicy(),
      }),
    );

    // Then
    expect(secondTurnMessages).toEqual([
      { role: "user", content: "summarize alpha" },
      {
        role: "assistant",
        content: "Alpha summary before budget stop.",
        toolCalls: [],
      },
      { role: "user", content: "continue from that summary" },
    ]);
  });

  test(`Given an in-process session executes a tool,
    When user sends a follow-up message,
    Then the provider receives the assistant tool call and tool result`, async () => {
    // Given
    const messages: Message[] = [{ role: "user", content: "inspect package" }];
    let turn = 0;
    let secondTurnMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "tool-session",
      async *stream(options) {
        turn++;
        if (turn === 1) {
          yield {
            type: "tool_call",
            id: "read_package",
            tool: "read",
            path: "package.json",
            limit: 1,
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        if (turn === 2) {
          yield { type: "text", text: "Inspected package." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        secondTurnMessages = [...options.messages];
        yield { type: "text", text: "Continuing with package context." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    await collect(
      runAgentTurn({
        workspace: workspace(),
        provider,
        messages,
        systemPrompt: "You are helpful.",
        signal: freshSignal(),
        allowBash: false,
        stopPolicy: defaultStopPolicy(),
      }),
    );
    messages.push({ role: "user", content: "continue from the package" });

    // When
    await collect(
      runAgentTurn({
        workspace: workspace(),
        provider,
        messages,
        systemPrompt: "You are helpful.",
        signal: freshSignal(),
        allowBash: false,
        stopPolicy: defaultStopPolicy(),
      }),
    );

    // Then
    expect(secondTurnMessages).toEqual([
      { role: "user", content: "inspect package" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "read_package",
            tool: "read",
            path: "package.json",
            limit: 1,
          },
        ],
      },
      expect.objectContaining({
        role: "tool",
        toolCallId: "read_package",
      }),
      { role: "assistant", content: "Inspected package.", toolCalls: [] },
      { role: "user", content: "continue from the package" },
    ]);
  });

  test(`Given user steers while a tool turn is continuing,
    When the tool result has been added,
    Then the next model request includes the steering after the tool result`, async () => {
    // Given
    const messages: Message[] = [{ role: "user", content: "inspect package" }];
    let turn = 0;
    let drained = false;
    let secondTurnMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "steerable-session",
      async *stream(options) {
        turn++;
        if (turn === 1) {
          yield {
            type: "tool_call",
            id: "read_package_for_steering",
            tool: "read",
            path: "package.json",
            limit: 1,
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        secondTurnMessages = [...options.messages];
        yield { type: "text", text: "Adjusted after steering." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    // When
    await collect(
      runAgentTurn({
        workspace: workspace(),
        provider,
        messages,
        systemPrompt: "You are helpful.",
        signal: freshSignal(),
        allowBash: false,
        stopPolicy: defaultStopPolicy(),
        drainInjectedUserMessages: () => {
          if (drained) {
            return [];
          }
          drained = true;
          return [{ role: "user", content: "focus on the scripts" }];
        },
      }),
    );

    // Then
    expect(secondTurnMessages).toEqual([
      { role: "user", content: "inspect package" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "read_package_for_steering",
            tool: "read",
            path: "package.json",
            limit: 1,
          },
        ],
      },
      expect.objectContaining({
        role: "tool",
        toolCallId: "read_package_for_steering",
      }),
      { role: "user", content: "focus on the scripts" },
    ]);
  });

  test(`Given user steers while a batch of tools is continuing,
    When all tool results have been added,
    Then the next model request includes the steering after every tool result`, async () => {
    // Given
    const messages: Message[] = [{ role: "user", content: "inspect project" }];
    let turn = 0;
    let drained = false;
    let secondTurnMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "batched-tools-session",
      async *stream(options) {
        turn++;
        if (turn === 1) {
          yield {
            type: "tool_call",
            id: "read_package_for_batch",
            tool: "read",
            path: "package.json",
            limit: 1,
          };
          yield {
            type: "tool_call",
            id: "read_agents_for_batch",
            tool: "read",
            path: "AGENTS.md",
            limit: 1,
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        secondTurnMessages = [...options.messages];
        yield { type: "text", text: "Adjusted after batch steering." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    // When
    await collect(
      runAgentTurn({
        workspace: workspace(),
        provider,
        messages,
        systemPrompt: "You are helpful.",
        signal: freshSignal(),
        allowBash: false,
        stopPolicy: defaultStopPolicy(),
        drainInjectedUserMessages: () => {
          if (drained) {
            return [];
          }
          drained = true;
          return [{ role: "user", content: "compare both files" }];
        },
      }),
    );

    // Then
    expect(secondTurnMessages).toEqual([
      { role: "user", content: "inspect project" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "read_package_for_batch",
            tool: "read",
            path: "package.json",
            limit: 1,
          },
          {
            id: "read_agents_for_batch",
            tool: "read",
            path: "AGENTS.md",
            limit: 1,
          },
        ],
      },
      expect.objectContaining({
        role: "tool",
        toolCallId: "read_package_for_batch",
      }),
      expect.objectContaining({
        role: "tool",
        toolCallId: "read_agents_for_batch",
      }),
      { role: "user", content: "compare both files" },
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
        allowBash: false,
        stopPolicy: defaultStopPolicy(),
      }),
    );

    // Then
    const textEvents = events.filter(isText);
    expect(textEvents).toHaveLength(2);
    expect(textEvents[0]?.text).toBe("H");
    expect(textEvents[1]?.text).toBe("i");
  });

  test(`Given the model request needs a retry before answering,
    When agent streams the response,
    Then the retry notice is forwarded before the reply`, async () => {
    // Given
    const provider: LLMProvider = {
      id: "retrying-model",
      async *stream() {
        yield {
          type: "provider_retry",
          provider: "TestProvider",
          reason: "provider_rate_limited",
          attempt: 1,
          maxRetries: 2,
          delayMs: 0,
        };
        yield { type: "text", text: "Recovered." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    // When
    const events = await collect(
      runAgent({
        workspace: workspace(),
        provider,
        userMessage: "answer after retry",
        systemPrompt: "You are helpful.",
        signal: freshSignal(),
        allowBash: false,
        stopPolicy: defaultStopPolicy(),
      }),
    );

    // Then
    expect(events.slice(0, 2)).toEqual([
      {
        type: "provider_retry",
        provider: "TestProvider",
        reason: "provider_rate_limited",
        attempt: 1,
        maxRetries: 2,
        delayMs: 0,
      },
      { type: "text", text: "Recovered." },
    ]);
    expect(events.at(-1)).toMatchObject({ type: "end" });
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
        allowBash: false,
        stopPolicy: defaultStopPolicy(),
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
          reason: "stop",
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
        allowBash: false,
        stopPolicy: defaultStopPolicy(),
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
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
        }),
      ),
    ).rejects.toThrow("LLM stream ended without stop event");
  });

  test(`Given the model connection fails after partial text,
    When agent handles the turn,
    Then the partial turn is not committed`, async () => {
    // Given
    const messages: Message[] = [{ role: "user", content: "start reply" }];
    const events: AgentEvent[] = [];
    const brokenProvider: LLMProvider = {
      id: "stream-failure",
      async *stream() {
        yield { type: "text", text: "partial reply" };
        throw new KeelError(
          "provider_network_error",
          "TestProvider stream failed",
        );
      },
    };

    // When
    const run = async () => {
      for await (const event of runAgentTurn({
        workspace: workspace(),
        provider: brokenProvider,
        messages,
        systemPrompt: "You are helpful.",
        signal: freshSignal(),
        allowBash: false,
        stopPolicy: defaultStopPolicy(),
      })) {
        events.push(event);
      }
    };

    // Then
    await expect(run()).rejects.toMatchObject({
      name: "KeelError",
      code: "provider_network_error",
      message: "TestProvider stream failed",
    });
    expect(events).toEqual([{ type: "text", text: "partial reply" }]);
    expect(messages).toEqual([{ role: "user", content: "start reply" }]);
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
            reason: "stop",
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
          reason: "stop",
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
        allowBash: false,
        stopPolicy: defaultStopPolicy(),
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
            reason: "stop",
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
          reason: "stop",
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
        allowBash: false,
        stopPolicy: defaultStopPolicy(),
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
