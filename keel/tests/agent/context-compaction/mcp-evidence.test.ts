import { describe, expect, test } from "vitest";
import { collectToolCompactionEvidence } from "../../../src/agent/context-compaction.ts";
import type { SessionMessage } from "../../../src/agent/session-message.ts";

describe("Context Compaction MCP Evidence", () => {
  test(`Given a dynamic MCP result is too large for summary input,
    When compaction derives a rerunnable evidence handle,
    Then it never treats the external call as a local source handle`, async () => {
    // Given
    const messages: readonly SessionMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            kind: "mcp",
            id: "remote_search",
            tool: "mcp__catalog__search",
            reference: {
              kind: "mcp",
              serverId: "catalog",
              serverOrigin: "https://catalog.example",
              rawToolName: "search",
              configurationDigest: "a".repeat(64),
              catalogGeneration: `catalog:${"b".repeat(64)}`,
              descriptorDigest: "c".repeat(64),
            },
            arguments: { query: "otters" },
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "remote_search",
        content: "external result omitted from the summary",
      },
    ];

    // When
    const evidence = await collectToolCompactionEvidence(messages, 4);

    // Then
    expect(evidence).toEqual([
      expect.objectContaining({
        handle: "tool-call:remote_search",
        source: "complete",
      }),
    ]);
  });
});
