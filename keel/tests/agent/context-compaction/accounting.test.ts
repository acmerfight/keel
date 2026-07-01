import { describe, expect, test, vi } from "vitest";
import {
  captureContextCompactionAccountingSnapshot,
  shouldCompactBeforeRequest,
} from "../../../src/agent/context-compaction.ts";
import { runAgentTurn } from "../../../src/agent/loop.ts";
import { defaultStopPolicy } from "../../../src/agent/stop-policy.ts";
import type { LLMProvider, Message, ToolCall } from "../../../src/llm/types.ts";
import {
  collect,
  freshSignal,
  workspace,
  ZERO_USAGE,
} from "../../../src/testing/context-compaction-fixtures.ts";
import { toolCallFromParsedArguments } from "../../../src/tools/registry.ts";

type AccountingSnapshot = NonNullable<
  ReturnType<typeof captureContextCompactionAccountingSnapshot>
>;
type AccountingMessageFingerprintCache = NonNullable<
  AccountingSnapshot["messageFingerprintCache"]
>[number];

describe("Context Compaction Accounting", () => {
  test(`Given no context window is configured,
    When a long agent turn starts,
    Then proactive compaction is skipped`, async () => {
    // Given
    const messages: Message[] = [
      { role: "user", content: "Earlier context ".repeat(80) },
      {
        role: "assistant",
        content: "Earlier answer ".repeat(80),
        toolCalls: [],
      },
      { role: "user", content: "Continue." },
    ];
    let summaryRequested = false;
    const provider: LLMProvider = {
      id: "no-window-provider",
      async *stream(options) {
        if (options.toolChoice === "none") {
          summaryRequested = true;
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        yield { type: "text", text: "Continued without compaction." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    // When
    const events = await collect(
      runAgentTurn({
        workspace: workspace(),
        provider,
        messages,
        systemPrompt: "You are helpful.",
        signal: freshSignal(),
        allowBash: false,
        stopPolicy: defaultStopPolicy(),
        contextCompaction: {
          keepRecentTokens: 1,
          reserveTokens: 1,
        },
      }),
    );

    // Then
    expect(summaryRequested).toBe(false);
    expect(events).toContainEqual({
      type: "text",
      text: "Continued without compaction.",
    });
  });

  test(`Given a completed request message is mutated in place after usage accounting,
    When proactive compaction checks the request,
    Then it falls back to the estimated request size`, () => {
    // Given
    const completedMessages: Message[] = [
      { role: "user", content: "Previously completed request." },
    ];
    const accounting = captureContextCompactionAccountingSnapshot({
      systemPrompt: "You are helpful.",
      messages: completedMessages,
      usage: {
        inputTokens: 1,
        cachedInputTokens: 0,
        uncachedInputTokens: 1,
        outputTokens: 1,
      },
    });
    const [completedMessage] = completedMessages;
    if (completedMessage?.role !== "user") {
      throw new Error("test setup expected a user message");
    }
    Object.assign(completedMessage, {
      content: "Mutated completed request ".repeat(80),
    });

    // When
    const shouldCompact = shouldCompactBeforeRequest(
      "You are helpful.",
      completedMessages,
      {
        contextWindowTokens: 100,
        reserveTokens: 0,
      },
      accounting,
    );

    // Then
    expect(shouldCompact).toBe(true);
  });

  test(`Given completed assistant tool call arguments are mutated in place after usage accounting,
    When proactive compaction checks the request,
    Then it falls back to the estimated request size`, () => {
    // Given
    const messages: Message[] = [
      {
        role: "assistant",
        content: "I will update files.",
        toolCalls: [
          {
            id: "edit_note",
            tool: "edit",
            path: "note.txt",
            edits: [{ oldText: "old", newText: "new" }],
          },
          {
            id: "write_log",
            tool: "write",
            path: "log.txt",
            content: "original",
          },
        ],
      },
    ];
    const accounting = captureContextCompactionAccountingSnapshot({
      systemPrompt: "You are helpful.",
      messages,
      usage: {
        inputTokens: 1,
        cachedInputTokens: 0,
        uncachedInputTokens: 1,
        outputTokens: 1,
      },
    });
    const [assistantMessage] = messages;
    const [editToolCall] =
      assistantMessage?.role === "assistant" ? assistantMessage.toolCalls : [];
    if (editToolCall?.tool !== "edit") {
      throw new Error("test setup expected an edit tool call");
    }
    const [edit] = editToolCall.edits;
    if (edit === undefined) {
      throw new Error("test setup expected one edit");
    }
    Object.assign(edit, { newText: "mutated ".repeat(80) });

    // When
    const shouldCompact = shouldCompactBeforeRequest(
      "You are helpful.",
      messages,
      {
        contextWindowTokens: 100,
        reserveTokens: 0,
      },
      accounting,
    );

    // Then
    expect(shouldCompact).toBe(true);
  });

  test(`Given a completed edit tool call gains replaceAll after usage accounting,
    When proactive compaction checks the request,
    Then it treats the cached accounting as stale`, () => {
    // Given
    const messages: Message[] = [
      {
        role: "assistant",
        content: "I will update the file.",
        toolCalls: [
          {
            id: "edit_note",
            tool: "edit",
            path: "note.txt",
            edits: [{ oldText: "old", newText: "new" }],
          },
        ],
      },
    ];
    const accounting = captureContextCompactionAccountingSnapshot({
      systemPrompt: "You are helpful.",
      messages,
      usage: {
        inputTokens: 1,
        cachedInputTokens: 0,
        uncachedInputTokens: 1,
        outputTokens: 1,
      },
    });
    const [assistantMessage] = messages;
    const [editToolCall] =
      assistantMessage?.role === "assistant" ? assistantMessage.toolCalls : [];
    if (editToolCall?.tool !== "edit") {
      throw new Error("test setup expected an edit tool call");
    }
    const [edit] = editToolCall.edits;
    if (edit === undefined) {
      throw new Error("test setup expected one edit");
    }
    Object.assign(edit, { replaceAll: true });

    // When
    const shouldCompact = shouldCompactBeforeRequest(
      "You are helpful.",
      messages,
      {
        contextWindowTokens: 5,
        reserveTokens: 0,
      },
      accounting,
    );

    // Then
    expect(shouldCompact).toBe(true);
  });

  test(`Given equivalent optional tool arguments are omitted undefined or null,
    When context accounting captures tool-call fingerprints,
    Then the fingerprints are canonicalized to the same value`, () => {
    // Given
    const parsedToolCall = (args: unknown): ToolCall => {
      const toolCall = toolCallFromParsedArguments("read_note", "read", args);
      if (toolCall === null) {
        throw new Error("test setup expected parsed read tool call");
      }
      return toolCall;
    };
    const toolCalls = [
      parsedToolCall({ path: "note.txt" }),
      parsedToolCall({
        path: "note.txt",
        offset: undefined,
        limit: undefined,
      }),
      parsedToolCall({ path: "note.txt", offset: null, limit: null }),
    ];

    // When
    const fingerprints = toolCalls.map((toolCall) => {
      const accounting = captureContextCompactionAccountingSnapshot({
        systemPrompt: "You are helpful.",
        messages: [
          {
            role: "assistant",
            content: "I will read the note.",
            toolCalls: [toolCall],
          },
        ],
        usage: {
          inputTokens: 20,
          cachedInputTokens: 0,
          uncachedInputTokens: 20,
          outputTokens: 1,
        },
      });
      if (accounting === undefined) {
        throw new Error("test setup expected accounting");
      }
      return accounting.messageFingerprints;
    });

    // Then
    expect(fingerprints[1]).toEqual(fingerprints[0]);
    expect(fingerprints[2]).toEqual(fingerprints[0]);
  });

  test(`Given a completed tool output is mutated in place after usage accounting,
    When proactive compaction checks the request,
    Then it falls back to the estimated request size`, () => {
    // Given
    const messages: Message[] = [
      {
        role: "tool",
        toolCallId: "run_tests",
        content: "short result",
      },
    ];
    const accounting = captureContextCompactionAccountingSnapshot({
      systemPrompt: "You are helpful.",
      messages,
      usage: {
        inputTokens: 1,
        cachedInputTokens: 0,
        uncachedInputTokens: 1,
        outputTokens: 1,
      },
    });
    const [toolMessage] = messages;
    if (toolMessage?.role !== "tool") {
      throw new Error("test setup expected a tool message");
    }
    Object.assign(toolMessage, {
      content: "mutated tool output ".repeat(80),
    });

    // When
    const shouldCompact = shouldCompactBeforeRequest(
      "You are helpful.",
      messages,
      {
        contextWindowTokens: 100,
        reserveTokens: 0,
      },
      accounting,
    );

    // Then
    expect(shouldCompact).toBe(true);
  });

  test(`Given provider usage accounting captured an unchanged completed prefix,
    When proactive compaction checks a later request,
    Then it avoids rebuilding historical message fingerprints`, () => {
    // Given
    const toolCalls: ToolCall[] = [
      {
        id: "read_package",
        tool: "read",
        path: "package.json",
        offset: 1,
        limit: 200,
      },
      {
        id: "grep_scripts",
        tool: "grep",
        pattern: "scripts",
        path: "package.json",
      },
      {
        id: "list_src",
        tool: "ls",
        path: "src",
        limit: 25,
      },
      {
        id: "list_root",
        tool: "ls",
      },
      {
        id: "glob_tests",
        tool: "glob",
        pattern: "**/*.test.ts",
        path: "tests",
      },
      {
        id: "edit_note",
        tool: "edit",
        path: "notes.txt",
        edits: [{ oldText: "todo", newText: "done" }],
      },
      {
        id: "write_log",
        tool: "write",
        path: "log.txt",
        content: "validated",
      },
      {
        id: "run_test",
        tool: "bash",
        command: "pnpm test",
        timeoutMs: 1_000,
      },
    ];
    const completedMessages: Message[] = [
      { role: "user", content: "Completed prefix ".repeat(80) },
      {
        role: "assistant",
        content: "I will inspect and update the workspace.",
        toolCalls,
      },
      {
        role: "tool",
        toolCallId: "read_package",
        content: '{ "scripts": { "test": "vitest" } }',
      },
    ];
    const accounting = captureContextCompactionAccountingSnapshot({
      systemPrompt: "You are helpful.",
      messages: completedMessages,
      usage: {
        inputTokens: 20,
        cachedInputTokens: 0,
        uncachedInputTokens: 20,
        outputTokens: 1,
      },
    });
    const requestMessages: Message[] = [
      ...completedMessages,
      { role: "user", content: "Continue with the next step." },
    ];
    const stringifySpy = vi.spyOn(JSON, "stringify");

    // When
    const shouldCompact = shouldCompactBeforeRequest(
      "You are helpful.",
      requestMessages,
      {
        contextWindowTokens: 200,
        reserveTokens: 0,
      },
      accounting,
    );

    // Then
    const stringifyCalls = stringifySpy.mock.calls.length;
    stringifySpy.mockRestore();
    expect(shouldCompact).toBe(false);
    expect(stringifyCalls).toBe(0);
  });

  test(`Given a legacy accounting snapshot has no fingerprint cache,
    When proactive compaction checks a matching later request,
    Then it still accepts the provider usage snapshot`, () => {
    // Given
    const completedMessages: Message[] = [
      { role: "user", content: "Completed request ".repeat(80) },
    ];
    const accounting = captureContextCompactionAccountingSnapshot({
      systemPrompt: "You are helpful.",
      messages: completedMessages,
      usage: {
        inputTokens: 20,
        cachedInputTokens: 0,
        uncachedInputTokens: 20,
        outputTokens: 1,
      },
    });
    if (accounting === undefined) {
      throw new Error("test setup expected accounting");
    }
    const { messageFingerprintCache, ...legacyAccounting } = accounting;
    const requestMessages: Message[] = [
      ...completedMessages,
      { role: "user", content: "Continue." },
    ];

    // When
    const shouldCompact = shouldCompactBeforeRequest(
      "You are helpful.",
      requestMessages,
      {
        contextWindowTokens: 200,
        reserveTokens: 0,
      },
      legacyAccounting,
    );

    // Then
    expect(messageFingerprintCache).toBeDefined();
    expect(shouldCompact).toBe(false);
  });

  test(`Given assistant reasoning metadata is provider-visible replay content,
    When proactive compaction estimates the request,
    Then reasoning metadata contributes to the context budget`, () => {
    // Given
    const messages: Message[] = [
      { role: "user", content: "Continue." },
      {
        role: "assistant",
        content: "I inspected the file.",
        providerMetadata: {
          openaiCompatible: {
            reasoningContent: "large reasoning ".repeat(200),
          },
        },
        toolCalls: [],
      },
    ];

    // When
    const shouldCompact = shouldCompactBeforeRequest(
      "You are helpful.",
      messages,
      {
        contextWindowTokens: 200,
        reserveTokens: 0,
      },
    );

    // Then
    expect(shouldCompact).toBe(true);
  });

  test(`Given cached accounting was captured before assistant reasoning metadata changed,
    When proactive compaction checks the updated request,
    Then it ignores the stale cache and re-estimates the reasoning metadata`, () => {
    // Given
    const previousMessages: Message[] = [
      { role: "user", content: "Continue." },
      {
        role: "assistant",
        content: "I inspected the file.",
        providerMetadata: {
          openaiCompatible: {
            reasoningContent: "short reasoning",
          },
        },
        toolCalls: [],
      },
    ];
    const accounting = captureContextCompactionAccountingSnapshot({
      systemPrompt: "You are helpful.",
      messages: previousMessages,
      usage: {
        inputTokens: 1,
        cachedInputTokens: 0,
        uncachedInputTokens: 1,
        outputTokens: 1,
      },
    });
    if (accounting === undefined) {
      throw new Error("test setup expected accounting");
    }
    const updatedMessages: Message[] = [
      { role: "user", content: "Continue." },
      {
        role: "assistant",
        content: "I inspected the file.",
        providerMetadata: {
          openaiCompatible: {
            reasoningContent: "large reasoning ".repeat(200),
          },
        },
        toolCalls: [],
      },
    ];

    // When
    const shouldCompact = shouldCompactBeforeRequest(
      "You are helpful.",
      updatedMessages,
      {
        contextWindowTokens: 200,
        reserveTokens: 0,
      },
      accounting,
    );

    // Then
    expect(shouldCompact).toBe(true);
  });

  test.each([
    {
      label: "user message",
      messages: [{ role: "user", content: "Completed request ".repeat(80) }],
      mismatchedCache: {
        role: "assistant",
        content: "stale",
        providerMetadata: null,
        toolCalls: [],
        fingerprint: "stale",
      },
    },
    {
      label: "assistant message",
      messages: [
        {
          role: "assistant",
          content: "Completed assistant response ".repeat(80),
          toolCalls: [],
        },
      ],
      mismatchedCache: {
        role: "tool",
        toolCallId: "stale",
        content: "stale",
        fingerprint: "stale",
      },
    },
    {
      label: "tool message",
      messages: [
        {
          role: "tool",
          toolCallId: "run_tests",
          content: "Completed tool output ".repeat(80),
        },
      ],
      mismatchedCache: {
        role: "user",
        content: "stale",
        fingerprint: "stale",
      },
    },
  ] satisfies readonly {
    readonly label: string;
    readonly messages: Message[];
    readonly mismatchedCache: AccountingMessageFingerprintCache;
  }[])(`Given accounting fingerprint cache metadata has the wrong role for $label,
    When proactive compaction checks a matching request,
    Then it falls back to the canonical message fingerprint`, ({
    messages,
    mismatchedCache,
  }) => {
    // Given
    const accounting = captureContextCompactionAccountingSnapshot({
      systemPrompt: "You are helpful.",
      messages,
      usage: {
        inputTokens: 1,
        cachedInputTokens: 0,
        uncachedInputTokens: 1,
        outputTokens: 1,
      },
    });
    if (accounting === undefined) {
      throw new Error("test setup expected accounting");
    }
    const corruptedAccounting = {
      ...accounting,
      messageFingerprintCache: [mismatchedCache],
    };

    // When
    const shouldCompact = shouldCompactBeforeRequest(
      "You are helpful.",
      messages,
      {
        contextWindowTokens: 100,
        reserveTokens: 0,
      },
      corruptedAccounting,
    );

    // Then
    expect(shouldCompact).toBe(false);
  });

  test(`Given provider usage was captured for a tool-enabled request,
    When a text-only wrap-up request checks proactive compaction,
    Then it treats the usage as ambiguous and falls back to the estimate`, () => {
    // Given
    const messages: Message[] = [
      { role: "user", content: "Previously completed request ".repeat(80) },
    ];
    const accounting = captureContextCompactionAccountingSnapshot({
      systemPrompt: "You are helpful.",
      messages,
      usage: {
        inputTokens: 1,
        cachedInputTokens: 0,
        uncachedInputTokens: 1,
        outputTokens: 1,
      },
    });

    // When
    const shouldCompact = shouldCompactBeforeRequest(
      "You are helpful.",
      messages,
      {
        contextWindowTokens: 100,
        reserveTokens: 0,
      },
      accounting,
      { toolChoice: "none" },
    );

    // Then
    expect(shouldCompact).toBe(true);
  });

  test(`Given provider usage was captured with bash tool exposure,
    When proactive compaction checks a request without bash exposure,
    Then it treats the request shape as ambiguous and falls back to the estimate`, () => {
    // Given
    const messages: Message[] = [
      { role: "user", content: "Previously completed request ".repeat(80) },
    ];
    const accounting = captureContextCompactionAccountingSnapshot({
      systemPrompt: "You are helpful.",
      messages,
      usage: {
        inputTokens: 1,
        cachedInputTokens: 0,
        uncachedInputTokens: 1,
        outputTokens: 1,
      },
      requestMetadata: { allowBash: true },
    });

    // When
    const shouldCompact = shouldCompactBeforeRequest(
      "You are helpful.",
      messages,
      {
        contextWindowTokens: 100,
        reserveTokens: 0,
      },
      accounting,
      { allowBash: false },
    );

    // Then
    expect(shouldCompact).toBe(true);
  });

  test(`Given provider usage was captured for a text-only request with bash enabled,
    When another text-only request checks proactive compaction without bash enabled,
    Then it reuses accounting because no tools are exposed`, () => {
    // Given
    const messages: Message[] = [
      { role: "user", content: "Previously completed request ".repeat(80) },
    ];
    const accounting = captureContextCompactionAccountingSnapshot({
      systemPrompt: "You are helpful.",
      messages,
      usage: {
        inputTokens: 1,
        cachedInputTokens: 0,
        uncachedInputTokens: 1,
        outputTokens: 1,
      },
      requestMetadata: { allowBash: true, toolChoice: "none" },
    });

    // When
    const shouldCompact = shouldCompactBeforeRequest(
      "You are helpful.",
      messages,
      {
        contextWindowTokens: 100,
        reserveTokens: 0,
      },
      accounting,
      { allowBash: false, toolChoice: "none" },
    );

    // Then
    expect(shouldCompact).toBe(false);
  });

  test.each([
    0,
    Number.POSITIVE_INFINITY,
  ])(`Given provider usage contains unusable input token count %s,
    When compaction accounting is captured,
    Then no accounting snapshot is recorded`, (inputTokens) => {
    // Given
    const messages: Message[] = [
      { role: "user", content: "Completed request." },
    ];

    // When
    const accounting = captureContextCompactionAccountingSnapshot({
      systemPrompt: "You are helpful.",
      messages,
      usage: {
        inputTokens,
        cachedInputTokens: 0,
        uncachedInputTokens: 0,
        outputTokens: 1,
      },
    });

    // Then
    expect(accounting).toBeUndefined();
  });
});
