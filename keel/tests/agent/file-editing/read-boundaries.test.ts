import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runAgent } from "../../../src/agent/loop.ts";
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

describe("File Editing Read Boundaries", () => {
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
          bash: { kind: "disabled" },
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
          bash: { kind: "disabled" },
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
          bash: { kind: "disabled" },
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
          bash: { kind: "disabled" },
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
          bash: { kind: "disabled" },
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
          bash: { kind: "disabled" },
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
    Then it reports the malformed tool call and continues`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "note.txt"), "hello world\n", "utf8");
    const provider: LLMProvider = {
      id: "domain-invalid-read",
      async *stream(options) {
        const toolFeedback =
          options.messages.findLast((message) => message.role === "tool")
            ?.content ?? "";
        if (toolFeedback !== "") {
          yield { type: "text", text: "The read window was invalid." };
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
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "read from line zero",
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          bash: { kind: "disabled" },
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(events).toContainEqual({
        type: "tool_end",
        toolCall: {
          id: "invalid_read_window",
          tool: "read",
          path: "note.txt",
          offset: 0,
        },
        ok: false,
      });
      expect(events).toContainEqual({
        type: "text",
        text: "The read window was invalid.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
