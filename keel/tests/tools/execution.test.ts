import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { executeToolCall } from "../../src/tools/execution.ts";

const EDIT_FILE_SIZE_LIMIT_BYTES = 10 * 1024 * 1024;

describe("Tool Execution", () => {
  test(`Given a glob tool call has a recoverable input error,
    When the tool execution layer handles the call,
    Then it returns a tool failure message for the next model turn`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-tool-execution-"));

    try {
      // When
      const result = await executeToolCall({
        workspace,
        toolCall: {
          id: "glob_1",
          tool: "glob",
          pattern: "",
        },
        signal: new AbortController().signal,
        allowBash: false,
      });

      // Then
      expect(result.ok).toBe(false);
      expect(result.content).toContain("Tool failed:");
      expect(result.content).toContain("pattern is empty");
      expect(result.content).toContain("Recovery:");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an ls tool call targets a file,
    When the tool execution layer handles the call,
    Then it returns a recoverable tool failure message for the next model turn`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-tool-execution-"));
    await writeFile(join(workspace, "note.txt"), "hello\n", "utf8");

    try {
      // When
      const result = await executeToolCall({
        workspace,
        toolCall: {
          id: "ls_1",
          tool: "ls",
          path: "note.txt",
        },
        signal: new AbortController().signal,
        allowBash: false,
      });

      // Then
      expect(result.ok).toBe(false);
      expect(result.content).toContain("Tool failed:");
      expect(result.content).toContain("not a directory");
      expect(result.content).toContain("Recovery:");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an ls tool call lists the workspace with only a limit,
    When the tool execution layer handles the call,
    Then it executes the ls tool without serializing a path`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-tool-execution-"));
    await writeFile(join(workspace, "note.txt"), "hello\n", "utf8");

    try {
      // When
      const result = await executeToolCall({
        workspace,
        toolCall: {
          id: "ls_1",
          tool: "ls",
          limit: 1,
        },
        signal: new AbortController().signal,
        allowBash: false,
      });

      // Then
      expect(result).toEqual({
        ok: true,
        content: "note.txt",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")(
    `Given an ls tool call hits an unreadable directory,
    When the tool execution layer handles the call,
    Then it rethrows the fatal filesystem error instead of reporting recoverable output`,
    async () => {
      // Given
      const workspace = await mkdtemp(join(tmpdir(), "keel-tool-execution-"));
      const lockedPath = join(workspace, "locked");
      await mkdir(lockedPath);
      await chmod(lockedPath, 0);

      try {
        // When / Then
        await expect(
          executeToolCall({
            workspace,
            toolCall: {
              id: "ls_1",
              tool: "ls",
              path: "locked",
            },
            signal: new AbortController().signal,
            allowBash: false,
          }),
        ).rejects.toMatchObject({ code: "EACCES" });
      } finally {
        await chmod(lockedPath, 0o700);
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    `Given a glob tool call hits a ripgrep filesystem failure,
    When the tool execution layer handles the call,
    Then it rethrows the fatal tool error instead of converting it to model-recoverable output`,
    async () => {
      // Given
      const workspace = await mkdtemp(join(tmpdir(), "keel-tool-execution-"));
      const lockedPath = join(workspace, "locked");
      await mkdir(lockedPath);
      await chmod(lockedPath, 0);

      try {
        // When / Then
        await expect(
          executeToolCall({
            workspace,
            toolCall: {
              id: "glob_1",
              tool: "glob",
              pattern: "**/*.ts",
            },
            signal: new AbortController().signal,
            allowBash: false,
          }),
        ).rejects.toMatchObject({
          name: "KeelError",
          code: "tool_unavailable",
          message: expect.stringContaining("ripgrep exited with code 2"),
        });
      } finally {
        await chmod(lockedPath, 0o700);
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

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
          edits: [{ oldText: "old", newText: "new" }],
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
          edits: [{ oldText: "old", newText: "new" }],
        },
        signal: new AbortController().signal,
        allowBash: false,
      }),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
