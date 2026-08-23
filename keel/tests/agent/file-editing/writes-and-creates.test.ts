import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
import type { LLMProvider, ProviderMessage } from "../../../src/llm/types.ts";
import { createGitWorkspace } from "../../../src/testing/cli-harness.ts";
import {
  collect,
  createWorkspace,
  freshSignal,
} from "../../../src/testing/file-editing-fixtures.ts";

describe("File Editing Writes And Creates", () => {
  test(`Given a consumer stops reading after the assistant text for a file-changing task,
    When the agent stream closes before its terminal event,
    Then the task checkpoint is still available for undo`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-agent-early-close-");
    const provider = createFakeProvider([
      fakeToolResponse("write", {
        path: "config.json",
        content: '{"created":true}\n',
      }),
      fakeResponse("Created config.json."),
    ]);

    try {
      // When
      for await (const event of runAgent({
        workspace,
        provider,
        userMessage: "create config.json",
        systemPrompt: "You are a helpful assistant.",
        signal: freshSignal(),
        bash: { kind: "trusted" },
        stopPolicy: defaultStopPolicy(),
      })) {
        if (event.type === "text") break;
      }
      const restored = restoreLastEditCheckpoint(workspace);

      // Then
      expect(restored).toEqual({
        status: "restored",
        restoredLabel: "config.json",
      });
      await expect(
        readFile(join(workspace, "config.json"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the assistant requests a new workspace file,
    When the agent handles the write tool call,
    Then the file is created and one unavailable checkpoint event precedes the terminal end`, async () => {
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
          bash: { kind: "trusted" },
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
      expect(
        events.filter((event) => event.type === "undo_checkpoint"),
      ).toEqual([
        {
          type: "undo_checkpoint",
          written: false,
          reason: "git_workspace_unavailable",
        },
      ]);
      expect(events.at(-2)).toEqual({
        type: "undo_checkpoint",
        written: false,
        reason: "git_workspace_unavailable",
      });
      expect(events.at(-1)).toMatchObject({ type: "end" });
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
    let secondTurnMessages: readonly ProviderMessage[] = [];
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
          bash: { kind: "trusted" },
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
    let secondTurnMessages: readonly ProviderMessage[] = [];
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
          bash: { kind: "trusted" },
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
    let secondTurnMessages: readonly ProviderMessage[] = [];
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
          bash: { kind: "trusted" },
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
    let secondTurnMessages: readonly ProviderMessage[] = [];
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
          bash: { kind: "trusted" },
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
          bash: { kind: "trusted" },
          stopPolicy: defaultStopPolicy(),
        }),
      ),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
