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

describe("File Editing Search And Ignore", () => {
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
});
