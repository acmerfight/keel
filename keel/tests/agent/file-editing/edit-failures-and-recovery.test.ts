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
import { runAgent } from "../../../src/agent/loop.ts";
import { defaultStopPolicy } from "../../../src/agent/stop-policy.ts";
import { restoreLastEditCheckpoint } from "../../../src/core/git.ts";
import {
  createFakeProvider,
  fakeResponse,
  fakeToolResponse,
} from "../../../src/llm/providers/fake.ts";
import type { LLMProvider, Message } from "../../../src/llm/types.ts";
import { createGitWorkspace } from "../../../src/testing/cli-harness.ts";
import {
  collect,
  createWorkspace,
  freshSignal,
} from "../../../src/testing/file-editing-fixtures.ts";

describe("File Editing Failures And Recovery", () => {
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
          bash: { kind: "disabled" },
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
    When the agent reports current file context and receives a corrected edit,
    Then the file is updated on disk without an extra read`, async () => {
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
          bash: { kind: "disabled" },
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
      expect(toolMessage?.content).toContain(
        "Current file context for note.txt:",
      );
      expect(toolMessage?.content).toContain("1 | hello world");
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
          bash: { kind: "disabled" },
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
          bash: { kind: "disabled" },
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
          bash: { kind: "disabled" },
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
          bash: { kind: "disabled" },
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
            bash: { kind: "disabled" },
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
          bash: { kind: "disabled" },
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
            bash: { kind: "disabled" },
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
            bash: { kind: "disabled" },
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
});
