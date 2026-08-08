import { describe, expect, test } from "vitest";
import { emptyRunAccounting } from "../../src/agent/accounting.ts";
import {
  projectSessionLedgerToProviderMessages,
  sessionLedgerFromMessages,
  sessionLedgerMessages,
} from "../../src/agent/session-ledger.ts";
import type { SessionMessage } from "../../src/agent/session-message.ts";
import { streamTurnWithOverflowRecovery } from "../../src/agent/turn-compaction.ts";
import { KeelError } from "../../src/core/error.ts";
import type { LLMProvider, ProviderMessage } from "../../src/llm/types.ts";
import {
  collect,
  freshSignal,
  ZERO_USAGE,
} from "../../src/testing/context-compaction-fixtures.ts";

describe("Turn Compaction", () => {
  test(`Given a truncated proactive summary is billed before its retry fails,
    When compaction stops with the provider error,
    Then the billed attempt is accounted and the original ledger remains unchanged`, async () => {
    // Given
    const originalMessages: SessionMessage[] = [
      {
        role: "user",
        content: `Remember constraint alpha. ${"alpha ".repeat(400)}`,
        origin: { type: "user_prompt" },
      },
      {
        role: "assistant",
        content: "Constraint alpha recorded.",
        toolCalls: [],
      },
      {
        role: "user",
        content: "Remember decision beta.",
        origin: { type: "steer" },
      },
      { role: "assistant", content: "Decision beta recorded.", toolCalls: [] },
      { role: "user", content: "Continue.", origin: { type: "steer" } },
    ];
    const ledger = sessionLedgerFromMessages(originalMessages);
    const retryError = new KeelError(
      "provider_server_error",
      "Summary retry failed upstream",
    );
    let summaryRequests = 0;
    const provider: LLMProvider = {
      id: "billed-summary-failure-provider",
      async *stream(options) {
        if (options.toolExposure?.kind !== "none") {
          throw new Error("main request must not start after summary failure");
        }
        summaryRequests++;
        if (summaryRequests === 1) {
          yield { type: "text", text: "Partial billed checkpoint" };
          yield {
            type: "stop",
            reason: "length",
            usage: {
              inputTokens: 10,
              cachedInputTokens: 0,
              uncachedInputTokens: 10,
              outputTokens: 2,
            },
          };
          return;
        }
        throw retryError;
      },
    };
    const state = {
      contextAccounting: undefined,
      accounting: emptyRunAccounting(),
    };

    // When / Then
    await expect(
      collect(
        streamTurnWithOverflowRecovery(
          {
            provider,
            systemPrompt: "You are helpful.",
            signal: freshSignal(),
            contextCompaction: {
              contextWindowTokens: 120,
              reserveTokens: 0,
              keepRecentTokens: 1,
            },
            costTracking: undefined,
            modelOperations: null,
            onContextCompacted: async () => {
              throw new Error("failed summary must not commit");
            },
          },
          state,
          {
            provider,
            systemPrompt: "You are helpful.",
            signal: freshSignal(),
            toolExposure: { kind: "auto" },
            modelOperation: null,
            ledger,
          },
        ),
      ),
    ).rejects.toBe(retryError);
    expect(summaryRequests).toBe(2);
    expect(state.accounting.totalUsage).toEqual({
      inputTokens: 10,
      cachedInputTokens: 0,
      uncachedInputTokens: 10,
      outputTokens: 2,
    });
    expect(sessionLedgerMessages(ledger)).toEqual(originalMessages);
  });

  test(`Given proactive compaction only produces length-truncated summaries,
    When the agent continues the turn,
    Then no compaction event is emitted and the original ledger remains provider-visible`, async () => {
    // Given
    const originalMessages: SessionMessage[] = [
      {
        role: "user",
        content: `Remember constraint alpha. ${"alpha ".repeat(400)}`,
        origin: { type: "user_prompt" },
      },
      {
        role: "assistant",
        content: "Constraint alpha recorded.",
        toolCalls: [],
      },
      {
        role: "user",
        content: "Remember decision beta.",
        origin: { type: "steer" },
      },
      { role: "assistant", content: "Decision beta recorded.", toolCalls: [] },
      {
        role: "user",
        content: "Remember evidence gamma.",
        origin: { type: "steer" },
      },
      { role: "assistant", content: "Evidence gamma recorded.", toolCalls: [] },
      { role: "user", content: "Continue.", origin: { type: "steer" } },
    ];
    const ledger = sessionLedgerFromMessages(originalMessages);
    let summaryRequests = 0;
    let finalRequestMessages: readonly ProviderMessage[] = [];
    const provider: LLMProvider = {
      id: "truncated-turn-compaction-provider",
      async *stream(options) {
        if (options.toolExposure?.kind === "none") {
          summaryRequests++;
          yield { type: "text", text: "Partial checkpoint" };
          yield {
            type: "stop",
            reason: "length",
            usage: {
              inputTokens: 10,
              cachedInputTokens: 0,
              uncachedInputTokens: 10,
              outputTokens: 2,
            },
          };
          return;
        }
        finalRequestMessages = options.messages;
        yield { type: "text", text: "Continuing from original history." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const state = {
      contextAccounting: undefined,
      accounting: emptyRunAccounting(),
    };

    // When
    const events = await collect(
      streamTurnWithOverflowRecovery(
        {
          provider,
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          contextCompaction: {
            contextWindowTokens: 120,
            reserveTokens: 0,
            keepRecentTokens: 1,
          },
          costTracking: undefined,
          modelOperations: null,
          onContextCompacted: async () => ({ rollback: () => {} }),
        },
        state,
        {
          provider,
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          toolExposure: { kind: "auto" },
          modelOperation: null,
          ledger,
        },
      ),
    );

    // Then
    expect(summaryRequests).toBe(2);
    expect(events.some((event) => event.type === "context_compacted")).toBe(
      false,
    );
    expect(finalRequestMessages).toEqual(
      projectSessionLedgerToProviderMessages(
        sessionLedgerFromMessages(originalMessages),
      ),
    );
    expect(sessionLedgerMessages(ledger)).toEqual(originalMessages);
    expect(state.accounting.totalUsage).toEqual({
      inputTokens: 20,
      cachedInputTokens: 0,
      uncachedInputTokens: 20,
      outputTokens: 4,
    });
  });

  test(`Given turn compaction has no task progress provider,
    When proactive compaction summarizes history,
    Then the compacted checkpoint does not invent a task progress section`, async () => {
    // Given
    const ledger = sessionLedgerFromMessages([
      {
        role: "user",
        content: `Investigate ${"alpha ".repeat(400)}`,
        origin: { type: "user_prompt" },
      },
      {
        role: "assistant",
        content: "Alpha is caused by stale config.",
        toolCalls: [],
      },
      {
        role: "user",
        content: "Continue.",
        origin: { type: "steer" },
      },
    ]);
    let summaryPrompt = "";
    let finalRequestMessages: readonly ProviderMessage[] = [];
    const provider: LLMProvider = {
      id: "turn-compaction-provider",
      async *stream(options) {
        if (options.toolExposure?.kind === "none") {
          summaryPrompt = options.messages[0]?.content ?? "";
          yield { type: "text", text: "Alpha summary." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        finalRequestMessages = options.messages;
        yield { type: "text", text: "Continuing." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    // When
    const events = await collect(
      streamTurnWithOverflowRecovery(
        {
          provider,
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          contextCompaction: {
            contextWindowTokens: 120,
            reserveTokens: 0,
            keepRecentTokens: 1,
          },
          costTracking: undefined,
          modelOperations: null,
          onContextCompacted: async () => ({ rollback: () => {} }),
        },
        {
          contextAccounting: undefined,
          accounting: emptyRunAccounting(),
        },
        {
          provider,
          systemPrompt: "You are helpful.",
          signal: freshSignal(),
          toolExposure: { kind: "auto" },
          modelOperation: null,
          ledger,
        },
      ),
    );

    // Then
    expect(
      events.some(
        (event) =>
          event.type === "context_compacted" && event.reason === "proactive",
      ),
    ).toBe(true);
    expect(summaryPrompt).toContain("Alpha is caused by stale config.");
    expect(finalRequestMessages[0]?.content).toContain(
      "<conversation-checkpoint>",
    );
    expect(finalRequestMessages[0]?.content).not.toContain(
      "Session Task Progress",
    );
    expect(finalRequestMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "Continue." }),
      ]),
    );
    expect(finalRequestMessages).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ origin: expect.anything() }),
      ]),
    );
    expect(sessionLedgerMessages(ledger)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          origin: { type: "compaction_checkpoint" },
        }),
        expect.objectContaining({
          role: "user",
          content: "Continue.",
          origin: { type: "steer" },
        }),
      ]),
    );
  });
});
