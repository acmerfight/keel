import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../src/agent/loop.ts";
import { runAgent } from "../../src/agent/loop.ts";
import type { LLMProvider, Message } from "../../src/llm/types.ts";
import {
  createFakeProvider,
  fakeEditResponse,
  fakeGrepResponse,
  fakeReadResponse,
  fakeResponse,
} from "../../src/testing/fake-provider.ts";

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
  test(`Given a file in the workspace contains an old word,
    When the LLM asks the agent to edit the file,
    Then the file is updated on disk`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "note.txt"), "hello old world\n", "utf8");
    const provider = createFakeProvider([
      fakeEditResponse("note.txt", "old", "new"),
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
        }),
      );

      // Then
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "hello new world\n",
      );
      expect(events).toContainEqual({
        type: "text",
        text: "Edited note.txt",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given one LLM turn contains multiple tool calls,
    When the agent runs tool calls,
    Then it rejects the turn and leaves the file unchanged`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "note.txt"), "hello old world\n", "utf8");
    const provider: LLMProvider = {
      id: "multiple-edits",
      async *stream() {
        yield {
          type: "tool_call",
          id: "first_edit",
          tool: "edit",
          path: "note.txt",
          oldString: "old",
          newString: "new",
        };
        yield {
          type: "tool_call",
          id: "second_edit",
          tool: "edit",
          path: "note.txt",
          oldString: "new",
          newString: "second",
        };
        yield { type: "stop", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };

    try {
      // When / Then
      await expect(
        collect(
          runAgent({
            workspace,
            provider,
            userMessage: "edit once",
            systemPrompt: "You are a helpful assistant.",
            signal: freshSignal(),
          }),
        ),
      ).rejects.toThrow("multiple tool calls");
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "hello old world\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the LLM asks to edit a file outside the workspace,
    When the agent runs the edit tool,
    Then the edit is rejected and the outside file is unchanged`, async () => {
    // Given
    const workspace = await createWorkspace();
    const outside = await mkdtemp(join(tmpdir(), "keel-outside-"));
    const outsidePath = join(outside, "secret.txt");
    await writeFile(outsidePath, "do not change old\n", "utf8");
    const provider = createFakeProvider([
      fakeEditResponse(outsidePath, "old", "new"),
    ]);

    try {
      // When / Then
      await expect(
        collect(
          runAgent({
            workspace,
            provider,
            userMessage: "edit outside",
            systemPrompt: "You are a helpful assistant.",
            signal: freshSignal(),
          }),
        ),
      ).rejects.toThrow("outside the workspace");
      expect(await readFile(outsidePath, "utf8")).toBe("do not change old\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test(`Given the LLM first edits text that is not in the file,
    When the tool reports the failure and the LLM retries with the right text,
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
            id: "wrong_edit",
            tool: "edit",
            path: "note.txt",
            oldString: "missing",
            newString: "new",
          };
          yield { type: "stop", usage: { inputTokens: 1, outputTokens: 1 } };
          return;
        }

        secondTurnMessages = options.messages;
        yield {
          type: "tool_call",
          id: "correct_edit",
          tool: "edit",
          path: "note.txt",
          oldString: "world",
          newString: "there",
        };
        yield { type: "stop", usage: { inputTokens: 2, outputTokens: 2 } };
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
        }),
      );

      // Then
      const toolMessage = secondTurnMessages.find(
        (message) => message.role === "tool",
      );
      expect(toolMessage).toMatchObject({
        role: "tool",
        toolCallId: "wrong_edit",
        content: expect.stringContaining("old string not found"),
      });
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "hello there\n",
      );
      expect(events).toContainEqual({
        type: "text",
        text: "Edited note.txt",
      });
      expect(events).toContainEqual({
        type: "end",
        usage: { inputTokens: 3, outputTokens: 3 },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the LLM sends an empty old string,
    When the agent runs the edit tool,
    Then the edit is rejected and the file is unchanged`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "note.txt"), "hello world\n", "utf8");
    const provider = createFakeProvider([
      fakeEditResponse("note.txt", "", "x"),
    ]);

    try {
      // When / Then
      await expect(
        collect(
          runAgent({
            workspace,
            provider,
            userMessage: "replace empty text",
            systemPrompt: "You are a helpful assistant.",
            signal: freshSignal(),
          }),
        ),
      ).rejects.toThrow("old string is empty");
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "hello world\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the LLM first edits a nonexistent file,
    When the tool reports the failure and the LLM retries with an existing file,
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
            id: "missing_edit",
            tool: "edit",
            path: "missing.txt",
            oldString: "world",
            newString: "there",
          };
          yield { type: "stop", usage: { inputTokens: 1, outputTokens: 1 } };
          return;
        }

        secondTurnMessages = options.messages;
        yield {
          type: "tool_call",
          id: "correct_edit",
          tool: "edit",
          path: "note.txt",
          oldString: "world",
          newString: "there",
        };
        yield { type: "stop", usage: { inputTokens: 2, outputTokens: 2 } };
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
        }),
      );

      // Then
      const toolMessage = secondTurnMessages.find(
        (message) => message.role === "tool",
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
        text: "Edited note.txt",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a symlink inside the workspace points outside,
    When the LLM edits via the symlink,
    Then the edit is rejected and the outside file is unchanged`, async () => {
    // Given
    const workspace = await createWorkspace();
    const outside = await mkdtemp(join(tmpdir(), "keel-outside-"));
    const outsidePath = join(outside, "secret.txt");
    await writeFile(outsidePath, "do not change old\n", "utf8");
    await symlink(outsidePath, join(workspace, "link.txt"));
    const provider = createFakeProvider([
      fakeEditResponse("link.txt", "old", "new"),
    ]);

    try {
      // When / Then
      await expect(
        collect(
          runAgent({
            workspace,
            provider,
            userMessage: "edit through symlink",
            systemPrompt: "You are a helpful assistant.",
            signal: freshSignal(),
          }),
        ),
      ).rejects.toThrow("outside the workspace");
      expect(await readFile(outsidePath, "utf8")).toBe("do not change old\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test(`Given a workspace file exceeds the read output budget,
    When the LLM asks the agent to read it,
    Then the next LLM request receives capped content with a continuation hint`, async () => {
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
          yield { type: "stop", usage: { inputTokens: 1, outputTokens: 1 } };
          return;
        }

        secondTurnMessages = options.messages;
        yield { type: "text", text: "done" };
        yield { type: "stop", usage: { inputTokens: 1, outputTokens: 1 } };
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

  test(`Given the LLM asks to read a later file window,
    When the agent runs the read tool,
    Then the next LLM request receives only that requested window`, async () => {
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
          yield { type: "stop", usage: { inputTokens: 1, outputTokens: 1 } };
          return;
        }

        secondTurnMessages = options.messages;
        yield { type: "text", text: "done" };
        yield { type: "stop", usage: { inputTokens: 1, outputTokens: 1 } };
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

  test(`Given the LLM first reads a nonexistent file,
    When the tool reports the failure and the LLM retries with an existing file,
    Then the next LLM request receives the existing file content`, async () => {
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
          yield { type: "stop", usage: { inputTokens: 1, outputTokens: 1 } };
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
          yield { type: "stop", usage: { inputTokens: 2, outputTokens: 2 } };
          return;
        }

        thirdTurnMessages = options.messages;
        yield { type: "text", text: "done" };
        yield { type: "stop", usage: { inputTokens: 3, outputTokens: 3 } };
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

  test(`Given the LLM first reads a directory as a file,
    When the tool reports the failure and the LLM retries with a file,
    Then the next LLM request receives the file content`, async () => {
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
          yield { type: "stop", usage: { inputTokens: 1, outputTokens: 1 } };
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
          yield { type: "stop", usage: { inputTokens: 2, outputTokens: 2 } };
          return;
        }

        thirdTurnMessages = options.messages;
        yield { type: "text", text: "done" };
        yield { type: "stop", usage: { inputTokens: 3, outputTokens: 3 } };
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
    When the LLM asks the agent to read it,
    Then the read is rejected before content is sent back to the LLM`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(
      join(workspace, "blob.bin"),
      Buffer.from([0, 1, 2, 3, 0, 255]),
    );
    let streamCalls = 0;
    const provider: LLMProvider = {
      id: "binary-read",
      async *stream() {
        streamCalls++;
        if (streamCalls > 1) {
          throw new Error("binary read content reached the second LLM request");
        }

        yield {
          type: "tool_call",
          id: "read_binary",
          tool: "read",
          path: "blob.bin",
        };
        yield { type: "stop", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };

    try {
      // When / Then
      await expect(
        collect(
          runAgent({
            workspace,
            provider,
            userMessage: "read the binary file",
            systemPrompt: "You are a helpful assistant.",
            signal: freshSignal(),
          }),
        ),
      ).rejects.toThrow("binary file");
      expect(streamCalls).toBe(1);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the user asks about an unknown symbol,
    When the LLM searches the workspace and then reads a matching file,
    Then the agent sends grep matches and file content back to the LLM`, async () => {
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
          yield { type: "stop", usage: { inputTokens: 1, outputTokens: 1 } };
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
          yield { type: "stop", usage: { inputTokens: 2, outputTokens: 2 } };
          return;
        }

        thirdTurnMessages = options.messages;
        yield { type: "text", text: "Found it." };
        yield { type: "stop", usage: { inputTokens: 3, outputTokens: 3 } };
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
        usage: { inputTokens: 6, outputTokens: 6 },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a fake provider searches then reads a file,
    When the agent runs the scripted tool calls,
    Then the user receives the final answer`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(
      join(workspace, "app.ts"),
      "const target = true;\n",
      "utf8",
    );
    const provider = createFakeProvider([
      fakeGrepResponse("target"),
      fakeReadResponse("app.ts"),
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

  test(`Given a text-named workspace file contains binary bytes,
    When the LLM asks the agent to read it,
    Then the read is rejected by content sniffing before reaching the LLM`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "blob.txt"), Buffer.from([65, 0, 66]));
    let streamCalls = 0;
    const provider: LLMProvider = {
      id: "binary-sniff-read",
      async *stream() {
        streamCalls++;
        if (streamCalls > 1) {
          throw new Error("binary read content reached the second LLM request");
        }

        yield {
          type: "tool_call",
          id: "read_binary_text",
          tool: "read",
          path: "blob.txt",
        };
        yield { type: "stop", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };

    try {
      // When / Then
      await expect(
        collect(
          runAgent({
            workspace,
            provider,
            userMessage: "read the text-named binary file",
            systemPrompt: "You are a helpful assistant.",
            signal: freshSignal(),
          }),
        ),
      ).rejects.toThrow("binary file");
      expect(streamCalls).toBe(1);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the old text appears more than once,
    When the LLM asks the agent to edit that text,
    Then the edit is rejected and the file is unchanged`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "note.txt"), "old then old\n", "utf8");
    const provider = createFakeProvider([
      fakeEditResponse("note.txt", "old", "new"),
    ]);

    try {
      // When / Then
      await expect(
        collect(
          runAgent({
            workspace,
            provider,
            userMessage: "replace duplicate text",
            systemPrompt: "You are a helpful assistant.",
            signal: freshSignal(),
          }),
        ),
      ).rejects.toThrow("old string is not unique");
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "old then old\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the LLM stream yields a tool_call but never yields stop,
    When the agent finishes reading the stream,
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
          oldString: "old",
          newString: "new",
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
});
