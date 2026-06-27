import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
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
import { createProjectInstructionVisibilityState } from "../../../src/tools/scoped-project-instructions.ts";

describe("File Editing Post-Compaction Scoped Instructions", () => {
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
});
