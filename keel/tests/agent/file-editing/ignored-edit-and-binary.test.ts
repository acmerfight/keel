import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runAgent } from "../../../src/agent/loop.ts";
import { defaultStopPolicy } from "../../../src/agent/stop-policy.ts";
import type { LLMProvider, Message } from "../../../src/llm/types.ts";
import {
  collect,
  createWorkspace,
  freshSignal,
} from "../../../src/testing/file-editing-fixtures.ts";

describe("File Editing Ignored Edit And Binary", () => {
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
});
