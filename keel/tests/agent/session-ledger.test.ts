import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../src/agent/events.ts";
import { runAgentTurn } from "../../src/agent/loop.ts";
import {
  projectSessionLedgerToProviderMessages,
  sessionLedgerFromMessages,
} from "../../src/agent/session-ledger.ts";
import type { SessionMessage } from "../../src/agent/session-message.ts";
import {
  defaultStopPolicy,
  maxTurnFallbackPolicy,
} from "../../src/agent/stop-policy.ts";
import type {
  LLMProvider,
  ProviderMessage,
  Usage,
} from "../../src/llm/types.ts";
import { sessionLedgerMirroringMessages } from "../../src/testing/session-ledger-fixtures.ts";
import type { AgentMemoryMutationCapability } from "../../src/tools/memory.ts";

const ZERO_USAGE: Usage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  uncachedInputTokens: 0,
  outputTokens: 0,
};

const UNUSED_MEMORY_MUTATION: AgentMemoryMutationCapability = {
  list: () => [],
  add: () => {
    throw new Error("memory mutation should not run");
  },
  forget: () => {
    throw new Error("memory mutation should not run");
  },
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
  messages: readonly ProviderMessage[] | null,
): readonly ProviderMessage[] {
  if (messages === null) {
    throw new Error("provider did not receive messages");
  }
  return messages;
}

