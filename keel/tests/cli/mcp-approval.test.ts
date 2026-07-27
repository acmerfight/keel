import { describe, expect, test } from "vitest";
import type { LineReader } from "../../src/cli/interactive-session/line-reader.ts";
import {
  createPromptedMcpPermissionPolicy,
  denyMcpPermissionPolicy,
} from "../../src/cli/mcp-approval.ts";

function lineReaderReturning(answer: string | null): LineReader {
  return {
    readLine: async () => null,
    readLineAfter: async () => answer,
    drainLinesAfter: () => [],
    restoreLines: () => {},
    sequence: () => 7,
    needsInput: () => true,
    pendingInputCount: () => 0,
  };
}

const request = {
  origin: "https://catalog.example",
  serverId: "catalog",
  rawToolName: "search",
  arguments: { query: "otters" },
  signal: new AbortController().signal,
};

describe("MCP Approval", () => {
  test.each([
    ["y", { type: "allow" }],
    [" YES ", { type: "allow" }],
    [
      "n",
      {
        type: "deny",
        message: "User did not approve this MCP tool call.",
      },
    ],
    [
      null,
      {
        type: "deny",
        message: "MCP approval was interrupted or input closed.",
      },
    ],
  ] as const)(
    `Given a prompted MCP call receives answer %j,
    When the exact one-call approval is reviewed,
    Then the adapter returns the fail-closed decision and restores steering mode`,
    async (answer, expected) => {
      // Given
      let stderr = "";
      const lifecycle: string[] = [];
      const policy = createPromptedMcpPermissionPolicy(
        lineReaderReturning(answer),
        (text) => {
          stderr += text;
        },
        {
          onPromptStart: () => lifecycle.push("approval"),
          onPromptEnd: () => lifecycle.push("steer"),
        },
      );

      // When
      const decision = await policy.review(request);

      // Then
      expect(decision).toEqual(expected);
      expect(stderr).toContain("Approve MCP tool call?");
      expect(stderr).toContain("origin: https://catalog.example");
      expect(stderr).toContain("tool: catalog/search");
      expect(lifecycle).toEqual(["approval", "steer"]);
    },
  );

  test(`Given a session cannot prompt,
    When an MCP call asks for approval,
    Then the configured deny policy fails closed without external input`, () => {
    expect(
      denyMcpPermissionPolicy("terminal required").review(request),
    ).toEqual({
      type: "deny",
      message: "terminal required",
    });
  });
});
