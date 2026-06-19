import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { executeToolCall } from "../../src/tools/execution.ts";

const EDIT_FILE_SIZE_LIMIT_BYTES = 10 * 1024 * 1024;

describe("Tool Execution", () => {
  test(`Given an edit tool call targets an oversized file,
    When the tool execution layer handles the call,
    Then it reports a recoverable tool failure instead of rethrowing`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-tool-execution-"));
    const filePath = join(workspace, "large.log");
    await writeFile(filePath, "");
    await truncate(filePath, EDIT_FILE_SIZE_LIMIT_BYTES + 1);

    try {
      // When
      const result = await executeToolCall({
        workspace,
        toolCall: {
          id: "edit_1",
          tool: "edit",
          path: "large.log",
          oldString: "old",
          newString: "new",
        },
        signal: new AbortController().signal,
        allowBash: false,
      });

      // Then
      expect(result.ok).toBe(false);
      expect(result.content).toContain("Tool failed:");
      expect(result.content).toContain("file is too large");
      expect(result.content).toContain("Recovery:");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

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
