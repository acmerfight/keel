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
import type { Message } from "../../src/llm/types.ts";
import { executeToolCall } from "../../src/tools/execution.ts";
import type { AgentMemoryToolContext } from "../../src/tools/memory.ts";

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

  test(`Given memory mutation tools are unavailable for the current run,
    When a provider still calls them,
    Then the execution layer returns recoverable failures without mutating memory`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-tool-memory-"));

    try {
      // When
      const addResult = await executeToolCall({
        workspace,
        toolCall: {
          id: "memory_add_1",
          tool: "memory_add",
          text: "release tags use a v prefix",
        },
        signal: new AbortController().signal,
        allowBash: false,
      });
      const forgetResult = await executeToolCall({
        workspace,
        toolCall: {
          id: "memory_forget_1",
          tool: "memory_forget",
          memoryId: "mem_release",
        },
        signal: new AbortController().signal,
        allowBash: false,
      });

      // Then
      expect(addResult.ok).toBe(false);
      expect(addResult.content).toContain(
        "memory_add failed: memory mutation is unavailable for this model step",
      );
      expect(forgetResult.ok).toBe(false);
      expect(forgetResult.content).toContain(
        "memory_forget failed: memory mutation is unavailable for this model step",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given memory is enabled but no eligible current-user message exists,
    When the provider calls memory_add,
    Then the execution layer rejects the call before invoking the capability`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-tool-memory-"));
    let addCalls = 0;
    const memory: AgentMemoryToolContext = {
      capability: {
        list: () => [],
        add: () => {
          addCalls++;
          return { id: "mem_unexpected", scope: { kind: "project", id: "p" } };
        },
        forget: () => {
          throw new Error("forget should not run");
        },
      },
      currentUserMessage: () => null,
      claimSourceMutation: () => {
        throw new Error("claimSourceMutation should not run");
      },
    };

    try {
      // When
      const result = await executeToolCall({
        workspace,
        toolCall: {
          id: "memory_add_1",
          tool: "memory_add",
          text: "release tags use a v prefix",
        },
        signal: new AbortController().signal,
        allowBash: false,
        memory,
      });

      // Then
      expect(addCalls).toBe(0);
      expect(result.ok).toBe(false);
      expect(result.content).toContain(
        "no eligible current-user message authorizes memory mutation",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given one current-user message authorizes one memory add,
    When the provider calls memory_add twice with the same source,
    Then the first call succeeds and the second call is rejected`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-tool-memory-"));
    const userMessage = "Remember that release tags use a v prefix.";
    const currentUserMessage = {
      role: "user" as const,
      content: userMessage,
      origin: { type: "user_prompt" as const },
    };
    const claimedMessages = new WeakSet<
      Extract<Message, { readonly role: "user" }>
    >();
    claimedMessages.add(currentUserMessage);
    let addCalls = 0;
    const memory: AgentMemoryToolContext = {
      capability: {
        list: () => [],
        add: (text, source) => {
          addCalls++;
          expect(text).toBe("release tags use a v prefix");
          expect(source).toBe(userMessage);
          return {
            id: "mem_release",
            scope: { kind: "project", id: "project_release" },
          };
        },
        forget: () => {
          throw new Error("forget should not run");
        },
      },
      currentUserMessage: () => currentUserMessage,
      claimSourceMutation: (message) => {
        if (claimedMessages.has(message)) return false;
        claimedMessages.add(message);
        return true;
      },
    };

    try {
      // When
      claimedMessages.delete(currentUserMessage);
      const first = await executeToolCall({
        workspace,
        toolCall: {
          id: "memory_add_1",
          tool: "memory_add",
          text: "release tags use a v prefix",
        },
        signal: new AbortController().signal,
        allowBash: false,
        memory,
      });
      const second = await executeToolCall({
        workspace,
        toolCall: {
          id: "memory_add_2",
          tool: "memory_add",
          text: "release tags use a v prefix",
        },
        signal: new AbortController().signal,
        allowBash: false,
        memory,
      });

      // Then
      expect(addCalls).toBe(1);
      expect(first).toEqual({
        content: "Saved project memory mem_release for project_release.",
        ok: true,
        memoryOperation: {
          operation: "add",
          id: "mem_release",
          scope: { kind: "project", id: "project_release" },
          outcome: "saved",
        },
      });
      expect(second.ok).toBe(false);
      expect(second.content).toContain(
        "this current-user source already authorized one memory mutation",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given one current-user message unambiguously identifies a memory,
    When the provider calls memory_forget,
    Then the execution layer invokes the forget capability and returns an operation`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-tool-memory-"));
    const userMessage = "Forget the release tag prefix.";
    const currentUserMessage = {
      role: "user" as const,
      content: userMessage,
      origin: { type: "user_prompt" as const },
    };
    let forgetCalls = 0;
    const memory: AgentMemoryToolContext = {
      capability: {
        list: () => [
          { id: "mem_release", text: "The release tag prefix is v." },
          { id: "mem_notes", text: "Release notes remain chronological." },
        ],
        add: () => {
          throw new Error("add should not run");
        },
        forget: (id, source) => {
          forgetCalls++;
          expect(id).toBe("mem_release");
          expect(source).toBe(userMessage);
          return { id, scope: { kind: "project", id: "project_release" } };
        },
      },
      currentUserMessage: () => currentUserMessage,
      claimSourceMutation: () => true,
    };

    try {
      // When
      const result = await executeToolCall({
        workspace,
        toolCall: {
          id: "memory_forget_1",
          tool: "memory_forget",
          memoryId: "mem_release",
        },
        signal: new AbortController().signal,
        allowBash: false,
        memory,
      });

      // Then
      expect(forgetCalls).toBe(1);
      expect(result).toEqual({
        content: "Forgot project memory mem_release for project_release.",
        ok: true,
        memoryOperation: {
          operation: "forget",
          id: "mem_release",
          scope: { kind: "project", id: "project_release" },
          outcome: "forgotten",
        },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given memory is enabled but no eligible current-user message exists,
    When the provider calls memory_forget,
    Then the execution layer rejects the call before invoking the capability`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-tool-memory-"));
    let forgetCalls = 0;
    const memory: AgentMemoryToolContext = {
      capability: {
        list: () => [
          { id: "mem_release", text: "The release tag prefix is v." },
        ],
        add: () => {
          throw new Error("add should not run");
        },
        forget: () => {
          forgetCalls++;
          return { id: "mem_release", scope: { kind: "project", id: "p" } };
        },
      },
      currentUserMessage: () => null,
      claimSourceMutation: () => {
        throw new Error("claimSourceMutation should not run");
      },
    };

    try {
      // When
      const result = await executeToolCall({
        workspace,
        toolCall: {
          id: "memory_forget_1",
          tool: "memory_forget",
          memoryId: "mem_release",
        },
        signal: new AbortController().signal,
        allowBash: false,
        memory,
      });

      // Then
      expect(forgetCalls).toBe(0);
      expect(result.ok).toBe(false);
      expect(result.content).toContain(
        "no eligible current-user message authorizes memory mutation",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given one current-user message already authorized a memory add,
    When the provider next calls memory_forget with the same source,
    Then the execution layer rejects the second mutation`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-tool-memory-"));
    const userMessage = "Forget the release tag prefix.";
    const currentUserMessage = {
      role: "user" as const,
      content: userMessage,
      origin: { type: "user_prompt" as const },
    };
    let forgetCalls = 0;
    const memory: AgentMemoryToolContext = {
      capability: {
        list: () => [
          { id: "mem_release", text: "The release tag prefix is v." },
        ],
        add: () => {
          throw new Error("add should not run");
        },
        forget: () => {
          forgetCalls++;
          return {
            id: "mem_release",
            scope: { kind: "project", id: "project_release" },
          };
        },
      },
      currentUserMessage: () => currentUserMessage,
      claimSourceMutation: () => false,
    };

    try {
      // When
      const result = await executeToolCall({
        workspace,
        toolCall: {
          id: "memory_forget_1",
          tool: "memory_forget",
          memoryId: "mem_release",
        },
        signal: new AbortController().signal,
        allowBash: false,
        memory,
      });

      // Then
      expect(forgetCalls).toBe(0);
      expect(result.ok).toBe(false);
      expect(result.content).toContain(
        "this current-user source already authorized one memory mutation",
      );
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
