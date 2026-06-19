import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../src/agent/loop.ts";
import { runAgentTurn } from "../../src/agent/loop.ts";
import { defaultStopPolicy } from "../../src/agent/stop-policy.ts";
import type { LLMProvider, Message, Usage } from "../../src/llm/types.ts";

const ZERO_USAGE: Usage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  uncachedInputTokens: 0,
  outputTokens: 0,
};

function freshSignal(): AbortSignal {
  return new AbortController().signal;
}

function workspace(): string {
  return process.cwd();
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

function receivedMessages(
  messages: readonly Message[] | null,
): readonly Message[] {
  if (messages === null) {
    throw new Error("provider did not receive messages");
  }
  return messages;
}

describe("Conversation History", () => {
  test(`Given an agent session has earlier text context,
    When the next turn is sent to the model,
    Then the model receives the complete conversation history`, async () => {
    // Given
    const messages: Message[] = [
      { role: "user", content: "Remember alpha." },
      { role: "assistant", content: "I will remember alpha.", toolCalls: [] },
      { role: "user", content: "What should you remember?" },
    ];
    let providerMessages: readonly Message[] | null = null;
    const provider: LLMProvider = {
      id: "ledger-text-provider",
      async *stream(options) {
        providerMessages = options.messages;
        yield { type: "text", text: "Alpha." };
        yield { type: "stop", usage: ZERO_USAGE };
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
      }),
    );

    // Then
    expect(receivedMessages(providerMessages)).toEqual([
      { role: "user", content: "Remember alpha." },
      { role: "assistant", content: "I will remember alpha.", toolCalls: [] },
      { role: "user", content: "What should you remember?" },
    ]);
    expect(messages).toEqual([
      { role: "user", content: "Remember alpha." },
      { role: "assistant", content: "I will remember alpha.", toolCalls: [] },
      { role: "user", content: "What should you remember?" },
      { role: "assistant", content: "Alpha.", toolCalls: [] },
    ]);
  });

  test(`Given an agent turn executes a tool,
    When the model is called again,
    Then the follow-up request includes the assistant tool call and tool result`, async () => {
    // Given
    const messages: Message[] = [{ role: "user", content: "Read package." }];
    const providerRequests: (readonly Message[])[] = [];
    const provider: LLMProvider = {
      id: "ledger-tool-provider",
      async *stream(options) {
        providerRequests.push(options.messages);
        if (providerRequests.length === 1) {
          yield {
            type: "tool_call",
            id: "call_read_package",
            tool: "read",
            path: "package.json",
          };
          yield { type: "stop", usage: ZERO_USAGE };
          return;
        }
        yield { type: "text", text: "Read package.json." };
        yield { type: "stop", usage: ZERO_USAGE };
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
      }),
    );

    // Then
    expect(providerRequests).toHaveLength(2);
    expect(providerRequests[1]).toEqual([
      { role: "user", content: "Read package." },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_read_package",
            tool: "read",
            path: "package.json",
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "call_read_package",
        content: expect.stringContaining('"name": "keel"'),
      },
    ]);
    expect(messages.at(-1)).toEqual({
      role: "assistant",
      content: "Read package.json.",
      toolCalls: [],
    });
  });

  test(`Given queued steering arrives after tool execution,
    When the model is called again,
    Then the follow-up request includes the steering message after the tool result`, async () => {
    // Given
    const messages: Message[] = [{ role: "user", content: "Read package." }];
    const providerRequests: (readonly Message[])[] = [];
    const provider: LLMProvider = {
      id: "ledger-steering-provider",
      async *stream(options) {
        providerRequests.push(options.messages);
        if (providerRequests.length === 1) {
          yield {
            type: "tool_call",
            id: "call_read_package",
            tool: "read",
            path: "package.json",
          };
          yield { type: "stop", usage: ZERO_USAGE };
          return;
        }
        yield { type: "text", text: "Read package and noted steering." };
        yield { type: "stop", usage: ZERO_USAGE };
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
        drainInjectedUserMessages: () => [
          { role: "user", content: "Also explain the scripts." },
        ],
      }),
    );

    // Then
    expect(providerRequests).toHaveLength(2);
    expect(providerRequests[1]).toEqual([
      { role: "user", content: "Read package." },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_read_package",
            tool: "read",
            path: "package.json",
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "call_read_package",
        content: expect.stringContaining('"name": "keel"'),
      },
      { role: "user", content: "Also explain the scripts." },
    ]);
    expect(messages).toEqual([
      { role: "user", content: "Read package." },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_read_package",
            tool: "read",
            path: "package.json",
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "call_read_package",
        content: expect.stringContaining('"name": "keel"'),
      },
      { role: "user", content: "Also explain the scripts." },
      {
        role: "assistant",
        content: "Read package and noted steering.",
        toolCalls: [],
      },
    ]);
  });

  test(`Given context compaction summarizes older history,
    When the model request is retried,
    Then the provider receives the checkpoint and recent user context`, async () => {
    // Given
    const messages: Message[] = [
      { role: "user", content: "Older task details ".repeat(80) },
      {
        role: "assistant",
        content: "Older progress ".repeat(80),
        toolCalls: [],
      },
      { role: "user", content: "Continue with the latest step." },
    ];
    const providerRequests: (readonly Message[])[] = [];
    const provider: LLMProvider = {
      id: "ledger-compaction-provider",
      async *stream(options) {
        providerRequests.push(options.messages);
        if (options.toolChoice === "none") {
          yield { type: "text", text: "Current Task: continue latest step." };
          yield { type: "stop", usage: ZERO_USAGE };
          return;
        }
        if (providerRequests.length === 1) {
          yield { type: "text", text: "Continued." };
          yield { type: "stop", usage: ZERO_USAGE };
          return;
        }
        yield { type: "text", text: "Continued after checkpoint." };
        yield { type: "stop", usage: ZERO_USAGE };
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
        contextCompaction: {
          contextWindowTokens: 200,
          reserveTokens: 0,
          keepRecentTokens: 10,
        },
      }),
    );

    // Then
    const retriedRequest = providerRequests.find(
      (request) => request[0]?.role === "user" && request.length === 2,
    );
    expect(retriedRequest).toEqual([
      {
        role: "user",
        content: expect.stringContaining("<conversation-checkpoint>"),
      },
      { role: "user", content: "Continue with the latest step." },
    ]);
    expect(messages).toEqual([
      {
        role: "user",
        content: expect.stringContaining("<conversation-checkpoint>"),
      },
      { role: "user", content: "Continue with the latest step." },
      {
        role: "assistant",
        content: "Continued after checkpoint.",
        toolCalls: [],
      },
    ]);
  });
});
