import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../src/agent/loop.ts";
import { runAgent, runAgentTurn } from "../../src/agent/loop.ts";
import { restorePostCompactionReads } from "../../src/agent/post-compaction-restore.ts";
import { createReadVisibilityState } from "../../src/agent/read-visibility.ts";
import { defaultStopPolicy } from "../../src/agent/stop-policy.ts";
import { restoreLastEditCheckpoint } from "../../src/core/git.ts";
import {
  createFakeProvider,
  fakeResponse,
  fakeToolResponse,
} from "../../src/llm/providers/fake.ts";
import type { LLMProvider, Message } from "../../src/llm/types.ts";
import { createGitWorkspace } from "../../src/testing/cli-harness.ts";
import { createProjectInstructionVisibilityState } from "../../src/tools/scoped-project-instructions.ts";

async function collect(
  source: AsyncIterable<AgentEvent>,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of source) {
    events.push(event);
  }
  return events;
}

function freshSignal(): AbortSignal {
  return new AbortController().signal;
}

async function createWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "keel-edit-"));
}

describe("File Editing", () => {
  test(`Given the assistant requests a new workspace file,
    When the agent handles the write tool call,
    Then the file is created before the assistant replies`, async () => {
    // Given
    const workspace = await createWorkspace();
    const provider = createFakeProvider([
      fakeToolResponse("write", {
        path: "config.json",
        content: '{"created":true}\n',
      }),
      fakeResponse("Created config.json."),
    ]);

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "create config.json",
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(await readFile(join(workspace, "config.json"), "utf8")).toBe(
        '{"created":true}\n',
      );
      expect(events).toContainEqual({
        type: "text",
        text: "Created config.json.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given one of multiple requested file writes targets an existing file,
    When the agent handles the tool calls,
    Then it reports that failure and still creates the remaining new file`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "existing.txt"), "keep me\n", "utf8");
    let turn = 0;
    let secondTurnMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "mixed-multiple-writes",
      async *stream(options) {
        if (turn === 1) {
          secondTurnMessages = options.messages;
          yield {
            type: "text",
            text: "One write failed and one write succeeded.",
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              uncachedInputTokens: 1,
              outputTokens: 1,
            },
          };
          return;
        }

        turn++;
        yield {
          type: "tool_call",
          id: "existing_write",
          tool: "write",
          path: "existing.txt",
          content: "replace me\n",
        };
        yield {
          type: "tool_call",
          id: "new_write",
          tool: "write",
          path: "nested/new.txt",
          content: "created\n",
        };
        yield {
          type: "stop",
          reason: "stop",
          usage: {
            inputTokens: 1,
            cachedInputTokens: 0,
            uncachedInputTokens: 1,
            outputTokens: 1,
          },
        };
      },
    };

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "write both files",
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(await readFile(join(workspace, "existing.txt"), "utf8")).toBe(
        "keep me\n",
      );
      expect(await readFile(join(workspace, "nested", "new.txt"), "utf8")).toBe(
        "created\n",
      );
      const toolMessages = secondTurnMessages.filter(
        (message) => message.role === "tool",
      );
      expect(toolMessages[0]).toMatchObject({
        role: "tool",
        toolCallId: "existing_write",
        content: expect.stringContaining("file already exists"),
      });
      expect(toolMessages[0]?.content).toContain("Recovery:");
      expect(toolMessages[1]).toEqual({
        role: "tool",
        toolCallId: "new_write",
        content: "Wrote nested/new.txt",
      });
      expect(events).toContainEqual({
        type: "text",
        text: "One write failed and one write succeeded.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the first write targets an existing file,
    When the agent reports the failure and receives a corrected write path,
    Then the new file is created on disk`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "config.json"), '{"old":true}\n', "utf8");
    let turn = 0;
    let secondTurnMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "recover-existing-write",
      async *stream(options) {
        if (turn === 0) {
          turn++;
          yield {
            type: "tool_call",
            id: "existing_write",
            tool: "write",
            path: "config.json",
            content: '{"new":true}\n',
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              uncachedInputTokens: 1,
              outputTokens: 1,
            },
          };
          return;
        }

        if (turn === 1) {
          turn++;
          secondTurnMessages = options.messages;
          yield {
            type: "tool_call",
            id: "correct_write",
            tool: "write",
            path: "config.generated.json",
            content: '{"new":true}\n',
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 2,
              cachedInputTokens: 0,
              uncachedInputTokens: 2,
              outputTokens: 2,
            },
          };
          return;
        }

        yield { type: "text", text: "Created the generated config." };
        yield {
          type: "stop",
          reason: "stop",
          usage: {
            inputTokens: 3,
            cachedInputTokens: 0,
            uncachedInputTokens: 3,
            outputTokens: 3,
          },
        };
      },
    };

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "write a generated config",
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      const failedToolMessage = secondTurnMessages.find(
        (message) => message.role === "tool",
      );
      expect(failedToolMessage).toMatchObject({
        role: "tool",
        toolCallId: "existing_write",
        content: expect.stringContaining("file already exists"),
      });
      expect(failedToolMessage?.content).toContain("Recovery:");
      expect(await readFile(join(workspace, "config.json"), "utf8")).toBe(
        '{"old":true}\n',
      );
      expect(
        await readFile(join(workspace, "config.generated.json"), "utf8"),
      ).toBe('{"new":true}\n');
      expect(events).toContainEqual({
        type: "text",
        text: "Created the generated config.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a nested AGENTS.md applies to a requested file,
    When the assistant reads that file,
    Then the scoped project instructions are visible before the file content`, async () => {
    // Given
    const workspace = await createWorkspace();
    await mkdir(join(workspace, "packages", "api", "src"), {
      recursive: true,
    });
    await mkdir(join(workspace, "packages", "web"), { recursive: true });
    await writeFile(
      join(workspace, "packages", "api", "AGENTS.md"),
      "API rule: do not change handlers before reading the service contract.\n",
      "utf8",
    );
    await writeFile(
      join(workspace, "packages", "web", "AGENTS.md"),
      "Web rule: this sibling package must not apply.\n",
      "utf8",
    );
    await writeFile(
      join(workspace, "packages", "api", "src", "server.ts"),
      "export const server = 'api';\n",
      "utf8",
    );
    let turn = 0;
    let secondTurnMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "scoped-agents-read",
      async *stream(options) {
        if (turn === 1) {
          secondTurnMessages = options.messages;
          yield { type: "text", text: "Read the API server." };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              uncachedInputTokens: 1,
              outputTokens: 1,
            },
          };
          return;
        }

        turn++;
        yield {
          type: "tool_call",
          id: "read_api_server",
          tool: "read",
          path: "packages/api/src/server.ts",
        };
        yield {
          type: "stop",
          reason: "stop",
          usage: {
            inputTokens: 1,
            cachedInputTokens: 0,
            uncachedInputTokens: 1,
            outputTokens: 1,
          },
        };
      },
    };

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "read the API server",
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      const toolMessage = secondTurnMessages.find(
        (message) => message.role === "tool",
      );
      expect(toolMessage).toMatchObject({
        role: "tool",
        toolCallId: "read_api_server",
      });
      const toolContent = toolMessage?.content;
      if (toolContent === undefined) {
        throw new Error("Expected read tool content");
      }
      expect(toolContent).toContain(
        "Project instructions from packages/api/AGENTS.md",
      );
      expect(toolContent).toContain(
        "API rule: do not change handlers before reading the service contract.",
      );
      expect(toolContent).not.toContain("Web rule:");
      expect(toolContent.indexOf("Project instructions from")).toBeLessThan(
        toolContent.indexOf("export const server = 'api';"),
      );
      expect(events).toContainEqual({
        type: "text",
        text: "Read the API server.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a nested AGENTS.md applies to a new file,
    When the assistant writes before seeing those instructions,
    Then the first write is blocked and the retry can create the file`, async () => {
    // Given
    const workspace = await createWorkspace();
    await mkdir(join(workspace, "packages", "api"), { recursive: true });
    await writeFile(
      join(workspace, "packages", "api", "AGENTS.md"),
      "API rule: new files must use the package header.\n",
      "utf8",
    );
    const targetPath = join(workspace, "packages", "api", "src", "new.ts");
    let turn = 0;
    let secondTurnMessages: readonly Message[] = [];
    let fileExistedBeforeRetry = false;
    const provider: LLMProvider = {
      id: "scoped-agents-write-retry",
      async *stream(options) {
        if (turn === 1) {
          secondTurnMessages = options.messages;
          try {
            await readFile(targetPath, "utf8");
            fileExistedBeforeRetry = true;
          } catch {
            fileExistedBeforeRetry = false;
          }
          turn++;
          yield {
            type: "tool_call",
            id: "retry_write",
            tool: "write",
            path: "packages/api/src/new.ts",
            content: "// package header\nexport const value = 1;\n",
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              uncachedInputTokens: 1,
              outputTokens: 1,
            },
          };
          return;
        }

        if (turn === 2) {
          yield { type: "text", text: "Created with scoped instructions." };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              uncachedInputTokens: 1,
              outputTokens: 1,
            },
          };
          return;
        }

        turn++;
        yield {
          type: "tool_call",
          id: "initial_write",
          tool: "write",
          path: "packages/api/src/new.ts",
          content: "export const value = 1;\n",
        };
        yield {
          type: "stop",
          reason: "stop",
          usage: {
            inputTokens: 1,
            cachedInputTokens: 0,
            uncachedInputTokens: 1,
            outputTokens: 1,
          },
        };
      },
    };

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "create an API file",
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      const failedToolMessage = secondTurnMessages.find(
        (message) => message.role === "tool",
      );
      expect(failedToolMessage).toMatchObject({
        role: "tool",
        toolCallId: "initial_write",
        content: expect.stringContaining(
          "Project instructions from packages/api/AGENTS.md",
        ),
      });
      expect(failedToolMessage?.content).toContain("Tool failed:");
      expect(failedToolMessage?.content).toContain(
        "API rule: new files must use the package header.",
      );
      expect(failedToolMessage?.content).toContain("Recovery:");
      expect(fileExistedBeforeRetry).toBe(false);
      expect(await readFile(targetPath, "utf8")).toBe(
        "// package header\nexport const value = 1;\n",
      );
      expect(events).toContainEqual({
        type: "text",
        text: "Created with scoped instructions.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the workspace disappears before a write tool call runs,
    When the agent handles the write request,
    Then it rejects the terminal filesystem error`, async () => {
    // Given
    const workspace = await createWorkspace();
    const provider = createFakeProvider([
      fakeToolResponse("write", { path: "created.txt", content: "content\n" }),
    ]);
    await rm(workspace, { recursive: true, force: true });

    // When / Then
    await expect(
      collect(
        runAgent({
          workspace,
          provider,
          userMessage: "create a file",
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
        }),
      ),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test(`Given the assistant edits a file before reading it,
    When the agent handles the edit tool call,
    Then it asks the assistant to read the file first and leaves the file unchanged`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "note.txt"), "hello old world\n", "utf8");
    let secondTurnMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "edit-before-read",
      async *stream(options) {
        if (secondTurnMessages.length > 0) {
          yield { type: "text", text: "I will read the file first." };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              uncachedInputTokens: 1,
              outputTokens: 1,
            },
          };
          return;
        }

        if (options.messages.some((message) => message.role === "tool")) {
          secondTurnMessages = options.messages;
          yield { type: "text", text: "I will read the file first." };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              uncachedInputTokens: 1,
              outputTokens: 1,
            },
          };
          return;
        }

        yield {
          type: "tool_call",
          id: "guessed_edit",
          tool: "edit",
          path: "note.txt",
          edits: [{ oldText: "old", newText: "new" }],
        };
        yield {
          type: "stop",
          reason: "stop",
          usage: {
            inputTokens: 1,
            cachedInputTokens: 0,
            uncachedInputTokens: 1,
            outputTokens: 1,
          },
        };
      },
    };

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "replace the word",
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "hello old world\n",
      );
      const toolMessage = secondTurnMessages.find(
        (message) => message.role === "tool",
      );
      expect(toolMessage).toMatchObject({
        role: "tool",
        toolCallId: "guessed_edit",
        content: expect.stringContaining("file has not been read"),
      });
      expect(toolMessage?.content).toContain("Recovery:");
      expect(events).toContainEqual({
        type: "text",
        text: "I will read the file first.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the assistant reads a file before editing it,
    When the read result is visible on the next turn,
    Then the file is updated on disk`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "note.txt"), "hello old world\n", "utf8");
    const provider = createFakeProvider([
      fakeToolResponse("read", { path: "note.txt" }),
      fakeToolResponse("edit", {
        path: "note.txt",
        edits: [{ oldText: "old", newText: "new" }],
      }),
      fakeResponse("Done."),
    ]);

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "replace the word",
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "hello new world\n",
      );
      expect(events).toContainEqual({
        type: "text",
        text: "Done.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given more visible reads than the retained cap,
    When read visibility records them,
    Then old paths are evicted and recent paths still satisfy read-before-edit`, () => {
    // Given
    const retainedReadCap = 256;
    const readVisibility = createReadVisibilityState();
    const targetPaths = Array.from(
      { length: retainedReadCap + 2 },
      (_, index) => `/workspace/file-${index}.txt`,
    );
    const newestTarget = targetPaths[targetPaths.length - 1];
    if (newestTarget === undefined) {
      throw new Error("Expected newest target path");
    }

    // When
    readVisibility.applyVisibleToolExecutions(
      targetPaths.map((targetPath) => ({
        ok: true,
        content: "",
        readTargetPath: targetPath,
      })),
    );

    // Then
    expect(readVisibility.visibleReadsMostRecentFirst()).toHaveLength(
      retainedReadCap,
    );
    expect(readVisibility.hasRead("/workspace/file-0.txt")).toBe(false);
    expect(readVisibility.hasRead("/workspace/file-1.txt")).toBe(false);
    expect(readVisibility.hasRead("/workspace/file-2.txt")).toBe(true);
    expect(readVisibility.hasRead(newestTarget)).toBe(true);

    readVisibility.applyImmediateMutation({
      ok: true,
      content: "",
      mutatedTargetPath: newestTarget,
    });
    expect(readVisibility.hasRead(newestTarget)).toBe(false);
  });

  test(`Given the assistant edits two locations in one file,
    When the agent handles one multi-edit tool call,
    Then both locations are updated on disk`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(
      join(workspace, "settings.ts"),
      "export const timeoutMs = 30000;\nexport const retryCount = 2;\n",
      "utf8",
    );
    const provider = createFakeProvider([
      fakeToolResponse("read", { path: "settings.ts" }),
      fakeToolResponse("edit", {
        path: "settings.ts",
        edits: [
          {
            oldText: "export const timeoutMs = 30000;",
            newText: "export const timeoutMs = 45000;",
          },
          {
            oldText: "export const retryCount = 2;",
            newText: "export const retryCount = 3;",
          },
        ],
      }),
      fakeResponse("Updated both settings."),
    ]);

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "update timeout and retry count",
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(await readFile(join(workspace, "settings.ts"), "utf8")).toBe(
        "export const timeoutMs = 45000;\nexport const retryCount = 3;\n",
      );
      expect(events).toContainEqual({
        type: "text",
        text: "Updated both settings.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the assistant reads and edits the same file in one response,
    When the agent handles those tool calls,
    Then the edit is rejected because the read result was not visible yet`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "note.txt"), "hello old world\n", "utf8");
    let turn = 0;
    let secondTurnMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "same-turn-read-edit",
      async *stream(options) {
        if (turn === 1) {
          secondTurnMessages = options.messages;
          yield { type: "text", text: "I will retry after reading." };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              uncachedInputTokens: 1,
              outputTokens: 1,
            },
          };
          return;
        }

        turn++;
        yield {
          type: "tool_call",
          id: "read_note",
          tool: "read",
          path: "note.txt",
        };
        yield {
          type: "tool_call",
          id: "same_turn_edit",
          tool: "edit",
          path: "note.txt",
          edits: [{ oldText: "old", newText: "new" }],
        };
        yield {
          type: "stop",
          reason: "stop",
          usage: {
            inputTokens: 1,
            cachedInputTokens: 0,
            uncachedInputTokens: 1,
            outputTokens: 1,
          },
        };
      },
    };

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "replace the word",
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "hello old world\n",
      );
      expect(
        secondTurnMessages.filter((message) => message.role === "tool"),
      ).toEqual([
        {
          role: "tool",
          toolCallId: "read_note",
          content: "hello old world\n",
        },
        {
          role: "tool",
          toolCallId: "same_turn_edit",
          content: expect.stringContaining("file has not been read"),
        },
      ]);
      expect(events).toContainEqual({
        type: "text",
        text: "I will retry after reading.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given same-turn read output includes scoped AGENTS.md instructions,
    When the assistant also edits that scoped file in the same response,
    Then the edit is rejected until the instructions are visible in a later turn`, async () => {
    // Given
    const workspace = await createWorkspace();
    await mkdir(join(workspace, "packages", "api", "src"), {
      recursive: true,
    });
    await writeFile(
      join(workspace, "packages", "api", "AGENTS.md"),
      "API rule: edits must preserve the route contract.\n",
      "utf8",
    );
    await writeFile(
      join(workspace, "packages", "api", "src", "server.ts"),
      "export const route = 'old';\n",
      "utf8",
    );
    let turn = 0;
    let secondTurnMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "same-turn-scoped-agents-read-edit",
      async *stream(options) {
        if (turn === 1) {
          secondTurnMessages = options.messages;
          yield { type: "text", text: "I will retry after reviewing AGENTS." };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              uncachedInputTokens: 1,
              outputTokens: 1,
            },
          };
          return;
        }

        turn++;
        yield {
          type: "tool_call",
          id: "read_api_server",
          tool: "read",
          path: "packages/api/src/server.ts",
        };
        yield {
          type: "tool_call",
          id: "same_turn_scoped_edit",
          tool: "edit",
          path: "packages/api/src/server.ts",
          edits: [{ oldText: "old", newText: "new" }],
        };
        yield {
          type: "stop",
          reason: "stop",
          usage: {
            inputTokens: 1,
            cachedInputTokens: 0,
            uncachedInputTokens: 1,
            outputTokens: 1,
          },
        };
      },
    };

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "read and update the API server",
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(
        await readFile(
          join(workspace, "packages", "api", "src", "server.ts"),
          "utf8",
        ),
      ).toBe("export const route = 'old';\n");
      const readMessage = secondTurnMessages.find(
        (message) =>
          message.role === "tool" && message.toolCallId === "read_api_server",
      );
      const editMessage = secondTurnMessages.find(
        (message) =>
          message.role === "tool" &&
          message.toolCallId === "same_turn_scoped_edit",
      );
      expect(readMessage?.content).toContain(
        "Project instructions from packages/api/AGENTS.md",
      );
      expect(editMessage?.content).toContain(
        "project instructions have not been reviewed",
      );
      expect(editMessage?.content).toContain(
        "Project instructions from packages/api/AGENTS.md",
      );
      expect(events).toContainEqual({
        type: "text",
        text: "I will retry after reviewing AGENTS.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the assistant already edited a file after reading it,
    When it requests another edit without rereading,
    Then the second edit is rejected and the first edit remains`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "note.txt"), "alpha beta gamma\n", "utf8");
    let turn = 0;
    let fourthTurnMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "reread-after-edit",
      async *stream(options) {
        if (turn === 0) {
          turn++;
          yield {
            type: "tool_call",
            id: "read_note",
            tool: "read",
            path: "note.txt",
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              uncachedInputTokens: 1,
              outputTokens: 1,
            },
          };
          return;
        }

        if (turn === 1) {
          turn++;
          yield {
            type: "tool_call",
            id: "first_edit",
            tool: "edit",
            path: "note.txt",
            edits: [{ oldText: "alpha", newText: "one" }],
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              uncachedInputTokens: 1,
              outputTokens: 1,
            },
          };
          return;
        }

        if (turn === 2) {
          turn++;
          yield {
            type: "tool_call",
            id: "second_edit",
            tool: "edit",
            path: "note.txt",
            edits: [{ oldText: "beta", newText: "two" }],
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              uncachedInputTokens: 1,
              outputTokens: 1,
            },
          };
          return;
        }

        fourthTurnMessages = options.messages;
        yield { type: "text", text: "I need to reread the file." };
        yield {
          type: "stop",
          reason: "stop",
          usage: {
            inputTokens: 1,
            cachedInputTokens: 0,
            uncachedInputTokens: 1,
            outputTokens: 1,
          },
        };
      },
    };

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "replace two words",
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "one beta gamma\n",
      );
      const secondEditMessage = fourthTurnMessages.find(
        (message) =>
          message.role === "tool" && message.toolCallId === "second_edit",
      );
      expect(secondEditMessage?.content).toContain("file has not been read");
      expect(events).toContainEqual({
        type: "text",
        text: "I need to reread the file.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a previous read is compacted before the next model request,
    When the assistant edits that file without manually rereading,
    Then the edit uses a fresh post-compaction read snapshot`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "note.txt"), "hello old world\n", "utf8");
    let turn = 0;
    const messages: Message[] = [{ role: "user", content: "read note.txt" }];
    const readVisibility = createReadVisibilityState();
    let editRequestMessages: readonly Message[] = [];
    let finalMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "compacted-read-before-edit",
      async *stream(options) {
        if (options.toolChoice === "none") {
          yield { type: "text", text: "The note was read earlier." };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              uncachedInputTokens: 1,
              outputTokens: 1,
            },
          };
          return;
        }

        if (turn === 0) {
          turn++;
          yield {
            type: "tool_call",
            id: "read_note",
            tool: "read",
            path: "note.txt",
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              uncachedInputTokens: 1,
              outputTokens: 1,
            },
          };
          return;
        }

        if (turn === 1) {
          turn++;
          yield { type: "text", text: "Read note.txt." };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              uncachedInputTokens: 1,
              outputTokens: 1,
            },
          };
          return;
        }

        if (turn === 2) {
          turn++;
          editRequestMessages = options.messages;
          yield {
            type: "tool_call",
            id: "edit_after_compaction",
            tool: "edit",
            path: "note.txt",
            edits: [{ oldText: "current", newText: "fresh" }],
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              uncachedInputTokens: 1,
              outputTokens: 1,
            },
          };
          return;
        }

        if (turn === 3) {
          turn++;
          finalMessages = options.messages;
          yield { type: "text", text: "Updated note.txt." };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              uncachedInputTokens: 1,
              outputTokens: 1,
            },
          };
          return;
        }

        finalMessages = options.messages;
        yield { type: "text", text: "I need to reread note.txt." };
        yield {
          type: "stop",
          reason: "stop",
          usage: {
            inputTokens: 1,
            cachedInputTokens: 0,
            uncachedInputTokens: 1,
            outputTokens: 1,
          },
        };
      },
    };

    try {
      // When
      await collect(
        runAgentTurn({
          workspace,
          provider,
          messages,
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
          readVisibility,
        }),
      );
      await writeFile(
        join(workspace, "note.txt"),
        "hello current world\n",
        "utf8",
      );
      messages.push({ role: "user", content: "replace the word" });
      const events = await collect(
        runAgentTurn({
          workspace,
          provider,
          messages,
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
          readVisibility,
          contextCompaction: {
            contextWindowTokens: 1,
            reserveTokens: 0,
            keepRecentTokens: 1,
          },
        }),
      );

      // Then
      const compactionEvent = events.find(
        (
          event,
        ): event is Extract<
          AgentEvent,
          { readonly type: "context_compacted" }
        > => event.type === "context_compacted",
      );
      expect(compactionEvent?.afterMessageCount).toBe(
        editRequestMessages.length,
      );
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "hello fresh world\n",
      );
      const restoredReadMessage = editRequestMessages.find(
        (message): message is Extract<Message, { readonly role: "tool" }> =>
          message.role === "tool" &&
          message.content.includes("hello current world"),
      );
      expect(restoredReadMessage?.toolCallId).toContain("post_compaction_read");
      expect(JSON.stringify(editRequestMessages)).not.toContain(
        "hello old world",
      );
      const editMessage = finalMessages.find(
        (message) =>
          message.role === "tool" &&
          message.toolCallId === "edit_after_compaction",
      );
      expect(editMessage?.content).toContain("Edited note.txt");
      expect(editMessage?.content).not.toContain("file has not been read");
      expect(events).toContainEqual({
        type: "text",
        text: "Updated note.txt.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a scoped AGENTS.md read is compacted before the next model request,
    When the assistant edits that scoped file without manually rereading,
    Then the restored read re-injects the scoped instructions before the edit`, async () => {
    // Given
    const workspace = await createWorkspace();
    await mkdir(join(workspace, "packages", "api", "src"), {
      recursive: true,
    });
    await writeFile(
      join(workspace, "packages", "api", "AGENTS.md"),
      "API rule: preserve the exported route name.\n",
      "utf8",
    );
    await writeFile(
      join(workspace, "packages", "api", "src", "server.ts"),
      "export const route = 'old';\n",
      "utf8",
    );
    let turn = 0;
    const messages: Message[] = [
      { role: "user", content: "read the API server" },
    ];
    const readVisibility = createReadVisibilityState();
    const projectInstructionVisibility =
      createProjectInstructionVisibilityState(workspace);
    let editRequestMessages: readonly Message[] = [];
    let finalMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "compacted-scoped-agents-read-before-edit",
      async *stream(options) {
        if (options.toolChoice === "none") {
          yield { type: "text", text: "The API server was read earlier." };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              uncachedInputTokens: 1,
              outputTokens: 1,
            },
          };
          return;
        }

        if (turn === 0) {
          turn++;
          yield {
            type: "tool_call",
            id: "read_api_server",
            tool: "read",
            path: "packages/api/src/server.ts",
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              uncachedInputTokens: 1,
              outputTokens: 1,
            },
          };
          return;
        }

        if (turn === 1) {
          turn++;
          yield { type: "text", text: "Read the API server." };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              uncachedInputTokens: 1,
              outputTokens: 1,
            },
          };
          return;
        }

        if (turn === 2) {
          turn++;
          editRequestMessages = options.messages;
          yield {
            type: "tool_call",
            id: "edit_api_server",
            tool: "edit",
            path: "packages/api/src/server.ts",
            edits: [{ oldText: "'current'", newText: "'fresh'" }],
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              uncachedInputTokens: 1,
              outputTokens: 1,
            },
          };
          return;
        }

        turn++;
        finalMessages = options.messages;
        yield { type: "text", text: "Updated the API server." };
        yield {
          type: "stop",
          reason: "stop",
          usage: {
            inputTokens: 1,
            cachedInputTokens: 0,
            uncachedInputTokens: 1,
            outputTokens: 1,
          },
        };
      },
    };

    try {
      // When
      await collect(
        runAgentTurn({
          workspace,
          provider,
          messages,
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
          readVisibility,
          projectInstructionVisibility,
        }),
      );
      await writeFile(
        join(workspace, "packages", "api", "src", "server.ts"),
        "export const route = 'current';\n",
        "utf8",
      );
      messages.push({ role: "user", content: "freshen the API server" });
      const events = await collect(
        runAgentTurn({
          workspace,
          provider,
          messages,
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
          readVisibility,
          projectInstructionVisibility,
          contextCompaction: {
            contextWindowTokens: 1,
            reserveTokens: 0,
            keepRecentTokens: 1,
          },
        }),
      );

      // Then
      expect(
        await readFile(
          join(workspace, "packages", "api", "src", "server.ts"),
          "utf8",
        ),
      ).toBe("export const route = 'fresh';\n");
      const restoredInstructionMessage = editRequestMessages.find(
        (message): message is Extract<Message, { readonly role: "tool" }> =>
          message.role === "tool" &&
          message.content.includes(
            "Project instructions from packages/api/AGENTS.md",
          ),
      );
      expect(restoredInstructionMessage?.toolCallId).toContain(
        "post_compaction_read",
      );
      expect(restoredInstructionMessage?.content).toContain(
        "Project instructions from packages/api/AGENTS.md",
      );
      expect(restoredInstructionMessage?.content).toContain(
        "API rule: preserve the exported route name.",
      );
      const restoredFileReadMessage = editRequestMessages.find(
        (message): message is Extract<Message, { readonly role: "tool" }> =>
          message.role === "tool" &&
          message.content.includes("export const route = 'current';"),
      );
      expect(restoredFileReadMessage?.toolCallId).toContain(
        "post_compaction_read",
      );
      expect(restoredFileReadMessage?.content).toContain(
        "export const route = 'current';",
      );
      expect(restoredFileReadMessage?.content).not.toContain(
        "Project instructions from packages/api/AGENTS.md",
      );
      const editMessage = finalMessages.find(
        (message) =>
          message.role === "tool" && message.toolCallId === "edit_api_server",
      );
      expect(editMessage?.content).toContain(
        "Edited packages/api/src/server.ts",
      );
      expect(editMessage?.content).not.toContain(
        "project instructions have not been reviewed",
      );
      expect(events).toContainEqual({
        type: "text",
        text: "Updated the API server.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given scoped AGENTS.md instructions became visible through a failed write before compaction,
    When the assistant retries the write after compaction,
    Then the restored instructions allow the retry to create the file`, async () => {
    // Given
    const workspace = await createWorkspace();
    await mkdir(join(workspace, "packages", "api"), { recursive: true });
    await writeFile(
      join(workspace, "packages", "api", "AGENTS.md"),
      "API rule: retry writes must include the generated header.\n",
      "utf8",
    );
    const targetPath = join(
      workspace,
      "packages",
      "api",
      "src",
      "generated.ts",
    );
    let turn = 0;
    const messages: Message[] = [
      { role: "user", content: "create the generated API file" },
    ];
    const readVisibility = createReadVisibilityState();
    const projectInstructionVisibility =
      createProjectInstructionVisibilityState(workspace);
    let retryRequestMessages: readonly Message[] = [];
    let finalMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "compacted-failed-write-scoped-agents",
      async *stream(options) {
        if (options.toolChoice === "none") {
          yield {
            type: "text",
            text: "The failed write exposed scoped project instructions.",
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              uncachedInputTokens: 1,
              outputTokens: 1,
            },
          };
          return;
        }

        if (turn === 0) {
          turn++;
          yield {
            type: "tool_call",
            id: "initial_write",
            tool: "write",
            path: "packages/api/src/generated.ts",
            content: "export const generated = true;\n",
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              uncachedInputTokens: 1,
              outputTokens: 1,
            },
          };
          return;
        }

        if (turn === 1) {
          turn++;
          yield {
            type: "text",
            text: "Reviewed the scoped project instructions.",
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              uncachedInputTokens: 1,
              outputTokens: 1,
            },
          };
          return;
        }

        if (turn === 2) {
          turn++;
          retryRequestMessages = options.messages;
          yield {
            type: "tool_call",
            id: "retry_write",
            tool: "write",
            path: "packages/api/src/generated.ts",
            content: "// generated header\nexport const generated = true;\n",
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              uncachedInputTokens: 1,
              outputTokens: 1,
            },
          };
          return;
        }

        turn++;
        finalMessages = options.messages;
        yield { type: "text", text: "Created after compaction." };
        yield {
          type: "stop",
          reason: "stop",
          usage: {
            inputTokens: 1,
            cachedInputTokens: 0,
            uncachedInputTokens: 1,
            outputTokens: 1,
          },
        };
      },
    };

    try {
      // When
      await collect(
        runAgentTurn({
          workspace,
          provider,
          messages,
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
          readVisibility,
          projectInstructionVisibility,
        }),
      );
      messages.push({ role: "user", content: "retry creating the file" });
      const events = await collect(
        runAgentTurn({
          workspace,
          provider,
          messages,
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
          readVisibility,
          projectInstructionVisibility,
          contextCompaction: {
            contextWindowTokens: 1,
            reserveTokens: 0,
            keepRecentTokens: 1,
          },
        }),
      );

      // Then
      expect(events.some((event) => event.type === "context_compacted")).toBe(
        true,
      );
      expect(JSON.stringify(retryRequestMessages)).toContain(
        "Project instructions from packages/api/AGENTS.md",
      );
      const retryToolMessage = finalMessages.find(
        (message) =>
          message.role === "tool" && message.toolCallId === "retry_write",
      );
      expect(retryToolMessage?.content).toBe(
        "Wrote packages/api/src/generated.ts",
      );
      expect(await readFile(targetPath, "utf8")).toBe(
        "// generated header\nexport const generated = true;\n",
      );
      expect(events).toContainEqual({
        type: "text",
        text: "Created after compaction.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a windowed file read is compacted before the next model request,
    When the assistant edits that later file section without manually rereading,
    Then the restored read uses the same window`, async () => {
    // Given
    const workspace = await createWorkspace();
    const targetOffset = 2101;
    const prefix = Array.from(
      { length: targetOffset - 1 },
      (_, index) => `filler ${index}`,
    ).join("\n");
    await writeFile(
      join(workspace, "note.txt"),
      `${prefix}\ntarget old value\n`,
      "utf8",
    );
    let turn = 0;
    const messages: Message[] = [{ role: "user", content: "read note.txt" }];
    const readVisibility = createReadVisibilityState();
    let editRequestMessages: readonly Message[] = [];
    let finalMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "compacted-windowed-read-before-edit",
      async *stream(options) {
        if (options.toolChoice === "none") {
          yield { type: "text", text: "The later window was read earlier." };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              uncachedInputTokens: 1,
              outputTokens: 1,
            },
          };
          return;
        }

        if (turn === 0) {
          turn++;
          yield {
            type: "tool_call",
            id: "read_later_window",
            tool: "read",
            path: "note.txt",
            offset: targetOffset,
            limit: 1,
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              uncachedInputTokens: 1,
              outputTokens: 1,
            },
          };
          return;
        }

        if (turn === 1) {
          turn++;
          yield { type: "text", text: "Read the later window." };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              uncachedInputTokens: 1,
              outputTokens: 1,
            },
          };
          return;
        }

        if (turn === 2) {
          turn++;
          editRequestMessages = options.messages;
          yield {
            type: "tool_call",
            id: "edit_later_window",
            tool: "edit",
            path: "note.txt",
            edits: [{ oldText: "target current", newText: "target fresh" }],
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              uncachedInputTokens: 1,
              outputTokens: 1,
            },
          };
          return;
        }

        turn++;
        finalMessages = options.messages;
        yield { type: "text", text: "Updated later window." };
        yield {
          type: "stop",
          reason: "stop",
          usage: {
            inputTokens: 1,
            cachedInputTokens: 0,
            uncachedInputTokens: 1,
            outputTokens: 1,
          },
        };
      },
    };

    try {
      // When
      await collect(
        runAgentTurn({
          workspace,
          provider,
          messages,
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
          readVisibility,
        }),
      );
      await writeFile(
        join(workspace, "note.txt"),
        `${prefix}\ntarget current value\n`,
        "utf8",
      );
      messages.push({ role: "user", content: "replace the target" });
      const events = await collect(
        runAgentTurn({
          workspace,
          provider,
          messages,
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
          readVisibility,
          contextCompaction: {
            contextWindowTokens: 1,
            reserveTokens: 0,
            keepRecentTokens: 1,
          },
        }),
      );

      // Then
      const compactionEvent = events.find(
        (
          event,
        ): event is Extract<
          AgentEvent,
          { readonly type: "context_compacted" }
        > => event.type === "context_compacted",
      );
      expect(compactionEvent?.afterMessageCount).toBe(
        editRequestMessages.length,
      );
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toContain(
        "target fresh value\n",
      );
      const restoredReadRequest = editRequestMessages
        .flatMap((message) =>
          message.role === "assistant" ? message.toolCalls : [],
        )
        .find((toolCall) => toolCall.id.startsWith("post_compaction_read"));
      expect(restoredReadRequest).toEqual(
        expect.objectContaining({
          tool: "read",
          offset: targetOffset,
          limit: 1,
        }),
      );
      const restoredReadMessage = editRequestMessages.find(
        (message): message is Extract<Message, { readonly role: "tool" }> =>
          message.role === "tool" &&
          message.content.includes("target current value"),
      );
      expect(restoredReadMessage?.toolCallId).toContain("post_compaction_read");
      expect(JSON.stringify(editRequestMessages)).not.toContain(
        "target old value",
      );
      const editMessage = finalMessages.find(
        (message) =>
          message.role === "tool" && message.toolCallId === "edit_later_window",
      );
      expect(editMessage?.content).toContain("Edited note.txt");
      expect(editMessage?.content).not.toContain("file has not been read");
      expect(events).toContainEqual({
        type: "text",
        text: "Updated later window.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a restored post-compaction read is truncated before the edit target,
    When the assistant edits the unseen suffix without manually rereading,
    Then the edit is rejected until a complete fresh read is visible`, async () => {
    // Given
    const workspace = await createWorkspace();
    const largePrefix = "x".repeat(22_000);
    const oldContent = `${largePrefix} target old value\n`;
    const currentContent = `${largePrefix} target current value\n`;
    await writeFile(join(workspace, "note.txt"), oldContent, "utf8");
    let turn = 0;
    const messages: Message[] = [{ role: "user", content: "read note.txt" }];
    const readVisibility = createReadVisibilityState();
    let editRequestMessages: readonly Message[] = [];
    let finalMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "truncated-post-compaction-read-before-edit",
      async *stream(options) {
        if (options.toolChoice === "none") {
          yield { type: "text", text: "The large note was read earlier." };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              uncachedInputTokens: 1,
              outputTokens: 1,
            },
          };
          return;
        }

        if (turn === 0) {
          turn++;
          yield {
            type: "tool_call",
            id: "read_large_note",
            tool: "read",
            path: "note.txt",
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              uncachedInputTokens: 1,
              outputTokens: 1,
            },
          };
          return;
        }

        if (turn === 1) {
          turn++;
          yield { type: "text", text: "Read the large note." };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              uncachedInputTokens: 1,
              outputTokens: 1,
            },
          };
          return;
        }

        if (turn === 2) {
          turn++;
          editRequestMessages = options.messages;
          yield {
            type: "tool_call",
            id: "edit_unseen_suffix",
            tool: "edit",
            path: "note.txt",
            edits: [{ oldText: "target current", newText: "target fresh" }],
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              uncachedInputTokens: 1,
              outputTokens: 1,
            },
          };
          return;
        }

        turn++;
        finalMessages = options.messages;
        yield { type: "text", text: "Need to reread note.txt." };
        yield {
          type: "stop",
          reason: "stop",
          usage: {
            inputTokens: 1,
            cachedInputTokens: 0,
            uncachedInputTokens: 1,
            outputTokens: 1,
          },
        };
      },
    };

    try {
      // When
      await collect(
        runAgentTurn({
          workspace,
          provider,
          messages,
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
          readVisibility,
        }),
      );
      await writeFile(join(workspace, "note.txt"), currentContent, "utf8");
      messages.push({ role: "user", content: "replace the target" });
      const events = await collect(
        runAgentTurn({
          workspace,
          provider,
          messages,
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
          readVisibility,
          contextCompaction: {
            contextWindowTokens: 1,
            reserveTokens: 0,
            keepRecentTokens: 1,
          },
        }),
      );

      // Then
      const compactionEvent = events.find(
        (
          event,
        ): event is Extract<
          AgentEvent,
          { readonly type: "context_compacted" }
        > => event.type === "context_compacted",
      );
      expect(compactionEvent?.afterMessageCount).toBe(
        editRequestMessages.length,
      );
      const restoredReadMessage = editRequestMessages.find(
        (message): message is Extract<Message, { readonly role: "tool" }> =>
          message.role === "tool" &&
          message.toolCallId.includes("post_compaction_read"),
      );
      expect(restoredReadMessage?.content).toContain(
        "Post-compaction read snapshot truncated",
      );
      const truncationMatch =
        /\[Post-compaction read snapshot truncated: omitted ([0-9]+) chars\]/u.exec(
          restoredReadMessage?.content ?? "",
        );
      const markerIndex =
        restoredReadMessage?.content.indexOf(
          "\n\n[Post-compaction read snapshot truncated:",
        ) ?? -1;
      expect(Number(truncationMatch?.[1])).toBe(
        currentContent.length - markerIndex,
      );
      expect(restoredReadMessage?.content).not.toContain(
        "target current value",
      );
      const editMessage = finalMessages.find(
        (message) =>
          message.role === "tool" &&
          message.toolCallId === "edit_unseen_suffix",
      );
      expect(editMessage?.content).toContain("file has not been read");
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        currentContent,
      );
      expect(events).toContainEqual({
        type: "text",
        text: "Need to reread note.txt.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a visible read disappears before post-compaction restoration,
    When recent reads are restored,
    Then the missing file is skipped and remaining readable files are restored`, async () => {
    // Given
    const workspace = await createWorkspace();
    const keepPath = join(workspace, "keep.txt");
    const gonePath = join(workspace, "gone.txt");
    await writeFile(keepPath, "keep current\n", "utf8");
    await writeFile(gonePath, "gone old\n", "utf8");
    const keepTargetPath = await realpath(keepPath);
    const goneTargetPath = await realpath(gonePath);
    const messages: Message[] = [];
    const readVisibility = createReadVisibilityState();
    const projectInstructionVisibility =
      createProjectInstructionVisibilityState(workspace);
    readVisibility.applyVisibleToolExecutions([
      { ok: true, content: "", readTargetPath: keepTargetPath },
      { ok: true, content: "", readTargetPath: goneTargetPath },
    ]);
    await rm(gonePath);
    let sequence = 0;

    try {
      // When
      await restorePostCompactionReads({
        workspace,
        signal: freshSignal(),
        readVisibility,
        projectInstructionVisibility,
        messages,
        nextToolCallId: () => `post_compaction_read_${sequence++}`,
      });

      // Then
      expect(messages).toEqual([
        {
          role: "assistant",
          content: "",
          toolCalls: [
            expect.objectContaining({
              id: "post_compaction_read_1",
              tool: "read",
              path: keepTargetPath,
            }),
          ],
        },
        {
          role: "tool",
          toolCallId: "post_compaction_read_1",
          content: "keep current\n",
        },
      ]);
      expect(readVisibility.hasRead(keepTargetPath)).toBe(true);
      expect(readVisibility.hasRead(goneTargetPath)).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given scoped AGENTS.md appears after a visible read,
    When recent reads are restored,
    Then the restored read publishes the newly visible scoped instructions`, async () => {
    // Given
    const workspace = await createWorkspace();
    await mkdir(join(workspace, "packages", "api", "src"), {
      recursive: true,
    });
    const serverPath = join(workspace, "packages", "api", "src", "server.ts");
    await writeFile(serverPath, "export const route = 'current';\n", "utf8");
    const serverTargetPath = await realpath(serverPath);
    await writeFile(
      join(workspace, "packages", "api", "AGENTS.md"),
      "API rule: preserve the exported route name.\n",
      "utf8",
    );
    const instructionTargetPath = await realpath(
      join(workspace, "packages", "api", "AGENTS.md"),
    );
    const messages: Message[] = [];
    const readVisibility = createReadVisibilityState();
    const projectInstructionVisibility =
      createProjectInstructionVisibilityState(workspace);
    readVisibility.applyVisibleToolExecutions([
      { ok: true, content: "", readTargetPath: serverTargetPath },
    ]);
    let sequence = 0;

    try {
      // When
      await restorePostCompactionReads({
        workspace,
        signal: freshSignal(),
        readVisibility,
        projectInstructionVisibility,
        messages,
        nextToolCallId: () => `post_compaction_read_${sequence++}`,
      });

      // Then
      expect(messages).toEqual([
        {
          role: "assistant",
          content: "",
          toolCalls: [
            expect.objectContaining({
              id: "post_compaction_read_0",
              tool: "read",
              path: serverTargetPath,
            }),
          ],
        },
        {
          role: "tool",
          toolCallId: "post_compaction_read_0",
          content: [
            "Project instructions from packages/api/AGENTS.md apply to this path:",
            "> API rule: preserve the exported route name.",
            "",
            "export const route = 'current';",
            "",
          ].join("\n"),
        },
      ]);
      expect(
        projectInstructionVisibility.visibleInstructionsMostRecentFirst(),
      ).toEqual([
        {
          instructionPath: instructionTargetPath,
          relativePath: "packages/api/AGENTS.md",
        },
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given visible scoped AGENTS.md disappears before post-compaction restoration,
    When recent project instructions are restored,
    Then stale scoped instructions are skipped`, async () => {
    // Given
    const workspace = await createWorkspace();
    await mkdir(join(workspace, "packages", "api"), { recursive: true });
    const instructionPath = join(workspace, "packages", "api", "AGENTS.md");
    await writeFile(
      instructionPath,
      "API rule: do not replay me after deletion.\n",
      "utf8",
    );
    const instructionTargetPath = await realpath(instructionPath);
    const messages: Message[] = [];
    const readVisibility = createReadVisibilityState();
    const projectInstructionVisibility =
      createProjectInstructionVisibilityState(workspace);
    projectInstructionVisibility.markInstructionPathsVisible([
      instructionTargetPath,
    ]);
    await rm(instructionPath);
    let sequence = 0;

    try {
      // When
      await restorePostCompactionReads({
        workspace,
        signal: freshSignal(),
        readVisibility,
        projectInstructionVisibility,
        messages,
        nextToolCallId: () => `post_compaction_read_${sequence++}`,
      });

      // Then
      expect(messages).toEqual([]);
      expect(sequence).toBe(0);
      expect(
        projectInstructionVisibility.visibleInstructionsMostRecentFirst(),
      ).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given visible scoped AGENTS.md becomes invalid before post-compaction restoration,
    When recent project instructions are restored,
    Then invalid scoped instructions are skipped without aborting the turn`, async () => {
    // Given
    const workspace = await createWorkspace();
    await mkdir(join(workspace, "packages", "api"), { recursive: true });
    const instructionPath = join(workspace, "packages", "api", "AGENTS.md");
    await writeFile(
      instructionPath,
      "API rule: do not replay me after invalidation.\n",
      "utf8",
    );
    const instructionTargetPath = await realpath(instructionPath);
    const messages: Message[] = [];
    const readVisibility = createReadVisibilityState();
    const projectInstructionVisibility =
      createProjectInstructionVisibilityState(workspace);
    projectInstructionVisibility.markInstructionPathsVisible([
      instructionTargetPath,
    ]);
    await writeFile(instructionPath, "a".repeat(50 * 1024 + 1), "utf8");
    let sequence = 0;

    try {
      // When
      await restorePostCompactionReads({
        workspace,
        signal: freshSignal(),
        readVisibility,
        projectInstructionVisibility,
        messages,
        nextToolCallId: () => `post_compaction_read_${sequence++}`,
      });

      // Then
      expect(messages).toEqual([]);
      expect(sequence).toBe(0);
      expect(
        projectInstructionVisibility.visibleInstructionsMostRecentFirst(),
      ).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given scoped AGENTS.md snapshots exhaust the post-compaction restore budget,
    When recent project instructions are restored,
    Then restoration stops before replaying more instructions`, async () => {
    // Given
    const workspace = await createWorkspace();
    const instructionTargets: string[] = [];
    for (const packageName of ["pkg-a", "pkg-b", "pkg-c", "pkg-d"]) {
      const packagePath = join(workspace, "packages", packageName);
      await mkdir(packagePath, { recursive: true });
      const instructionPath = join(packagePath, "AGENTS.md");
      const marker = packageName.slice(-1);
      await writeFile(
        instructionPath,
        `${packageName} rule\n${marker.repeat(22_000)}`,
        "utf8",
      );
      instructionTargets.push(await realpath(instructionPath));
    }
    const messages: Message[] = [];
    const readVisibility = createReadVisibilityState();
    const projectInstructionVisibility =
      createProjectInstructionVisibilityState(workspace);
    projectInstructionVisibility.markInstructionPathsVisible(
      instructionTargets,
    );
    let sequence = 0;

    try {
      // When
      await restorePostCompactionReads({
        workspace,
        signal: freshSignal(),
        readVisibility,
        projectInstructionVisibility,
        messages,
        nextToolCallId: () => `post_compaction_read_${sequence++}`,
      });

      // Then
      expect(sequence).toBe(3);
      const restoredToolMessages = messages.filter(
        (message): message is Extract<Message, { readonly role: "tool" }> =>
          message.role === "tool",
      );
      expect(restoredToolMessages).toHaveLength(3);
      expect(
        restoredToolMessages.reduce(
          (total, message) => total + message.content.length,
          0,
        ),
      ).toBe(50_000);
      expect(JSON.stringify(messages)).toContain(
        "Project instructions from packages/pkg-d/AGENTS.md",
      );
      expect(JSON.stringify(messages)).not.toContain(
        "Project instructions from packages/pkg-a/AGENTS.md",
      );
      expect(
        projectInstructionVisibility.visibleInstructionsMostRecentFirst(),
      ).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given restored post-compaction reads exhaust the total restore budget,
    When another recent read remains,
    Then restoration stops before replaying more files`, async () => {
    // Given
    const workspace = await createWorkspace();
    const afterBudgetPath = join(workspace, "after-budget.txt");
    const tinyBudgetPath = join(workspace, "tiny-budget.txt");
    const fillerPath = join(workspace, "filler.txt");
    const largeBPath = join(workspace, "large-b.txt");
    const largeAPath = join(workspace, "large-a.txt");
    await writeFile(afterBudgetPath, "after budget\n", "utf8");
    await writeFile(tinyBudgetPath, "t".repeat(100), "utf8");
    await writeFile(fillerPath, "f".repeat(9995), "utf8");
    await writeFile(largeBPath, "b".repeat(22_000), "utf8");
    await writeFile(largeAPath, "a".repeat(22_000), "utf8");
    const afterBudgetTargetPath = await realpath(afterBudgetPath);
    const tinyBudgetTargetPath = await realpath(tinyBudgetPath);
    const fillerTargetPath = await realpath(fillerPath);
    const largeBTargetPath = await realpath(largeBPath);
    const largeATargetPath = await realpath(largeAPath);
    const messages: Message[] = [];
    const readVisibility = createReadVisibilityState();
    const projectInstructionVisibility =
      createProjectInstructionVisibilityState(workspace);
    readVisibility.applyVisibleToolExecutions([
      { ok: true, content: "", readTargetPath: afterBudgetTargetPath },
      { ok: true, content: "", readTargetPath: tinyBudgetTargetPath },
      { ok: true, content: "", readTargetPath: fillerTargetPath },
      { ok: true, content: "", readTargetPath: largeBTargetPath },
      { ok: true, content: "", readTargetPath: largeATargetPath },
    ]);
    let sequence = 0;

    try {
      // When
      await restorePostCompactionReads({
        workspace,
        signal: freshSignal(),
        readVisibility,
        projectInstructionVisibility,
        messages,
        nextToolCallId: () => `post_compaction_read_${sequence++}`,
      });

      // Then
      expect(sequence).toBe(4);
      const restoredToolMessages = messages.filter(
        (message): message is Extract<Message, { readonly role: "tool" }> =>
          message.role === "tool",
      );
      expect(restoredToolMessages).toHaveLength(4);
      expect(
        restoredToolMessages.reduce(
          (total, message) => total + message.content.length,
          0,
        ),
      ).toBe(50_000);
      expect(JSON.stringify(messages)).not.toContain("after budget");
      expect(readVisibility.hasRead(fillerTargetPath)).toBe(true);
      expect(readVisibility.hasRead(tinyBudgetTargetPath)).toBe(false);
      expect(readVisibility.hasRead(afterBudgetTargetPath)).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given only replayed transcript text says a file was read,
    When the assistant edits that file in a new agent turn,
    Then the edit is rejected until a live read records the target`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "note.txt"), "hello old world\n", "utf8");
    const messages: Message[] = [
      { role: "user", content: "read note.txt" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "read_note",
            tool: "read",
            path: "note.txt",
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "read_note",
        content: "hello old world\n",
      },
      { role: "user", content: "replace old with new" },
    ];
    let turn = 0;
    let secondTurnMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "transcript-only-read",
      async *stream(options) {
        if (turn === 0) {
          turn++;
          yield {
            type: "tool_call",
            id: "replayed_edit",
            tool: "edit",
            path: "note.txt",
            edits: [{ oldText: "old", newText: "new" }],
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              uncachedInputTokens: 1,
              outputTokens: 1,
            },
          };
          return;
        }

        secondTurnMessages = options.messages;
        yield { type: "text", text: "I need a fresh read." };
        yield {
          type: "stop",
          reason: "stop",
          usage: {
            inputTokens: 1,
            cachedInputTokens: 0,
            uncachedInputTokens: 1,
            outputTokens: 1,
          },
        };
      },
    };

    try {
      // When
      const events = await collect(
        runAgentTurn({
          workspace,
          provider,
          messages,
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "hello old world\n",
      );
      const editMessage = secondTurnMessages.find(
        (message) =>
          message.role === "tool" && message.toolCallId === "replayed_edit",
      );
      expect(editMessage?.content).toContain("file has not been read");
      expect(events).toContainEqual({
        type: "text",
        text: "I need a fresh read.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the assistant requests replacing every exact occurrence in a file,
    When the agent handles the edit tool call,
    Then all occurrences are updated before the assistant replies`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "note.txt"), "old one\nold two\n", "utf8");
    let turn = 0;
    let secondTurnMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "replace-all-edit",
      async *stream(options) {
        if (turn === 0) {
          turn++;
          yield {
            type: "tool_call",
            id: "read_note",
            tool: "read",
            path: "note.txt",
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              uncachedInputTokens: 1,
              outputTokens: 1,
            },
          };
          return;
        }

        if (turn === 1) {
          turn++;
          yield {
            type: "tool_call",
            id: "replace_all_edit",
            tool: "edit",
            path: "note.txt",
            edits: [{ oldText: "old", newText: "new", replaceAll: true }],
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              uncachedInputTokens: 1,
              outputTokens: 1,
            },
          };
          return;
        }

        if (turn === 2) {
          turn++;
          secondTurnMessages = options.messages;
          yield { type: "text", text: "Updated every occurrence." };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              uncachedInputTokens: 1,
              outputTokens: 1,
            },
          };
          return;
        }
      },
    };

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "replace every occurrence",
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "new one\nnew two\n",
      );
      expect(
        secondTurnMessages.filter((message) => message.role === "tool"),
      ).toEqual([
        {
          role: "tool",
          toolCallId: "read_note",
          content: "old one\nold two\n",
        },
        {
          role: "tool",
          toolCallId: "replace_all_edit",
          content: "Edited note.txt",
        },
      ]);
      expect(events).toContainEqual({
        type: "text",
        text: "Updated every occurrence.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the assistant proposes multiple file changes in one response,
    When the agent handles the tool calls,
    Then each file is updated before the assistant replies`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "first.txt"), "first old\n", "utf8");
    await writeFile(join(workspace, "second.txt"), "second old\n", "utf8");
    let turn = 0;
    let secondTurnMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "multiple-edits",
      async *stream(options) {
        if (turn === 0) {
          turn++;
          yield {
            type: "tool_call",
            id: "read_first",
            tool: "read",
            path: "first.txt",
          };
          yield {
            type: "tool_call",
            id: "read_second",
            tool: "read",
            path: "second.txt",
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              uncachedInputTokens: 1,
              outputTokens: 1,
            },
          };
          return;
        }

        if (turn === 1) {
          turn++;
          yield {
            type: "tool_call",
            id: "first_edit",
            tool: "edit",
            path: "first.txt",
            edits: [{ oldText: "old", newText: "new" }],
          };
          yield {
            type: "tool_call",
            id: "second_edit",
            tool: "edit",
            path: "second.txt",
            edits: [{ oldText: "old", newText: "new" }],
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              uncachedInputTokens: 1,
              outputTokens: 1,
            },
          };
          return;
        }

        if (turn === 2) {
          turn++;
          secondTurnMessages = options.messages;
          yield {
            type: "text",
            text: "Both files updated.",
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              uncachedInputTokens: 1,
              outputTokens: 1,
            },
          };
          return;
        }
      },
    };

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "edit both files",
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(await readFile(join(workspace, "first.txt"), "utf8")).toBe(
        "first new\n",
      );
      expect(await readFile(join(workspace, "second.txt"), "utf8")).toBe(
        "second new\n",
      );
      const editMessages = secondTurnMessages.filter(
        (message) =>
          message.role === "tool" &&
          (message.toolCallId === "first_edit" ||
            message.toolCallId === "second_edit"),
      );
      expect(editMessages).toEqual([
        {
          role: "tool",
          toolCallId: "first_edit",
          content: "Edited first.txt",
        },
        {
          role: "tool",
          toolCallId: "second_edit",
          content: "Edited second.txt",
        },
      ]);
      expect(events).toContainEqual({
        type: "text",
        text: "Both files updated.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given one of multiple requested file changes cannot be applied,
    When the agent handles the tool calls,
    Then it reports that failure and still returns the successful tool result`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "first.txt"), "first old\n", "utf8");
    await writeFile(join(workspace, "second.txt"), "second old\n", "utf8");
    let turn = 0;
    let secondTurnMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "mixed-multiple-edits",
      async *stream(options) {
        if (turn === 0) {
          turn++;
          yield {
            type: "tool_call",
            id: "read_first",
            tool: "read",
            path: "first.txt",
          };
          yield {
            type: "tool_call",
            id: "read_second",
            tool: "read",
            path: "second.txt",
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              uncachedInputTokens: 1,
              outputTokens: 1,
            },
          };
          return;
        }

        if (turn === 1) {
          turn++;
          yield {
            type: "tool_call",
            id: "missing_edit",
            tool: "edit",
            path: "first.txt",
            edits: [{ oldText: "missing", newText: "new" }],
          };
          yield {
            type: "tool_call",
            id: "second_edit",
            tool: "edit",
            path: "second.txt",
            edits: [{ oldText: "old", newText: "new" }],
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              uncachedInputTokens: 1,
              outputTokens: 1,
            },
          };
          return;
        }

        if (turn === 2) {
          turn++;
          secondTurnMessages = options.messages;
          yield {
            type: "text",
            text: "One edit failed and one edit succeeded.",
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              uncachedInputTokens: 1,
              outputTokens: 1,
            },
          };
          return;
        }
      },
    };

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "edit both files",
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(await readFile(join(workspace, "first.txt"), "utf8")).toBe(
        "first old\n",
      );
      expect(await readFile(join(workspace, "second.txt"), "utf8")).toBe(
        "second new\n",
      );
      const toolMessages = secondTurnMessages.filter(
        (message) =>
          message.role === "tool" &&
          (message.toolCallId === "missing_edit" ||
            message.toolCallId === "second_edit"),
      );
      expect(toolMessages[0]).toMatchObject({
        role: "tool",
        toolCallId: "missing_edit",
        content: expect.stringContaining("Tool failed:"),
      });
      expect(toolMessages[1]).toEqual({
        role: "tool",
        toolCallId: "second_edit",
        content: "Edited second.txt",
      });
      expect(events).toContainEqual({
        type: "text",
        text: "One edit failed and one edit succeeded.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given one of multiple requested file changes uses an empty old string,
    When the agent handles the tool calls,
    Then it reports that failure and still applies the remaining file change`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "empty.txt"), "", "utf8");
    await writeFile(join(workspace, "second.txt"), "second old\n", "utf8");
    let turn = 0;
    let secondTurnMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "empty-old-string-with-success",
      async *stream(options) {
        if (turn === 0) {
          turn++;
          yield {
            type: "tool_call",
            id: "read_second",
            tool: "read",
            path: "second.txt",
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              uncachedInputTokens: 1,
              outputTokens: 1,
            },
          };
          return;
        }

        if (turn === 1) {
          turn++;
          yield {
            type: "tool_call",
            id: "empty_file_edit",
            tool: "edit",
            path: "empty.txt",
            edits: [{ oldText: "", newText: "created\n" }],
          };
          yield {
            type: "tool_call",
            id: "second_edit",
            tool: "edit",
            path: "second.txt",
            edits: [{ oldText: "old", newText: "new" }],
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              uncachedInputTokens: 1,
              outputTokens: 1,
            },
          };
          return;
        }

        if (turn === 2) {
          turn++;
          secondTurnMessages = options.messages;
          yield {
            type: "text",
            text: "One edit was not valid and one edit succeeded.",
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              uncachedInputTokens: 1,
              outputTokens: 1,
            },
          };
          return;
        }
      },
    };

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "edit both files",
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(await readFile(join(workspace, "empty.txt"), "utf8")).toBe("");
      expect(await readFile(join(workspace, "second.txt"), "utf8")).toBe(
        "second new\n",
      );
      const toolMessages = secondTurnMessages.filter(
        (message) =>
          message.role === "tool" &&
          (message.toolCallId === "empty_file_edit" ||
            message.toolCallId === "second_edit"),
      );
      expect(toolMessages[0]).toMatchObject({
        role: "tool",
        toolCallId: "empty_file_edit",
        content: expect.stringContaining("old string is empty"),
      });
      expect(toolMessages[0]?.content).toContain("Recovery:");
      expect(toolMessages[1]).toEqual({
        role: "tool",
        toolCallId: "second_edit",
        content: "Edited second.txt",
      });
      expect(events).toContainEqual({
        type: "text",
        text: "One edit was not valid and one edit succeeded.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the assistant patches multiple files after reading the update targets,
    When the agent handles the apply_patch tool call,
    Then all patch changes are visible before the assistant replies`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "src.ts"), "export const value = 1;\n");
    const provider = createFakeProvider([
      fakeToolResponse("read", { path: "src.ts" }),
      fakeToolResponse("apply_patch", {
        patch: [
          "*** Begin Patch",
          "*** Update File: src.ts",
          "@@",
          "-export const value = 1;",
          "+export const value = 2;",
          "*** Add File: docs/note.md",
          "+patched",
          "*** End Patch",
        ].join("\n"),
      }),
      fakeResponse("Applied the patch."),
    ]);

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "patch src.ts and create docs/note.md",
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(await readFile(join(workspace, "src.ts"), "utf8")).toBe(
        "export const value = 2;\n",
      );
      expect(await readFile(join(workspace, "docs", "note.md"), "utf8")).toBe(
        "patched\n",
      );
      expect(events).toContainEqual({
        type: "text",
        text: "Applied the patch.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a nested AGENTS.md applies to an apply_patch addition,
    When the assistant patches before seeing those instructions,
    Then the first patch is blocked and the retry can create the file`, async () => {
    // Given
    const workspace = await createWorkspace();
    await mkdir(join(workspace, "packages", "api"), { recursive: true });
    await writeFile(
      join(workspace, "packages", "api", "AGENTS.md"),
      "API rule: patch additions need the generated header.\n",
      "utf8",
    );
    const targetPath = join(workspace, "packages", "api", "src", "patched.ts");
    let turn = 0;
    let secondTurnMessages: readonly Message[] = [];
    let fileExistedBeforeRetry = false;
    const provider: LLMProvider = {
      id: "scoped-agents-apply-patch-retry",
      async *stream(options) {
        if (turn === 1) {
          secondTurnMessages = options.messages;
          try {
            await readFile(targetPath, "utf8");
            fileExistedBeforeRetry = true;
          } catch {
            fileExistedBeforeRetry = false;
          }
          turn++;
          yield {
            type: "tool_call",
            id: "retry_patch",
            tool: "apply_patch",
            patch: [
              "*** Begin Patch",
              "*** Add File: packages/api/src/patched.ts",
              "+// generated header",
              "+export const patched = true;",
              "*** End Patch",
            ].join("\n"),
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              uncachedInputTokens: 1,
              outputTokens: 1,
            },
          };
          return;
        }

        if (turn === 2) {
          yield { type: "text", text: "Applied scoped patch." };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              uncachedInputTokens: 1,
              outputTokens: 1,
            },
          };
          return;
        }

        turn++;
        yield {
          type: "tool_call",
          id: "initial_patch",
          tool: "apply_patch",
          patch: [
            "*** Begin Patch",
            "*** Add File: packages/api/src/patched.ts",
            "+export const patched = true;",
            "*** End Patch",
          ].join("\n"),
        };
        yield {
          type: "stop",
          reason: "stop",
          usage: {
            inputTokens: 1,
            cachedInputTokens: 0,
            uncachedInputTokens: 1,
            outputTokens: 1,
          },
        };
      },
    };

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "patch in an API file",
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      const failedToolMessage = secondTurnMessages.find(
        (message) => message.role === "tool",
      );
      expect(failedToolMessage).toMatchObject({
        role: "tool",
        toolCallId: "initial_patch",
        content: expect.stringContaining(
          "Project instructions from packages/api/AGENTS.md",
        ),
      });
      expect(failedToolMessage?.content).toContain("Tool failed:");
      expect(failedToolMessage?.content).toContain(
        "API rule: patch additions need the generated header.",
      );
      expect(failedToolMessage?.content).toContain("Recovery:");
      expect(fileExistedBeforeRetry).toBe(false);
      expect(await readFile(targetPath, "utf8")).toBe(
        "// generated header\nexport const patched = true;\n",
      );
      expect(events).toContainEqual({
        type: "text",
        text: "Applied scoped patch.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given apply_patch updates multiple files in one tool call,
    When the assistant tries to edit one patched file without rereading it,
    Then the follow-up edit is rejected until that file is read again`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "first.txt"), "first old\n", "utf8");
    await writeFile(join(workspace, "second.txt"), "second old\n", "utf8");
    let turn = 0;
    let finalTurnMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "apply-patch-invalidates-all-files",
      async *stream(options) {
        if (turn === 0) {
          turn++;
          yield {
            type: "tool_call",
            id: "read_first",
            tool: "read",
            path: "first.txt",
          };
          yield {
            type: "tool_call",
            id: "read_second",
            tool: "read",
            path: "second.txt",
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              uncachedInputTokens: 1,
              outputTokens: 1,
            },
          };
          return;
        }

        if (turn === 1) {
          turn++;
          yield {
            type: "tool_call",
            id: "patch_both",
            tool: "apply_patch",
            patch: [
              "*** Begin Patch",
              "*** Update File: first.txt",
              "@@",
              "-first old",
              "+first new",
              "*** Update File: second.txt",
              "@@",
              "-second old",
              "+second new",
              "*** End Patch",
            ].join("\n"),
          };
          yield {
            type: "tool_call",
            id: "edit_second",
            tool: "edit",
            path: "second.txt",
            edits: [{ oldText: "second new", newText: "second final" }],
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              uncachedInputTokens: 1,
              outputTokens: 1,
            },
          };
          return;
        }

        finalTurnMessages = options.messages;
        yield { type: "text", text: "Patch applied; edit needs a reread." };
        yield {
          type: "stop",
          reason: "stop",
          usage: {
            inputTokens: 1,
            cachedInputTokens: 0,
            uncachedInputTokens: 1,
            outputTokens: 1,
          },
        };
      },
    };

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "patch both files then refine second.txt",
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(await readFile(join(workspace, "first.txt"), "utf8")).toBe(
        "first new\n",
      );
      expect(await readFile(join(workspace, "second.txt"), "utf8")).toBe(
        "second new\n",
      );
      const toolMessages = finalTurnMessages.filter(
        (message) =>
          message.role === "tool" && message.toolCallId === "edit_second",
      );
      expect(toolMessages[0]?.content).toContain(
        "file has not been read: second.txt",
      );
      expect(events).toContainEqual({
        type: "text",
        text: "Patch applied; edit needs a reread.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the assistant requests an edit outside the workspace,
    When the agent handles the edit,
    Then the failure is reported and the outside file is unchanged`, async () => {
    // Given
    const workspace = await createWorkspace();
    const outside = await mkdtemp(join(tmpdir(), "keel-outside-"));
    const outsidePath = join(outside, "secret.txt");
    await writeFile(outsidePath, "do not change old\n", "utf8");
    let secondTurnMessages: readonly Message[] = [];
    const provider = createFakeProvider([
      fakeToolResponse("edit", {
        path: outsidePath,
        edits: [{ oldText: "old", newText: "new" }],
      }),
      fakeResponse("Outside path rejected."),
    ]);

    try {
      const recordingProvider: LLMProvider = {
        id: "record-outside-edit",
        async *stream(options) {
          if (options.messages.some((message) => message.role === "tool")) {
            secondTurnMessages = options.messages;
          }
          yield* provider.stream(options);
        },
      };

      // When
      const events = await collect(
        runAgent({
          workspace,
          provider: recordingProvider,
          userMessage: "edit outside",
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      const toolMessage = secondTurnMessages.find(
        (message) => message.role === "tool",
      );
      expect(toolMessage?.content).toContain("outside the workspace");
      expect(toolMessage?.content).toContain("Recovery:");
      expect(toolMessage?.content).not.toContain(await realpath(workspace));
      expect(events).toContainEqual({
        type: "text",
        text: "Outside path rejected.",
      });
      expect(await readFile(outsidePath, "utf8")).toBe("do not change old\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test(`Given the first edit cannot find the requested text,
    When the agent reports the failure and receives a corrected edit,
    Then the file is updated on disk`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "note.txt"), "hello world\n", "utf8");
    let turn = 0;
    let secondTurnMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "recover-edit",
      async *stream(options) {
        if (turn === 0) {
          turn++;
          yield {
            type: "tool_call",
            id: "read_note",
            tool: "read",
            path: "note.txt",
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              uncachedInputTokens: 1,
              outputTokens: 1,
            },
          };
          return;
        }

        if (turn === 1) {
          turn++;
          yield {
            type: "tool_call",
            id: "wrong_edit",
            tool: "edit",
            path: "note.txt",
            edits: [{ oldText: "missing", newText: "new" }],
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              uncachedInputTokens: 1,
              outputTokens: 1,
            },
          };
          return;
        }

        if (turn === 2) {
          turn++;
          secondTurnMessages = options.messages;
          yield {
            type: "tool_call",
            id: "correct_edit",
            tool: "edit",
            path: "note.txt",
            edits: [{ oldText: "world", newText: "there" }],
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 2,
              cachedInputTokens: 0,
              uncachedInputTokens: 2,
              outputTokens: 2,
            },
          };
          return;
        }

        turn++;
        yield { type: "text", text: "Done." };
        yield {
          type: "stop",
          reason: "stop",
          usage: {
            inputTokens: 3,
            cachedInputTokens: 0,
            uncachedInputTokens: 3,
            outputTokens: 3,
          },
        };
      },
    };

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "replace the word",
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      const toolMessage = secondTurnMessages.find(
        (message) =>
          message.role === "tool" && message.toolCallId === "wrong_edit",
      );
      expect(toolMessage).toMatchObject({
        role: "tool",
        toolCallId: "wrong_edit",
        content: expect.stringContaining("old string not found"),
      });
      expect(toolMessage?.content).toContain("Recovery:");
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "hello there\n",
      );
      expect(events).toContainEqual({
        type: "text",
        text: "Done.",
      });
      expect(events).toContainEqual({
        type: "end",
        usage: {
          inputTokens: 7,
          cachedInputTokens: 0,
          uncachedInputTokens: 7,
          outputTokens: 7,
        },
        turns: 4,
        stopReason: "completed",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the assistant proposes an empty text match,
    When the agent validates the edit,
    Then the failure is reported and the file is unchanged`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "note.txt"), "hello world\n", "utf8");
    let secondTurnMessages: readonly Message[] = [];
    const provider = createFakeProvider([
      fakeToolResponse("edit", {
        path: "note.txt",
        edits: [{ oldText: "", newText: "x" }],
      }),
      fakeResponse("Cannot replace empty text."),
    ]);

    try {
      const recordingProvider: LLMProvider = {
        id: "record-empty-old-string",
        async *stream(options) {
          if (options.messages.some((message) => message.role === "tool")) {
            secondTurnMessages = options.messages;
          }
          yield* provider.stream(options);
        },
      };

      // When
      const events = await collect(
        runAgent({
          workspace,
          provider: recordingProvider,
          userMessage: "replace empty text",
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      const toolMessage = secondTurnMessages.find(
        (message) => message.role === "tool",
      );
      expect(toolMessage?.content).toContain("old string is empty");
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "hello world\n",
      );
      expect(events).toContainEqual({
        type: "text",
        text: "Cannot replace empty text.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the first edit targets a missing file,
    When the agent reports the failure and receives an existing file edit,
    Then the file is updated on disk`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "note.txt"), "hello world\n", "utf8");
    let turn = 0;
    let secondTurnMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "recover-missing-edit-file",
      async *stream(options) {
        if (turn === 0) {
          turn++;
          yield {
            type: "tool_call",
            id: "read_note",
            tool: "read",
            path: "note.txt",
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              uncachedInputTokens: 1,
              outputTokens: 1,
            },
          };
          return;
        }

        if (turn === 1) {
          turn++;
          yield {
            type: "tool_call",
            id: "missing_edit",
            tool: "edit",
            path: "missing.txt",
            edits: [{ oldText: "world", newText: "there" }],
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 2,
              cachedInputTokens: 0,
              uncachedInputTokens: 2,
              outputTokens: 2,
            },
          };
          return;
        }

        if (turn === 2) {
          turn++;
          secondTurnMessages = options.messages;
          yield {
            type: "tool_call",
            id: "correct_edit",
            tool: "edit",
            path: "note.txt",
            edits: [{ oldText: "world", newText: "there" }],
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 3,
              cachedInputTokens: 0,
              uncachedInputTokens: 3,
              outputTokens: 3,
            },
          };
          return;
        }

        turn++;
        yield { type: "text", text: "Done." };
        yield {
          type: "stop",
          reason: "stop",
          usage: {
            inputTokens: 3,
            cachedInputTokens: 0,
            uncachedInputTokens: 3,
            outputTokens: 3,
          },
        };
      },
    };

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "edit missing file",
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      const toolMessage = secondTurnMessages.find(
        (message) =>
          message.role === "tool" && message.toolCallId === "missing_edit",
      );
      expect(toolMessage).toMatchObject({
        role: "tool",
        toolCallId: "missing_edit",
        content: expect.stringContaining("file not found"),
      });
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "hello there\n",
      );
      expect(events).toContainEqual({
        type: "text",
        text: "Done.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a workspace symlink points outside the workspace,
    When the agent handles an edit through the symlink,
    Then the failure is reported and the outside file is unchanged`, async () => {
    // Given
    const workspace = await createWorkspace();
    const outside = await mkdtemp(join(tmpdir(), "keel-outside-"));
    const outsidePath = join(outside, "secret.txt");
    await writeFile(outsidePath, "do not change old\n", "utf8");
    await symlink(outsidePath, join(workspace, "link.txt"));
    let secondTurnMessages: readonly Message[] = [];
    const provider = createFakeProvider([
      fakeToolResponse("edit", {
        path: "link.txt",
        edits: [{ oldText: "old", newText: "new" }],
      }),
      fakeResponse("Symlink path rejected."),
    ]);

    try {
      const recordingProvider: LLMProvider = {
        id: "record-symlink-edit",
        async *stream(options) {
          if (options.messages.some((message) => message.role === "tool")) {
            secondTurnMessages = options.messages;
          }
          yield* provider.stream(options);
        },
      };

      // When
      const events = await collect(
        runAgent({
          workspace,
          provider: recordingProvider,
          userMessage: "edit through symlink",
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      const toolMessage = secondTurnMessages.find(
        (message) => message.role === "tool",
      );
      expect(toolMessage?.content).toContain("outside the workspace");
      expect(events).toContainEqual({
        type: "text",
        text: "Symlink path rejected.",
      });
      expect(await readFile(outsidePath, "utf8")).toBe("do not change old\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test(`Given a workspace file is too large to return fully,
    When the agent reads it,
    Then the next response receives capped content with a continuation hint`, async () => {
    // Given
    const workspace = await createWorkspace();
    const largeContent = `${Array.from(
      { length: 700 },
      (_, index) => `${String(index).padStart(4, "0")}:${"x".repeat(100)}`,
    ).join("\n")}\n`;
    await writeFile(join(workspace, "large.txt"), largeContent, "utf8");
    let turn = 0;
    let secondTurnMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "capture-read",
      async *stream(options) {
        if (turn === 0) {
          turn++;
          yield {
            type: "tool_call",
            id: "read_large",
            tool: "read",
            path: "large.txt",
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              uncachedInputTokens: 1,
              outputTokens: 1,
            },
          };
          return;
        }

        secondTurnMessages = options.messages;
        yield { type: "text", text: "done" };
        yield {
          type: "stop",
          reason: "stop",
          usage: {
            inputTokens: 1,
            cachedInputTokens: 0,
            uncachedInputTokens: 1,
            outputTokens: 1,
          },
        };
      },
    };

    try {
      // When
      await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "read the large file",
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      const toolMessage = secondTurnMessages.find(
        (message) => message.role === "tool",
      );
      expect(toolMessage?.content).toContain("0000:");
      expect(toolMessage?.content).not.toContain("0699:");
      expect(
        Buffer.byteLength(toolMessage?.content ?? "", "utf8"),
      ).toBeLessThan(Buffer.byteLength(largeContent, "utf8"));
      expect(toolMessage?.content).toContain("Read output truncated");
      expect(toolMessage?.content).toContain("Use offset=");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a later portion of a file is requested,
    When the agent reads the file,
    Then the next response receives only that requested portion`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(
      join(workspace, "note.txt"),
      "one\ntwo\nthree\nfour\nfive\n",
      "utf8",
    );
    let turn = 0;
    let secondTurnMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "windowed-read",
      async *stream(options) {
        if (turn === 0) {
          turn++;
          yield {
            type: "tool_call",
            id: "read_window",
            tool: "read",
            path: "note.txt",
            offset: 3,
            limit: 2,
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              uncachedInputTokens: 1,
              outputTokens: 1,
            },
          };
          return;
        }

        secondTurnMessages = options.messages;
        yield { type: "text", text: "done" };
        yield {
          type: "stop",
          reason: "stop",
          usage: {
            inputTokens: 1,
            cachedInputTokens: 0,
            uncachedInputTokens: 1,
            outputTokens: 1,
          },
        };
      },
    };

    try {
      // When
      await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "read a file window",
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      const toolMessage = secondTurnMessages.find(
        (message) => message.role === "tool",
      );
      const content = toolMessage?.content ?? "";
      expect(content).toContain("three\nfour\n");
      expect(content).not.toContain("one\n");
      expect(content).not.toContain("two\n");
      expect(content).not.toContain("five\n");
      expect(content).toContain("Use offset=5");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the first read starts beyond the end of the file,
    When the agent reports the failure and receives a smaller offset,
    Then the next response receives the recovered file content`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "note.txt"), "one\ntwo\n", "utf8");
    let toolTurn = 0;
    let secondTurnMessages: readonly Message[] = [];
    let thirdTurnMessages: readonly Message[] = [];
    const provider = createFakeProvider([
      fakeToolResponse("read", { path: "note.txt", offset: 3 }),
      fakeToolResponse("read", { path: "note.txt", offset: 1, limit: 1 }),
      fakeResponse("done"),
    ]);
    const recordingProvider: LLMProvider = {
      id: "recover-read-offset-out-of-range",
      async *stream(options) {
        if (options.messages.some((message) => message.role === "tool")) {
          if (toolTurn === 0) {
            secondTurnMessages = options.messages;
          } else {
            thirdTurnMessages = options.messages;
          }
          toolTurn++;
        }
        yield* provider.stream(options);
      },
    };

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider: recordingProvider,
          userMessage: "read from line 3",
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      const failedToolMessage = secondTurnMessages.find(
        (message) => message.role === "tool",
      );
      expect(failedToolMessage).toMatchObject({
        role: "tool",
        toolCallId: "fake_tool_call_1",
        content: expect.stringContaining("offset 3 is beyond end of file"),
      });
      expect(failedToolMessage?.content).toContain("Recovery:");
      expect(failedToolMessage?.content).toContain("smaller offset");
      expect(failedToolMessage?.content).toContain("Available lines: 2.");
      const successfulToolMessage = thirdTurnMessages.find(
        (message) =>
          message.role === "tool" && message.toolCallId === "fake_tool_call_2",
      );
      expect(successfulToolMessage?.content).toContain("one\n");
      expect(successfulToolMessage?.content).not.toContain("two\n");
      expect(events).toContainEqual({ type: "text", text: "done" });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the first read targets a missing file,
    When the agent reports the failure and receives an existing file read,
    Then the next response receives the existing file content`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "note.txt"), "hello world\n", "utf8");
    let turn = 0;
    let secondTurnMessages: readonly Message[] = [];
    let thirdTurnMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "recover-missing-read-file",
      async *stream(options) {
        if (turn === 0) {
          turn++;
          yield {
            type: "tool_call",
            id: "missing_read",
            tool: "read",
            path: "missing.txt",
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              uncachedInputTokens: 1,
              outputTokens: 1,
            },
          };
          return;
        }

        if (turn === 1) {
          turn++;
          secondTurnMessages = options.messages;
          yield {
            type: "tool_call",
            id: "correct_read",
            tool: "read",
            path: "note.txt",
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 2,
              cachedInputTokens: 0,
              uncachedInputTokens: 2,
              outputTokens: 2,
            },
          };
          return;
        }

        thirdTurnMessages = options.messages;
        yield { type: "text", text: "done" };
        yield {
          type: "stop",
          reason: "stop",
          usage: {
            inputTokens: 3,
            cachedInputTokens: 0,
            uncachedInputTokens: 3,
            outputTokens: 3,
          },
        };
      },
    };

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "read missing file",
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      const failedToolMessage = secondTurnMessages.find(
        (message) => message.role === "tool",
      );
      expect(failedToolMessage).toMatchObject({
        role: "tool",
        toolCallId: "missing_read",
        content: expect.stringContaining("file not found"),
      });
      const successfulToolMessage = thirdTurnMessages.find(
        (message) =>
          message.role === "tool" && message.toolCallId === "correct_read",
      );
      expect(successfulToolMessage?.content).toBe("hello world\n");
      expect(events).toContainEqual({ type: "text", text: "done" });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the first read targets a directory,
    When the agent reports the failure and receives a file read,
    Then the next response receives the file content`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "note.txt"), "hello world\n", "utf8");
    let turn = 0;
    let secondTurnMessages: readonly Message[] = [];
    let thirdTurnMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "recover-read-directory-as-file",
      async *stream(options) {
        if (turn === 0) {
          turn++;
          yield {
            type: "tool_call",
            id: "directory_read",
            tool: "read",
            path: ".",
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              uncachedInputTokens: 1,
              outputTokens: 1,
            },
          };
          return;
        }

        if (turn === 1) {
          turn++;
          secondTurnMessages = options.messages;
          yield {
            type: "tool_call",
            id: "file_read",
            tool: "read",
            path: "note.txt",
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 2,
              cachedInputTokens: 0,
              uncachedInputTokens: 2,
              outputTokens: 2,
            },
          };
          return;
        }

        thirdTurnMessages = options.messages;
        yield { type: "text", text: "done" };
        yield {
          type: "stop",
          reason: "stop",
          usage: {
            inputTokens: 3,
            cachedInputTokens: 0,
            uncachedInputTokens: 3,
            outputTokens: 3,
          },
        };
      },
    };

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "inspect the workspace",
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      const failedToolMessage = secondTurnMessages.find(
        (message) => message.role === "tool",
      );
      expect(failedToolMessage).toMatchObject({
        role: "tool",
        toolCallId: "directory_read",
        content: expect.stringContaining("not a file"),
      });
      const successfulToolMessage = thirdTurnMessages.find(
        (message) =>
          message.role === "tool" && message.toolCallId === "file_read",
      );
      expect(successfulToolMessage?.content).toBe("hello world\n");
      expect(events).toContainEqual({ type: "text", text: "done" });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a workspace file contains binary bytes,
    When the agent reads it,
    Then the failure is reported and the assistant can recover`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(
      join(workspace, "blob.bin"),
      Buffer.from([0, 1, 2, 3, 0, 255]),
    );
    let streamCalls = 0;
    const provider: LLMProvider = {
      id: "binary-read",
      async *stream(options) {
        streamCalls++;
        if (streamCalls > 1) {
          const toolMessage = options.messages.find(
            (message) =>
              message.role === "tool" && message.toolCallId === "read_binary",
          );
          expect(toolMessage?.content).toContain("Tool failed:");
          expect(toolMessage?.content).toContain("binary file");
          yield { type: "text", text: "Cannot read that binary file." };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              uncachedInputTokens: 1,
              outputTokens: 1,
            },
          };
          return;
        }

        yield {
          type: "tool_call",
          id: "read_binary",
          tool: "read",
          path: "blob.bin",
        };
        yield {
          type: "stop",
          reason: "stop",
          usage: {
            inputTokens: 1,
            cachedInputTokens: 0,
            uncachedInputTokens: 1,
            outputTokens: 1,
          },
        };
      },
    };

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "read the binary file",
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(streamCalls).toBe(2);
      expect(events).toContainEqual({
        type: "text",
        text: "Cannot read that binary file.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the assistant requests an invalid read window,
    When the agent validates the read,
    Then the registry guard rejects the malformed tool call`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "note.txt"), "hello world\n", "utf8");
    const provider: LLMProvider = {
      id: "domain-invalid-read",
      async *stream() {
        yield {
          type: "tool_call",
          id: "invalid_read_window",
          tool: "read",
          path: "note.txt",
          offset: 0,
        };
        yield {
          type: "stop",
          reason: "stop",
          usage: {
            inputTokens: 1,
            cachedInputTokens: 0,
            uncachedInputTokens: 1,
            outputTokens: 1,
          },
        };
      },
    };

    try {
      // When / Then
      await expect(
        collect(
          runAgent({
            workspace,
            provider,
            userMessage: "read from line zero",
            systemPrompt: "You are a helpful assistant.",
            signal: freshSignal(),
            allowBash: false,
            stopPolicy: defaultStopPolicy(),
          }),
        ),
      ).rejects.toThrow(
        /Invalid builtin tool call for read: offset: Too small/,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the user asks about an unknown symbol,
    When the agent searches the workspace and reads a matching file,
    Then the assistant can answer from both search matches and file content`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(
      join(workspace, "app.ts"),
      "export function handleSubmit() {\n  return true;\n}\n",
      "utf8",
    );
    let turn = 0;
    let secondTurnMessages: readonly Message[] = [];
    let thirdTurnMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "grep-then-read",
      async *stream(options) {
        if (turn === 0) {
          turn++;
          yield {
            type: "tool_call",
            id: "grep_symbol",
            tool: "grep",
            pattern: "handleSubmit",
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              uncachedInputTokens: 1,
              outputTokens: 1,
            },
          };
          return;
        }

        if (turn === 1) {
          turn++;
          secondTurnMessages = options.messages;
          yield {
            type: "tool_call",
            id: "read_match",
            tool: "read",
            path: "app.ts",
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 2,
              cachedInputTokens: 0,
              uncachedInputTokens: 2,
              outputTokens: 2,
            },
          };
          return;
        }

        thirdTurnMessages = options.messages;
        yield { type: "text", text: "Found it." };
        yield {
          type: "stop",
          reason: "stop",
          usage: {
            inputTokens: 3,
            cachedInputTokens: 0,
            uncachedInputTokens: 3,
            outputTokens: 3,
          },
        };
      },
    };

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "find handleSubmit",
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      const grepMessage = secondTurnMessages.find(
        (message) => message.role === "tool",
      );
      expect(grepMessage).toMatchObject({
        role: "tool",
        toolCallId: "grep_symbol",
        content: expect.stringContaining(
          "app.ts:1:export function handleSubmit() {",
        ),
      });
      const readMessage = thirdTurnMessages.find(
        (message) =>
          message.role === "tool" && message.toolCallId === "read_match",
      );
      expect(readMessage?.content).toContain("return true;");
      expect(events).toContainEqual({ type: "text", text: "Found it." });
      expect(events).toContainEqual({
        type: "end",
        usage: {
          inputTokens: 6,
          cachedInputTokens: 0,
          uncachedInputTokens: 6,
          outputTokens: 6,
        },
        turns: 3,
        stopReason: "completed",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the agent searches and then reads a file,
    When both inspections succeed,
    Then the user receives the final answer`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(
      join(workspace, "app.ts"),
      "const target = true;\n",
      "utf8",
    );
    const provider = createFakeProvider([
      fakeToolResponse("grep", { pattern: "target" }),
      fakeToolResponse("read", { path: "app.ts" }),
      fakeResponse("Inspected app.ts."),
    ]);

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "inspect target",
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(events).toContainEqual({
        type: "text",
        text: "Inspected app.ts.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the first search request has an empty query,
    When the agent reports the failure and receives a corrected query,
    Then corrected matches are available before the final answer`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(
      join(workspace, "app.ts"),
      "const target = true;\n",
      "utf8",
    );
    let turn = 0;
    let secondTurnMessages: readonly Message[] = [];
    let thirdTurnMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "recover-empty-grep",
      async *stream(options) {
        if (turn === 0) {
          turn++;
          yield {
            type: "tool_call",
            id: "empty_grep",
            tool: "grep",
            pattern: "",
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              uncachedInputTokens: 1,
              outputTokens: 1,
            },
          };
          return;
        }

        if (turn === 1) {
          turn++;
          secondTurnMessages = options.messages;
          yield {
            type: "tool_call",
            id: "correct_grep",
            tool: "grep",
            pattern: "target",
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 2,
              cachedInputTokens: 0,
              uncachedInputTokens: 2,
              outputTokens: 2,
            },
          };
          return;
        }

        thirdTurnMessages = options.messages;
        yield { type: "text", text: "Search recovered." };
        yield {
          type: "stop",
          reason: "stop",
          usage: {
            inputTokens: 3,
            cachedInputTokens: 0,
            uncachedInputTokens: 3,
            outputTokens: 3,
          },
        };
      },
    };

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "find target",
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      const emptyPatternMessage = secondTurnMessages.find(
        (message) =>
          message.role === "tool" && message.toolCallId === "empty_grep",
      );
      expect(emptyPatternMessage?.content).toContain("pattern is empty");
      const correctedGrepMessage = thirdTurnMessages.find(
        (message) =>
          message.role === "tool" && message.toolCallId === "correct_grep",
      );
      expect(correctedGrepMessage?.content).toContain(
        "app.ts:1:const target = true;",
      );
      expect(events).toContainEqual({
        type: "text",
        text: "Search recovered.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the user cancels while a search is requested,
    When the assistant tries to search the workspace,
    Then the agent rejects the terminal search error`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "app.ts"), "const target = true;\n");
    const abortController = new AbortController();
    abortController.abort();
    const provider = createFakeProvider([
      fakeToolResponse("grep", { pattern: "target" }),
    ]);

    try {
      // When / Then
      await expect(
        collect(
          runAgent({
            workspace,
            provider,
            userMessage: "find target",
            systemPrompt: "You are a helpful assistant.",
            signal: abortController.signal,
            allowBash: false,
            stopPolicy: defaultStopPolicy(),
          }),
        ),
      ).rejects.toMatchObject({
        name: "AbortError",
        code: "ABORT_ERR",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the first search targets an ignored file,
    When the agent reports the ignored path and receives a visible file search,
    Then corrected matches are available without leaking secret content`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, ".gitignore"), "secret.txt\n", "utf8");
    await writeFile(
      join(workspace, "secret.txt"),
      "SECRET_VALUE=do-not-print\n",
      "utf8",
    );
    await writeFile(
      join(workspace, "app.ts"),
      "const target = true;\n",
      "utf8",
    );
    let turn = 0;
    let secondTurnMessages: readonly Message[] = [];
    let thirdTurnMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "recover-ignored-grep",
      async *stream(options) {
        if (turn === 0) {
          turn++;
          yield {
            type: "tool_call",
            id: "ignored_grep",
            tool: "grep",
            pattern: "SECRET_VALUE",
            path: "secret.txt",
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              uncachedInputTokens: 1,
              outputTokens: 1,
            },
          };
          return;
        }

        if (turn === 1) {
          turn++;
          secondTurnMessages = options.messages;
          yield {
            type: "tool_call",
            id: "correct_grep",
            tool: "grep",
            pattern: "target",
            path: "app.ts",
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 2,
              cachedInputTokens: 0,
              uncachedInputTokens: 2,
              outputTokens: 2,
            },
          };
          return;
        }

        thirdTurnMessages = options.messages;
        yield { type: "text", text: "Search recovered." };
        yield {
          type: "stop",
          reason: "stop",
          usage: {
            inputTokens: 3,
            cachedInputTokens: 0,
            uncachedInputTokens: 3,
            outputTokens: 3,
          },
        };
      },
    };

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "find target",
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      const ignoredPathMessage = secondTurnMessages.find(
        (message) =>
          message.role === "tool" && message.toolCallId === "ignored_grep",
      );
      expect(ignoredPathMessage?.content).toContain("ignored path");
      expect(ignoredPathMessage?.content).toContain("secret.txt");
      expect(ignoredPathMessage?.content).not.toContain("do-not-print");
      const correctedGrepMessage = thirdTurnMessages.find(
        (message) =>
          message.role === "tool" && message.toolCallId === "correct_grep",
      );
      expect(correctedGrepMessage?.content).toContain(
        "app.ts:1:const target = true;",
      );
      expect(events).toContainEqual({
        type: "text",
        text: "Search recovered.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given ignored content is requested through search and then read,
    When both secret access attempts are rejected and a visible file is retried,
    Then the secret content never enters assistant context`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, ".gitignore"), "secret.txt\n", "utf8");
    await writeFile(
      join(workspace, "secret.txt"),
      "SECRET_VALUE=do-not-print\n",
      "utf8",
    );
    await writeFile(
      join(workspace, "app.ts"),
      "const target = true;\n",
      "utf8",
    );
    let turn = 0;
    let secondTurnMessages: readonly Message[] = [];
    let thirdTurnMessages: readonly Message[] = [];
    let fourthTurnMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "ignored-file-tool-boundary",
      async *stream(options) {
        if (turn === 0) {
          turn++;
          yield {
            type: "tool_call",
            id: "ignored_grep",
            tool: "grep",
            pattern: "SECRET_VALUE",
            path: "secret.txt",
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              uncachedInputTokens: 1,
              outputTokens: 1,
            },
          };
          return;
        }

        if (turn === 1) {
          turn++;
          secondTurnMessages = options.messages;
          yield {
            type: "tool_call",
            id: "ignored_read",
            tool: "read",
            path: "secret.txt",
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 2,
              cachedInputTokens: 0,
              uncachedInputTokens: 2,
              outputTokens: 2,
            },
          };
          return;
        }

        if (turn === 2) {
          turn++;
          thirdTurnMessages = options.messages;
          yield {
            type: "tool_call",
            id: "visible_read",
            tool: "read",
            path: "app.ts",
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 3,
              cachedInputTokens: 0,
              uncachedInputTokens: 3,
              outputTokens: 3,
            },
          };
          return;
        }

        fourthTurnMessages = options.messages;
        yield { type: "text", text: "File boundary held." };
        yield {
          type: "stop",
          reason: "stop",
          usage: {
            inputTokens: 4,
            cachedInputTokens: 0,
            uncachedInputTokens: 4,
            outputTokens: 4,
          },
        };
      },
    };

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "find target",
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      const ignoredGrepMessage = secondTurnMessages.find(
        (message) =>
          message.role === "tool" && message.toolCallId === "ignored_grep",
      );
      expect(ignoredGrepMessage?.content).toContain("ignored path");
      expect(ignoredGrepMessage?.content).not.toContain("do-not-print");

      const ignoredReadMessage = thirdTurnMessages.find(
        (message) =>
          message.role === "tool" && message.toolCallId === "ignored_read",
      );
      expect(ignoredReadMessage?.content).toContain("ignored path");
      expect(ignoredReadMessage?.content).not.toContain("do-not-print");

      const visibleReadMessage = fourthTurnMessages.find(
        (message) =>
          message.role === "tool" && message.toolCallId === "visible_read",
      );
      expect(visibleReadMessage?.content).toContain("const target = true;");
      expect(
        [
          ...secondTurnMessages,
          ...thirdTurnMessages,
          ...fourthTurnMessages,
        ].some(
          (message) =>
            message.role === "tool" && message.content.includes("do-not-print"),
        ),
      ).toBe(false);
      expect(events).toContainEqual({
        type: "text",
        text: "File boundary held.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an ignored edit fails and the assistant next requests the filesystem root,
    When the outside-workspace read is rejected and a visible file is retried,
    Then the agent recovers without exposing the ignored secret`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, ".gitignore"), "secret.env\n", "utf8");
    await writeFile(join(workspace, "secret.env"), "sk-leaked-123\n", "utf8");
    await writeFile(
      join(workspace, "app.ts"),
      "const target = true;\n",
      "utf8",
    );
    let turn = 0;
    let secondTurnMessages: readonly Message[] = [];
    let thirdTurnMessages: readonly Message[] = [];
    let fourthTurnMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "recover-outside-after-ignored-edit",
      async *stream(options) {
        if (turn === 0) {
          turn++;
          yield {
            type: "tool_call",
            id: "ignored_edit",
            tool: "edit",
            path: "secret.env",
            edits: [{ oldText: "sk-leaked-123", newText: "new-key" }],
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              uncachedInputTokens: 1,
              outputTokens: 1,
            },
          };
          return;
        }

        if (turn === 1) {
          turn++;
          secondTurnMessages = options.messages;
          yield {
            type: "tool_call",
            id: "root_read",
            tool: "read",
            path: "/",
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 2,
              cachedInputTokens: 0,
              uncachedInputTokens: 2,
              outputTokens: 2,
            },
          };
          return;
        }

        if (turn === 2) {
          turn++;
          thirdTurnMessages = options.messages;
          yield {
            type: "tool_call",
            id: "visible_read",
            tool: "read",
            path: "app.ts",
          };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 3,
              cachedInputTokens: 0,
              uncachedInputTokens: 3,
              outputTokens: 3,
            },
          };
          return;
        }

        fourthTurnMessages = options.messages;
        yield { type: "text", text: "Recovered after outside path." };
        yield {
          type: "stop",
          reason: "stop",
          usage: {
            inputTokens: 4,
            cachedInputTokens: 0,
            uncachedInputTokens: 4,
            outputTokens: 4,
          },
        };
      },
    };

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "change the leaked key",
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      const ignoredEditMessage = secondTurnMessages.find(
        (message) =>
          message.role === "tool" && message.toolCallId === "ignored_edit",
      );
      expect(ignoredEditMessage?.content).toContain("ignored path");
      expect(ignoredEditMessage?.content).not.toContain("sk-leaked-123");

      const outsideReadMessage = thirdTurnMessages.find(
        (message) =>
          message.role === "tool" && message.toolCallId === "root_read",
      );
      expect(outsideReadMessage?.content).toContain("outside the workspace");

      const visibleReadMessage = fourthTurnMessages.find(
        (message) =>
          message.role === "tool" && message.toolCallId === "visible_read",
      );
      expect(visibleReadMessage?.content).toContain("const target = true;");
      expect(
        [
          ...secondTurnMessages,
          ...thirdTurnMessages,
          ...fourthTurnMessages,
        ].some(
          (message) =>
            message.role === "tool" &&
            message.content.includes("sk-leaked-123"),
        ),
      ).toBe(false);
      expect(await readFile(join(workspace, "secret.env"), "utf8")).toBe(
        "sk-leaked-123\n",
      );
      expect(events).toContainEqual({
        type: "text",
        text: "Recovered after outside path.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a text-named workspace file contains binary bytes,
    When the agent reads it,
    Then content sniffing reports the failure and the assistant can recover`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "blob.txt"), Buffer.from([65, 0, 66]));
    let streamCalls = 0;
    const provider: LLMProvider = {
      id: "binary-sniff-read",
      async *stream(options) {
        streamCalls++;
        if (streamCalls > 1) {
          const toolMessage = options.messages.find(
            (message) =>
              message.role === "tool" &&
              message.toolCallId === "read_binary_text",
          );
          expect(toolMessage?.content).toContain("Tool failed:");
          expect(toolMessage?.content).toContain("binary file");
          yield { type: "text", text: "Cannot read that text file." };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              uncachedInputTokens: 1,
              outputTokens: 1,
            },
          };
          return;
        }

        yield {
          type: "tool_call",
          id: "read_binary_text",
          tool: "read",
          path: "blob.txt",
        };
        yield {
          type: "stop",
          reason: "stop",
          usage: {
            inputTokens: 1,
            cachedInputTokens: 0,
            uncachedInputTokens: 1,
            outputTokens: 1,
          },
        };
      },
    };

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "read the text-named binary file",
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(streamCalls).toBe(2);
      expect(events).toContainEqual({
        type: "text",
        text: "Cannot read that text file.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given replacement text appears more than once,
    When the agent validates the edit,
    Then the failure is reported for recovery and the file is unchanged`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "note.txt"), "old then old\n", "utf8");
    let secondTurnMessages: readonly Message[] = [];
    const provider = createFakeProvider([
      fakeToolResponse("read", { path: "note.txt" }),
      fakeToolResponse("edit", {
        path: "note.txt",
        edits: [{ oldText: "old", newText: "new" }],
      }),
      fakeResponse("Need more context."),
    ]);

    try {
      const recordingProvider: LLMProvider = {
        id: "record-duplicate-edit",
        async *stream(options) {
          if (options.messages.some((message) => message.role === "tool")) {
            secondTurnMessages = options.messages;
          }
          yield* provider.stream(options);
        },
      };

      // When
      const events = await collect(
        runAgent({
          workspace,
          provider: recordingProvider,
          userMessage: "replace duplicate text",
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      const toolMessage = secondTurnMessages.find(
        (message) =>
          message.role === "tool" && message.toolCallId === "fake_tool_call_2",
      );
      expect(toolMessage).toMatchObject({
        role: "tool",
        toolCallId: "fake_tool_call_2",
        content: expect.stringContaining("old string appears"),
      });
      expect(toolMessage?.content).toContain("Recovery:");
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "old then old\n",
      );
      expect(events).toContainEqual({
        type: "text",
        text: "Need more context.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a file-change response ends before completion,
    When the agent detects the incomplete response,
    Then it throws and the file is unchanged`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "note.txt"), "hello old world\n", "utf8");
    const provider: LLMProvider = {
      id: "broken",
      async *stream() {
        yield {
          type: "tool_call",
          id: "broken_edit",
          tool: "edit",
          path: "note.txt",
          edits: [{ oldText: "old", newText: "new" }],
        };
      },
    };

    try {
      // When / Then
      await expect(
        collect(
          runAgent({
            workspace,
            provider,
            userMessage: "edit the file",
            systemPrompt: "You are a helpful assistant.",
            signal: freshSignal(),
            allowBash: false,
            stopPolicy: defaultStopPolicy(),
          }),
        ),
      ).rejects.toThrow("LLM stream ended without stop event");
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "hello old world\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given two workspace files each contain a typo,
    When user asks to fix both,
    Then both files are edited in one session`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "a.txt"), "hello wrold\n", "utf8");
    await writeFile(join(workspace, "b.txt"), "goodby world\n", "utf8");
    const provider = createFakeProvider([
      fakeToolResponse("read", { path: "a.txt" }),
      fakeToolResponse("read", { path: "b.txt" }),
      fakeToolResponse("edit", {
        path: "a.txt",
        edits: [{ oldText: "wrold", newText: "world" }],
      }),
      fakeToolResponse("edit", {
        path: "b.txt",
        edits: [{ oldText: "goodby", newText: "goodbye" }],
      }),
      fakeResponse("Fixed both files."),
    ]);

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "fix the typos in both files",
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "hello world\n",
      );
      expect(await readFile(join(workspace, "b.txt"), "utf8")).toBe(
        "goodbye world\n",
      );
      expect(events).toContainEqual({
        type: "text",
        text: "Fixed both files.",
      });
      expect(events.filter((e) => e.type === "end")).toHaveLength(1);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a task edits two files before the provider fails,
    When the user restores the last checkpoint,
    Then both completed edits are undone together`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-edit-failed-task-");
    await writeFile(join(workspace, "a.txt"), "alpha old\n", "utf8");
    await writeFile(join(workspace, "b.txt"), "beta old\n", "utf8");
    const provider = createFakeProvider([
      fakeToolResponse("read", { path: "a.txt" }),
      fakeToolResponse("edit", {
        path: "a.txt",
        edits: [{ oldText: "old", newText: "new" }],
      }),
      fakeToolResponse("read", { path: "b.txt" }),
      fakeToolResponse("edit", {
        path: "b.txt",
        edits: [{ oldText: "old", newText: "new" }],
      }),
    ]);

    try {
      // When
      await expect(
        collect(
          runAgent({
            workspace,
            provider,
            userMessage: "update both files",
            systemPrompt: "You are a helpful assistant.",
            signal: freshSignal(),
            allowBash: false,
            stopPolicy: defaultStopPolicy(),
          }),
        ),
      ).rejects.toThrow("fake provider: script exhausted");
      const restore = restoreLastEditCheckpoint(workspace);

      // Then
      expect(restore).toEqual({
        status: "restored",
        restoredLabel: "2 files",
      });
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe(
        "alpha old\n",
      );
      expect(await readFile(join(workspace, "b.txt"), "utf8")).toBe(
        "beta old\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a task creates through a symlink and edits through the real path,
    When the user restores the last checkpoint,
    Then the created file is removed as one task change`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-edit-symlink-task-");
    await mkdir(join(workspace, "real"));
    await symlink("real", join(workspace, "link"));
    const provider = createFakeProvider([
      fakeToolResponse("apply_patch", {
        patch: [
          "*** Begin Patch",
          "*** Add File: link/note.txt",
          "+initial",
          "*** End Patch",
        ].join("\n"),
      }),
      fakeToolResponse("read", { path: "real/note.txt" }),
      fakeToolResponse("edit", {
        path: "real/note.txt",
        edits: [{ oldText: "initial", newText: "final" }],
      }),
    ]);

    try {
      // When
      await expect(
        collect(
          runAgent({
            workspace,
            provider,
            userMessage: "create then update the file",
            systemPrompt: "You are a helpful assistant.",
            signal: freshSignal(),
            allowBash: false,
            stopPolicy: defaultStopPolicy(),
          }),
        ),
      ).rejects.toThrow("fake provider: script exhausted");
      const restore = restoreLastEditCheckpoint(workspace);

      // Then
      expect(restore).toEqual({
        status: "restored",
        restoredLabel: "real/note.txt",
      });
      await expect(
        readFile(join(workspace, "real", "note.txt"), "utf8"),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a workspace file with a bug,
    When the agent reads it then edits it,
    Then the agent replies with a summary after the edit`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "app.ts"), "const x = nul;\n", "utf8");
    const provider = createFakeProvider([
      fakeToolResponse("read", { path: "app.ts" }),
      fakeToolResponse("edit", {
        path: "app.ts",
        edits: [{ oldText: "nul", newText: "null" }],
      }),
      fakeResponse("Fixed the null typo."),
    ]);

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "fix the bug in app.ts",
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(await readFile(join(workspace, "app.ts"), "utf8")).toBe(
        "const x = null;\n",
      );
      expect(events).toContainEqual({
        type: "text",
        text: "Fixed the null typo.",
      });
      expect(events.filter((e) => e.type === "end")).toHaveLength(1);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
