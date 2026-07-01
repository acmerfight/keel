import { describe, expect, test } from "vitest";
import {
  settleOversizedToolOutput,
  type ToolOutputArtifactSaveInput,
  type ToolOutputArtifactStore,
} from "../../src/agent/tool-output-artifacts.ts";

describe("Agent Tool Output Artifacts", () => {
  test(`Given a tool output fits the inline budget,
    When Keel settles the output,
    Then the content stays inline without saving an artifact`, async () => {
    // Given
    const saved: ToolOutputArtifactSaveInput[] = [];
    const store: ToolOutputArtifactStore = {
      save: async (input) => {
        saved.push(input);
        return { status: "stored", ref: "tool-output:test/1" };
      },
    };

    // When
    const result = await settleOversizedToolOutput({
      store,
      maxInlineChars: 128,
      toolCallId: "read_small_file",
      toolName: "read",
      content: "small output",
      sourceStatus: "complete",
      purpose: "settlement",
    });

    // Then
    expect(result).toEqual({ content: "small output" });
    expect(saved).toEqual([]);
  });
});
