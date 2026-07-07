import { describe, expect, test } from "vitest";
import { emptyRunAccounting } from "../../src/agent/accounting.ts";
import { sessionLedgerFromMessages } from "../../src/agent/session-ledger.ts";
import { streamTurnWithOverflowRecovery } from "../../src/agent/turn-compaction.ts";
import type { LLMProvider, Message } from "../../src/llm/types.ts";
import {
  collect,
  freshSignal,
  ZERO_USAGE,
} from "../../src/testing/context-compaction-fixtures.ts";

describe("Turn Compaction", () => {
  test(`Given turn compaction has no task progress provider,
    When proactive compaction summarizes history,
    Then the compacted checkpoint does not invent a task progress section`, async () => {
    // Given
    let ledger = sessionLedgerFromMessages([
      { role: "user", content: `Investigate ${"alpha ".repeat(400)}` },
      {
        role: "assistant",
        content: "Alpha is caused by stale config.",
        toolCalls: [],
      },
      { role: "user", content: "Continue." },
    ]);
    let summaryPrompt = "";
    let finalRequestMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "turn-compaction-provider",
      async *stream(options) {
        if (options.toolChoice === "none") {
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
          allowBash: false,
          getLedger: () => ledger,
          setLedger: (next) => {
            ledger = next;
          },
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
  });
});
