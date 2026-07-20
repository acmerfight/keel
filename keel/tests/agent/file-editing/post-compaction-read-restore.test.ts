import { readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../../src/agent/events.ts";
import { runAgentTurn } from "../../../src/agent/loop.ts";
import { restorePostCompactionReads } from "../../../src/agent/post-compaction-restore.ts";
import { createReadVisibilityState } from "../../../src/agent/read-visibility.ts";
import { defaultStopPolicy } from "../../../src/agent/stop-policy.ts";
import type { LLMProvider, Message } from "../../../src/llm/types.ts";
import {
  collect,
  createWorkspace,
  freshSignal,
} from "../../../src/testing/file-editing-fixtures.ts";
import { successfulReadToolExecution } from "../../../src/testing/tool-execution-fixtures.ts";
import { createProjectInstructionVisibilityState } from "../../../src/tools/scoped-project-instructions.ts";

const CURRENT_TOOL_OUTPUT_MARKER =
  "[current tool output compacted after context overflow: approximately omitted 100 chars; rerun the tool with narrower parameters if needed]";

describe("File Editing Post-Compaction Read Restore", () => {
  test(`Given a compacted current windowed read is still retained,
    When recent reads are restored after compaction,
    Then that retained read window is not restored again`, async () => {
    // Given
    const workspace = await createWorkspace();
    const notePath = join(workspace, "note.txt");
    await writeFile(notePath, "first\nsecond\nthird\n", "utf8");
    const noteTargetPath = await realpath(notePath);
    const messages: Message[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "read_current_window",
            tool: "read",
            path: "note.txt",
            offset: 2,
            limit: 1,
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "read_current_window",
        content: `second\n${CURRENT_TOOL_OUTPUT_MARKER}`,
      },
    ];
    const readVisibility = createReadVisibilityState();
    const projectInstructionVisibility =
      createProjectInstructionVisibilityState(workspace);
    readVisibility.applyVisibleToolExecutions([
      successfulReadToolExecution({
        targetPath: noteTargetPath,
        offset: 2,
        limit: 1,
      }),
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
      expect(sequence).toBe(0);
      expect(messages).toEqual([
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "read_current_window",
              tool: "read",
              path: "note.txt",
              offset: 2,
              limit: 1,
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "read_current_window",
          content: `second\n${CURRENT_TOOL_OUTPUT_MARKER}`,
        },
      ]);
      expect(readVisibility.hasRead(noteTargetPath)).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a compacted current non-read tool output is retained,
    When recent reads are restored after compaction,
    Then unrelated visible reads are still restored`, async () => {
    // Given
    const workspace = await createWorkspace();
    const notePath = join(workspace, "note.txt");
    await writeFile(notePath, "visible note\n", "utf8");
    const noteTargetPath = await realpath(notePath);
    const messages: Message[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "grep_current_log",
            tool: "grep",
            pattern: "needle",
            path: "current.log",
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "grep_current_log",
        content: `large grep output\n${CURRENT_TOOL_OUTPUT_MARKER}`,
      },
    ];
    const readVisibility = createReadVisibilityState();
    const projectInstructionVisibility =
      createProjectInstructionVisibilityState(workspace);
    readVisibility.applyVisibleToolExecutions([
      successfulReadToolExecution({ targetPath: noteTargetPath }),
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
      expect(sequence).toBe(1);
      expect(messages).toEqual([
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "grep_current_log",
              tool: "grep",
              pattern: "needle",
              path: "current.log",
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "grep_current_log",
          content: `large grep output\n${CURRENT_TOOL_OUTPUT_MARKER}`,
        },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            expect.objectContaining({
              id: "post_compaction_read_0",
              tool: "read",
              path: noteTargetPath,
            }),
          ],
        },
        {
          role: "tool",
          toolCallId: "post_compaction_read_0",
          content: "visible note\n",
          resourceObservation: expect.objectContaining({
            kind: "read_projection",
          }),
        },
      ]);
      expect(readVisibility.hasRead(noteTargetPath)).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a previous read is compacted before the next model request,
    When the assistant edits that file without manually rereading,
    Then the edit uses a fresh post-compaction read snapshot`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(
      join(workspace, "note.txt"),
      `hello old world\n${"old filler line\n".repeat(500)}`,
      "utf8",
    );
    let turn = 0;
    const messages: Message[] = [{ role: "user", content: "read note.txt" }];
    const readVisibility = createReadVisibilityState();
    let editRequestMessages: readonly Message[] = [];
    let finalMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "compacted-read-before-edit",
      async *stream(options) {
        if (options.toolExposure?.kind === "none") {
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
          bash: { kind: "disabled" },
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
          bash: { kind: "disabled" },
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

  test(`Given a windowed file read is compacted before the next model request,
    When the assistant edits that later file section without manually rereading,
    Then the restored read uses the same window`, async () => {
    // Given
    const workspace = await createWorkspace();
    const targetOffset = 2101;
    const oldLineSuffix = "old filler ".repeat(500);
    const prefix = Array.from(
      { length: targetOffset - 1 },
      (_, index) => `filler ${index}`,
    ).join("\n");
    await writeFile(
      join(workspace, "note.txt"),
      `${prefix}\ntarget old value ${oldLineSuffix}\n`,
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
        if (options.toolExposure?.kind === "none") {
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
          bash: { kind: "disabled" },
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
          bash: { kind: "disabled" },
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
        if (options.toolExposure?.kind === "none") {
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
          bash: { kind: "disabled" },
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
          bash: { kind: "disabled" },
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
      successfulReadToolExecution({ targetPath: keepTargetPath }),
      successfulReadToolExecution({ targetPath: goneTargetPath }),
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
          resourceObservation: expect.objectContaining({
            kind: "read_projection",
          }),
        },
      ]);
      expect(readVisibility.hasRead(keepTargetPath)).toBe(true);
      expect(readVisibility.hasRead(goneTargetPath)).toBe(false);
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
      successfulReadToolExecution({ targetPath: afterBudgetTargetPath }),
      successfulReadToolExecution({ targetPath: tinyBudgetTargetPath }),
      successfulReadToolExecution({ targetPath: fillerTargetPath }),
      successfulReadToolExecution({ targetPath: largeBTargetPath }),
      successfulReadToolExecution({ targetPath: largeATargetPath }),
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
});
