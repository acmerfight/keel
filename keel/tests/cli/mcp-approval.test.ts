import { describe, expect, test } from "vitest";
import type { LineReader } from "../../src/cli/interactive-session/line-reader.ts";
import { createPromptedMcpPermissionPolicy } from "../../src/cli/mcp-approval.ts";

function lineReaderReturning(...answers: readonly (string | null)[]): {
  readonly lineReader: LineReader;
  readonly reads: () => number;
} {
  let index = 0;
  return {
    lineReader: {
      readLine: async () => null,
      readLineAfter: async () => answers[index++] ?? null,
      drainLinesAfter: () => [],
      restoreLines: () => {},
      sequence: () => 7,
      needsInput: () => true,
      pendingInputCount: () => 0,
      dispose: () => {},
    },
    reads: () => index,
  };
}

const request = {
  origin: "https://catalog.example",
  serverId: "catalog",
  configurationDigest: "a".repeat(64),
  rawToolName: "search",
  descriptorDigest: "b".repeat(64),
  authorizationIdentity: { kind: "anonymous" },
  arguments: { query: "otters" },
  signal: new AbortController().signal,
} as const;

describe("prompted MCP permission policy", () => {
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
      "s",
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
    `Given a reviewed MCP call receives answer %j,
    When the exact one-call approval is reviewed,
    Then only explicit one-time approval allows it and steering mode is restored`,
    async (answer, expected) => {
      // Given
      let stderr = "";
      const lifecycle: string[] = [];
      const input = lineReaderReturning(answer);
      const policy = createPromptedMcpPermissionPolicy(
        input.lineReader,
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
      expect(stderr).toContain(`configuration: sha256:${"a".repeat(64)}`);
      expect(stderr).toContain(`descriptor: sha256:${"b".repeat(64)}`);
      expect(stderr).toContain("[y] allow once, [n] deny");
      expect(stderr).not.toContain("save");
      expect(lifecycle).toEqual(["approval", "steer"]);
    },
  );

  test(`Given two identical reviewed MCP calls,
    When the first call is allowed once,
    Then the second call still requires a new exact approval`, async () => {
    // Given
    const input = lineReaderReturning("y", "n");
    const policy = createPromptedMcpPermissionPolicy(
      input.lineReader,
      () => {},
    );

    // When
    const first = await policy.review(request);
    const second = await policy.review(request);

    // Then
    expect(first).toEqual({ type: "allow" });
    expect(second).toEqual({
      type: "deny",
      message: "User did not approve this MCP tool call.",
    });
    expect(input.reads()).toBe(2);
  });
});