describe("Conversation History", () => {
  test(`Given a ledger is created from caller-owned messages,
    When the caller later mutates its source array,
    Then the ledger remains the sole owner of its message state`, () => {
    const source: SessionMessage[] = [{ role: "user", content: "Initial" }];
    const ledger = sessionLedgerFromMessages(source);

    source.push({ role: "user", content: "External mutation" });
    ledger.append({
      role: "assistant",
      content: "Ledger mutation",
      toolCalls: [],
    });

    expect(ledger.messages()).toEqual([
      { role: "user", content: "Initial" },
      { role: "assistant", content: "Ledger mutation", toolCalls: [] },
    ]);
    expect(source).toEqual([
      { role: "user", content: "Initial" },
      { role: "user", content: "External mutation" },
    ]);
  });

  test(`Given Runtime tool evidence is stored in the session ledger,
    When messages are projected for a provider request,
    Then only the provider tool contract crosses the boundary`, () => {
    const ledger = sessionLedgerFromMessages([
      {
        role: "tool",
        toolCallId: "read_note",
        content: "bounded preview",
        sourceTruncated: true,
        evidenceShortened: true,
        resourceObservation: {
          kind: "read_projection",
          targetPathSha256: "a".repeat(64),
          contentSha256: "b".repeat(64),
        },
      },
    ]);

    expect(projectSessionLedgerToProviderMessages(ledger)).toEqual([
      {
        role: "tool",
        toolCallId: "read_note",
        content: "bounded preview",
      },
    ]);
    expect(ledger.messages()[0]).toMatchObject({
      sourceTruncated: true,
      evidenceShortened: true,
      resourceObservation: { kind: "read_projection" },
    });
  });

  test(`Given an agent session has earlier text context,
    When the next turn is sent to the model,
    Then the model receives the complete conversation history`, async () => {
    // Given
    const messages: SessionMessage[] = [
      { role: "user", content: "Remember alpha." },
      { role: "assistant", content: "I will remember alpha.", toolCalls: [] },
      { role: "user", content: "What should you remember?" },
    ];
    let providerMessages: readonly ProviderMessage[] | null = null;
    const provider: LLMProvider = {
      id: "ledger-text-provider",
      async *stream(options) {
        providerMessages = options.messages;
        yield { type: "text", text: "Alpha." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    // When
    await collect(
      runAgentTurn({
        workspace: workspace(),
        provider,
        ledger: sessionLedgerMirroringMessages(messages),
        systemPrompt: "You are helpful.",
        signal: freshSignal(),
        bash: { kind: "disabled" },
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

  test(`Given user messages carry internal provenance,
    When the next turn is sent to the model,
    Then provider-visible history omits the internal origin`, async () => {
    // Given
    const messages: SessionMessage[] = [
      {
        role: "user",
        content: "Remember alpha.",
        origin: { type: "user_prompt" },
      },
    ];
    let providerMessages: readonly ProviderMessage[] | null = null;
    const provider: LLMProvider = {
      id: "ledger-origin-provider",
      async *stream(options) {
        providerMessages = options.messages;
        yield { type: "text", text: "Alpha." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    // When
    await collect(
      runAgentTurn({
        workspace: workspace(),
        provider,
        ledger: sessionLedgerMirroringMessages(messages),
        systemPrompt: "You are helpful.",
        signal: freshSignal(),
        bash: { kind: "disabled" },
        stopPolicy: defaultStopPolicy(),
      }),
    );

    // Then
    expect(receivedMessages(providerMessages)).toEqual([
      { role: "user", content: "Remember alpha." },
    ]);
    expect(messages[0]).toEqual({
      role: "user",
      content: "Remember alpha.",
      origin: { type: "user_prompt" },
    });
  });

  test(`Given an agent turn executes a tool,
    When the model is called again,
    Then the follow-up request includes the assistant tool call and tool result`, async () => {
    // Given
    const messages: SessionMessage[] = [
      { role: "user", content: "Read package." },
    ];
    const providerRequests: (readonly ProviderMessage[])[] = [];
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
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        yield { type: "text", text: "Read package.json." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    // When
    await collect(
      runAgentTurn({
        workspace: workspace(),
        provider,
        ledger: sessionLedgerMirroringMessages(messages),
        systemPrompt: "You are helpful.",
        signal: freshSignal(),
        bash: { kind: "disabled" },
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
    const messages: SessionMessage[] = [
      { role: "user", content: "Read package." },
    ];
    const providerRequests: (readonly ProviderMessage[])[] = [];
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
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        yield { type: "text", text: "Read package and noted steering." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    // When
    await collect(
      runAgentTurn({
        workspace: workspace(),
        provider,
        ledger: sessionLedgerMirroringMessages(messages),
        systemPrompt: "You are helpful.",
        signal: freshSignal(),
        bash: { kind: "disabled" },
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
        resourceObservation: {
          kind: "read_projection",
          targetPathSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
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
    const messages: SessionMessage[] = [
      { role: "user", content: "Older task details ".repeat(80) },
      {
        role: "assistant",
        content: "Older progress ".repeat(80),
        toolCalls: [],
      },
      { role: "user", content: "Continue with the latest step." },
    ];
    const providerRequests: (readonly ProviderMessage[])[] = [];
    const provider: LLMProvider = {
      id: "ledger-compaction-provider",
      async *stream(options) {
        providerRequests.push(options.messages);
        if (options.toolExposure?.kind === "none") {
          yield { type: "text", text: "Current Task: continue latest step." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        if (providerRequests.length === 1) {
          yield { type: "text", text: "Continued." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        yield { type: "text", text: "Continued after checkpoint." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    // When
    await collect(
      runAgentTurn({
        workspace: workspace(),
        provider,
        ledger: sessionLedgerMirroringMessages(messages),
        systemPrompt: "You are helpful.",
        signal: freshSignal(),
        bash: { kind: "disabled" },
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
        origin: { type: "compaction_checkpoint" },
      },
      { role: "user", content: "Continue with the latest step." },
      {
        role: "assistant",
        content: "Continued after checkpoint.",
        toolCalls: [],
      },
    ]);
  });

  test(`Given request-time project memory is present during context compaction,
    When the model summarizes history and continues the turn,
    Then only normal provider requests receive memory and the session ledger never stores it`, async () => {
    // Given
    const memoryFact = "MEMORY_ONLY_RELEASE_RULE";
    const messages: SessionMessage[] = [
      { role: "user", content: "Older task details ".repeat(80) },
      {
        role: "assistant",
        content: "Older progress ".repeat(80),
        toolCalls: [],
      },
      { role: "user", content: "Continue with the latest step." },
    ];
    const requests: {
      readonly systemPrompt: string;
      readonly toolChoice: "auto" | "none" | undefined;
    }[] = [];
    const provider: LLMProvider = {
      id: "memory-compaction-provider",
      async *stream(options) {
        requests.push({
          systemPrompt: options.systemPrompt,
          toolChoice: options.toolExposure?.kind,
        });
        if (options.toolExposure?.kind === "none") {
          yield { type: "text", text: "Current Task: continue latest step." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        yield { type: "text", text: "Continued after checkpoint." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    // When
    await collect(
      runAgentTurn({
        workspace: workspace(),
        provider,
        ledger: sessionLedgerMirroringMessages(messages),
        systemPrompt: "You are helpful.",
        memory: {
          kind: "direct",
          prompt: () => memoryFact,
          mutation: UNUSED_MEMORY_MUTATION,
        },
        signal: freshSignal(),
        bash: { kind: "disabled" },
        stopPolicy: defaultStopPolicy(),
        contextCompaction: {
          contextWindowTokens: 200,
          reserveTokens: 0,
          keepRecentTokens: 10,
        },
      }),
    );

    // Then
    const summaryRequests = requests.filter(
      (request) => request.toolChoice === "none",
    );
    const normalRequests = requests.filter(
      (request) => request.toolChoice !== "none",
    );
    expect(summaryRequests.length).toBeGreaterThan(0);
    expect(
      summaryRequests.every(
        (request) => !request.systemPrompt.includes(memoryFact),
      ),
    ).toBe(true);
    expect(normalRequests.length).toBeGreaterThan(0);
    expect(
      normalRequests.every((request) =>
        request.systemPrompt.includes(memoryFact),
      ),
    ).toBe(true);
    expect(JSON.stringify(messages)).not.toContain(memoryFact);
  });

  test(`Given project memory changes after one provider request,
    When the turn-limit wrap-up sends the next request,
    Then provider assembly resolves memory again instead of reusing the earlier prompt`, async () => {
    // Given
    const memoryFact = "MEMORY_REMOVED_BEFORE_WRAP_UP";
    let memoryActive = true;
    const requests: {
      readonly systemPrompt: string;
      readonly toolChoice: "auto" | "none" | undefined;
    }[] = [];
    const provider: LLMProvider = {
      id: "memory-wrap-up-provider",
      async *stream(options) {
        requests.push({
          systemPrompt: options.systemPrompt,
          toolChoice: options.toolExposure?.kind,
        });
        if (options.toolExposure?.kind === "none") {
          yield { type: "text", text: "Stopped after the first tool round." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        memoryActive = false;
        yield {
          type: "tool_call",
          id: "read_package",
          tool: "read",
          path: "package.json",
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    // When
    await collect(
      runAgentTurn({
        workspace: workspace(),
        provider,
        ledger: sessionLedgerFromMessages([
          { role: "user", content: "Inspect the package." },
        ]),
        systemPrompt: "You are helpful.",
        memory: {
          kind: "direct",
          prompt: () => (memoryActive ? memoryFact : ""),
          mutation: UNUSED_MEMORY_MUTATION,
        },
        signal: freshSignal(),
        bash: { kind: "disabled" },
        stopPolicy: maxTurnFallbackPolicy(1),
      }),
    );

    // Then
    expect(requests).toHaveLength(2);
    expect(requests[0]?.systemPrompt).toContain(memoryFact);
    expect(requests[1]).toMatchObject({ toolChoice: "none" });
    expect(requests[1]?.systemPrompt).not.toContain(memoryFact);
  });
});
