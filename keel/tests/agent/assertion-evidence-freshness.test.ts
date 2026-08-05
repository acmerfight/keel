import { describe, expect, test } from "vitest";
import { assertionEvidenceResourceFreshness } from "../../src/agent/assertion-evidence-freshness.ts";
import type { SessionMessage } from "../../src/agent/session-message.ts";

describe("Assertion Evidence Freshness", () => {
  test(`Given a historical read result has no Runtime observation,
    When assertion evidence is prepared for evaluation,
    Then the read is marked unverifiable instead of being treated as current`, () => {
    // Given
    const messages: readonly SessionMessage[] = [
      { role: "user", content: "Inspect missing.txt." },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "read_1", tool: "read", path: "missing.txt" },
          { id: "goal_1", tool: "update_goal", status: "completed" },
        ],
      },
      {
        role: "tool",
        toolCallId: "read_1",
        content: "Tool failed: read failed: file not found: missing.txt",
      },
      {
        role: "tool",
        toolCallId: "goal_1",
        content: "Completion proposed.",
      },
    ];

    // When
    const freshness = assertionEvidenceResourceFreshness({
      workspace: process.cwd(),
      messages,
    });

    // Then
    expect(freshness).toEqual([
      {
        toolCallId: "read_1",
        kind: "read_projection",
        status: "unverifiable",
        reason:
          "Runtime has no resource observation for this historical read result.",
      },
    ]);
  });
});
