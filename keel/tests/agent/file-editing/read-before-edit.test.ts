import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runAgent, runAgentTurn } from "../../../src/agent/loop.ts";
import { createReadVisibilityState } from "../../../src/agent/read-visibility.ts";
import { defaultStopPolicy } from "../../../src/agent/stop-policy.ts";
import {
  createFakeProvider,
  fakeResponse,
  fakeToolResponse,
} from "../../../src/llm/providers/fake.ts";
import type { LLMProvider, Message } from "../../../src/llm/types.ts";
import {
  collect,
  createWorkspace,
  freshSignal,
} from "../../../src/testing/file-editing-fixtures.ts";

describe("File Editing Read Before Edit", () => {
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
});
