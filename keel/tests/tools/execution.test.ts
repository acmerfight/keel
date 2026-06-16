import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { executeToolCall } from "../../src/tools/execution.ts";

describe("Tool Execution", () => {
  test(`Given an edit tool call hits an unexpected filesystem error,
    When the tool execution layer handles the call,
    Then it rethrows the original error instead of reporting recoverable output`, async () => {
    // Given
    const workspace = join(
      tmpdir(),
      `keel-tool-execution-missing-${crypto.randomUUID()}`,
    );

    // When / Then
    await expect(
      executeToolCall({
        workspace,
        toolCall: {
          id: "edit_1",
          tool: "edit",
          path: "note.txt",
          oldString: "old",
          newString: "new",
        },
        signal: new AbortController().signal,
        allowBash: false,
      }),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
