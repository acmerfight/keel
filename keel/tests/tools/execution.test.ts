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
const SHELL_ENV_KEY = "SHELL";

function expectRecoverableToolFailure(
  result: Awaited<ReturnType<typeof executeToolCall>>,
  message: string,
): void {
  expect(result.ok).toBe(false);
  expect(result.content).toContain("Tool failed:");
  expect(result.content).toContain(message);
  expect(result.content).toContain("Recovery:");
}

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
    Then it returns recoverable output for the next model turn`,
    async () => {
      // Given
      const workspace = await mkdtemp(join(tmpdir(), "keel-tool-execution-"));
      const lockedPath = join(workspace, "locked");
      await mkdir(lockedPath);
      await chmod(lockedPath, 0);

      try {
        // When
        const result = await executeToolCall({
          workspace,
          toolCall: {
            id: "ls_1",
            tool: "ls",
            path: "locked",
          },
          signal: new AbortController().signal,
          allowBash: false,
        });

        // Then
        expectRecoverableToolFailure(result, "permission denied");
      } finally {
        await chmod(lockedPath, 0o700);
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    `Given a glob tool call hits a ripgrep filesystem failure,
    When the tool execution layer handles the call,
    Then it returns recoverable output for the next model turn`,
    async () => {
      // Given
      const workspace = await mkdtemp(join(tmpdir(), "keel-tool-execution-"));
      const lockedPath = join(workspace, "locked");
      await mkdir(lockedPath);
      await chmod(lockedPath, 0);

      try {
        // When
        const result = await executeToolCall({
          workspace,
          toolCall: {
            id: "glob_1",
            tool: "glob",
            pattern: "**/*.ts",
          },
          signal: new AbortController().signal,
          allowBash: false,
        });

        // Then
        expectRecoverableToolFailure(result, "ripgrep exited with code 2");
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
    Then it returns recoverable output for the next model turn`, async () => {
    // Given
    const workspace = join(
      tmpdir(),
      `keel-tool-execution-missing-${crypto.randomUUID()}`,
    );

    // When
    const result = await executeToolCall({
      workspace,
      toolCall: {
        id: "edit_1",
        tool: "edit",
        path: "note.txt",
        edits: [{ oldText: "old", newText: "new" }],
      },
      signal: new AbortController().signal,
      allowBash: false,
    });

    // Then
    expectRecoverableToolFailure(result, "ENOENT");
  });

  test.skipIf(process.platform === "win32")(
    `Given read and edit hit unreadable files,
    When the tool execution layer handles the calls,
    Then each failure is returned to the model instead of thrown`,
    async () => {
      // Given
      const workspace = await mkdtemp(join(tmpdir(), "keel-tool-execution-"));
      const lockedPath = join(workspace, "locked.txt");
      await writeFile(lockedPath, "secret\n", "utf8");
      await chmod(lockedPath, 0);

      try {
        // When
        const readResult = await executeToolCall({
          workspace,
          toolCall: {
            id: "read_1",
            tool: "read",
            path: "locked.txt",
          },
          signal: new AbortController().signal,
          allowBash: false,
        });
        const editResult = await executeToolCall({
          workspace,
          toolCall: {
            id: "edit_1",
            tool: "edit",
            path: "locked.txt",
            edits: [{ oldText: "secret", newText: "public" }],
          },
          signal: new AbortController().signal,
          allowBash: false,
        });

        // Then
        expectRecoverableToolFailure(readResult, "permission denied");
        expectRecoverableToolFailure(editResult, "permission denied");
      } finally {
        await chmod(lockedPath, 0o600);
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

  test(`Given grep receives a pattern with a NUL byte,
    When the tool execution layer handles the call,
    Then it returns recoverable output for the next model turn`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-tool-execution-"));

    try {
      // When
      const result = await executeToolCall({
        workspace,
        toolCall: {
          id: "grep_1",
          tool: "grep",
          pattern: "a\u0000b",
        },
        signal: new AbortController().signal,
        allowBash: false,
      });

      // Then
      expectRecoverableToolFailure(result, "null bytes");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given bash cannot start the configured shell,
    When the tool execution layer handles the call,
    Then it preserves the tool-specific recovery guidance`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-tool-execution-"));
    const previousShell = process.env[SHELL_ENV_KEY];
    process.env[SHELL_ENV_KEY] = join(workspace, "missing-shell");

    try {
      // When
      const result = await executeToolCall({
        workspace,
        toolCall: {
          id: "bash_1",
          tool: "bash",
          command: "echo hi",
        },
        signal: new AbortController().signal,
        allowBash: true,
      });

      // Then
      expectRecoverableToolFailure(result, "could not start shell");
      expect(result.content).toContain(
        "Verify the workspace directory exists and is accessible, or use file tools instead.",
      );
    } finally {
      if (previousShell === undefined) {
        delete process.env[SHELL_ENV_KEY];
      } else {
        process.env[SHELL_ENV_KEY] = previousShell;
      }
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given write receives invalid filesystem paths,
    When the tool execution layer handles the calls,
    Then each failure is returned to the model instead of thrown`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-tool-execution-"));
    const longName = `${"x".repeat(300)}.txt`;

    try {
      // When
      const longNameResult = await executeToolCall({
        workspace,
        toolCall: {
          id: "write_1",
          tool: "write",
          path: longName,
          content: "data",
        },
        signal: new AbortController().signal,
        allowBash: false,
      });
      const nulResult = await executeToolCall({
        workspace,
        toolCall: {
          id: "write_2",
          tool: "write",
          path: "bad\u0000name.txt",
          content: "data",
        },
        signal: new AbortController().signal,
        allowBash: false,
      });

      // Then
      expectRecoverableToolFailure(longNameResult, "ENAMETOOLONG");
      expectRecoverableToolFailure(nulResult, "null bytes");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
