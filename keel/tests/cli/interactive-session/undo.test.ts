import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../../src/agent/events.ts";
import { parseInteractiveCommand } from "../../../src/cli/interactive-session/commands.ts";
import { runInteractiveSession } from "../../../src/cli/interactive-session.ts";
import {
  createSessionStore,
  persistSessionMessages,
  persistSessionQueuedInput,
  resumeSessionStore,
} from "../../../src/cli/session-store.ts";
import { recordLastEditCheckpoint } from "../../../src/core/git.ts";
import type { LLMProvider, Message } from "../../../src/llm/types.ts";
import {
  commitFile,
  createGitWorkspace,
} from "../../../src/testing/cli-harness.ts";
import {
  ForcedExit,
  ZERO_COST_MODEL,
  ZERO_USAGE,
} from "../../../src/testing/interactive-session-fixtures.ts";

describe("Interactive Session - Undo", () => {
  test(`Given no edit checkpoint exists,
    When user enters /undo,
    Then the command reports the next actions without starting a model turn`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-interactive-undo-none-");
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    let providerResolved = false;
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace,
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: (handler) => {
        sigintHandlers.add(handler);
      },
      offSigint: (handler) => {
        sigintHandlers.delete(handler);
      },
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => {
        providerResolved = true;
        throw new Error("undo should not resolve a provider");
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => {
        throw new Error("undo should not start a model turn");
      },
      formatCostReport: () => "",
    });

    try {
      // When
      input.end("/undo\n");

      // Then
      await session;
      expect(stdout).toBe("");
      expect(stderr).toBe(
        "No earlier checkpoints. Ask me to undo more, or use git to reset.\n",
      );
      expect(providerResolved).toBe(false);
      expect(sigintHandlers.size).toBe(0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the user passes unsupported arguments to /undo,
    When the command is parsed,
    Then the command is rejected without starting a model turn`, async () => {
    // Given
    const input = new PassThrough();
    let stdout = "";
    let stderr = "";
    let providerResolved = false;
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => {
        providerResolved = true;
        throw new Error("invalid undo should not resolve a provider");
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => {
        throw new Error("invalid undo should not start a model turn");
      },
      formatCostReport: () => "",
    });

    // When
    input.end("/undo --list now\n");

    // Then
    await session;
    expect(stdout).toBe("");
    expect(stderr).toBe('Error: unknown /undo option "now".\n');
    expect(providerResolved).toBe(false);
  });

  test(`Given the user passes an unsupported /undo argument,
    When the interactive command is parsed,
    Then the parser reports the unsupported argument`, () => {
    // Given / When
    const command = parseInteractiveCommand("/undo now");

    // Then
    expect(command).toEqual({
      kind: "invalid",
      message: 'Error: unknown /undo option "now".',
    });
  });

  test(`Given the user targets an undo checkpoint by list index,
    When the interactive command is parsed,
    Then the parser returns the target index`, () => {
    // Given / When
    const command = parseInteractiveCommand("/undo --to 2");

    // Then
    expect(command).toEqual({
      kind: "undo",
      mode: "restore-through",
      checkpointIndex: 2,
    });
  });

  test(`Given the user passes an invalid undo target index,
    When the interactive command is parsed,
    Then the parser reports the target index requirement`, () => {
    // Given / When
    const command = parseInteractiveCommand("/undo --to 0");

    // Then
    expect(command).toEqual({
      kind: "invalid",
      message: "Error: /undo --to requires a positive integer.",
    });
  });

  test(`Given the user targets an undo checkpoint with inline syntax,
    When the interactive command is parsed,
    Then the parser returns the target index`, () => {
    // Given / When
    const command = parseInteractiveCommand("/undo --to=2");

    // Then
    expect(command).toEqual({
      kind: "undo",
      mode: "restore-through",
      checkpointIndex: 2,
    });
  });

  test(`Given the user targets an undo checkpoint with an unsafe integer,
    When the interactive command is parsed,
    Then the parser reports the target index requirement`, () => {
    // Given / When
    const command = parseInteractiveCommand("/undo --to 9007199254740992");

    // Then
    expect(command).toEqual({
      kind: "invalid",
      message: "Error: /undo --to requires a positive integer.",
    });
  });

  test(`Given the user targets an undo checkpoint with an invalid inline integer,
    When the interactive command is parsed,
    Then the parser reports the target index requirement`, () => {
    // Given / When
    const command = parseInteractiveCommand("/undo --to=0");

    // Then
    expect(command).toEqual({
      kind: "invalid",
      message: "Error: /undo --to requires a positive integer.",
    });
  });

  test.each([
    ["/undo --to 1 extra", 'Error: unknown /undo option "extra".'],
    ["/undo --to=1 extra", 'Error: unknown /undo option "extra".'],
  ])(`Given the user passes extra arguments to %s,
    When the interactive command is parsed,
    Then the parser reports the extra argument`, (input, message) => {
    // Given / When
    const command = parseInteractiveCommand(input);

    // Then
    expect(command).toEqual({
      kind: "invalid",
      message,
    });
  });

  test(`Given undo checkpoints exist,
    When user enters /undo --list,
    Then the command reports checkpoints without starting a model turn`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-interactive-undo-list-");
    await commitFile(workspace, "first.txt", "before first\n");
    await writeFile(join(workspace, "first.txt"), "after first\n", "utf8");
    recordLastEditCheckpoint({
      workspace,
      filePath: join(workspace, "first.txt"),
      beforeContent: "before first\n",
      afterContent: "after first\n",
    });
    await commitFile(workspace, "second.txt", "before second\n");
    await writeFile(join(workspace, "second.txt"), "after second\n", "utf8");
    recordLastEditCheckpoint({
      workspace,
      filePath: join(workspace, "second.txt"),
      beforeContent: "before second\n",
      afterContent: "after second\n",
    });
    const input = new PassThrough();
    let stdout = "";
    let stderr = "";
    let providerResolved = false;
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace,
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => {
        providerResolved = true;
        throw new Error("undo list should not resolve a provider");
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => {
        throw new Error("undo list should not start a model turn");
      },
      formatCostReport: () => "",
    });

    try {
      // When
      input.end("/undo --list\n");

      // Then
      await session;
      expect(stdout).toBe(
        ["Undo checkpoints:", "1. second.txt", "2. first.txt", ""].join("\n"),
      );
      expect(stderr).toBe("");
      expect(providerResolved).toBe(false);
      expect(await readFile(join(workspace, "first.txt"), "utf8")).toBe(
        "after first\n",
      );
      expect(await readFile(join(workspace, "second.txt"), "utf8")).toBe(
        "after second\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given undo checkpoints exist,
    When user enters /undo --to with a listed checkpoint index,
    Then every newer checkpoint is restored without starting a model turn`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-interactive-undo-to-");
    await commitFile(workspace, "first.txt", "before first\n");
    await writeFile(join(workspace, "first.txt"), "after first\n", "utf8");
    recordLastEditCheckpoint({
      workspace,
      filePath: join(workspace, "first.txt"),
      beforeContent: "before first\n",
      afterContent: "after first\n",
    });
    await commitFile(workspace, "second.txt", "before second\n");
    await writeFile(join(workspace, "second.txt"), "after second\n", "utf8");
    recordLastEditCheckpoint({
      workspace,
      filePath: join(workspace, "second.txt"),
      beforeContent: "before second\n",
      afterContent: "after second\n",
    });
    const input = new PassThrough();
    let stdout = "";
    let stderr = "";
    let providerResolved = false;
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace,
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => {
        providerResolved = true;
        throw new Error("undo to should not resolve a provider");
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => {
        throw new Error("undo to should not start a model turn");
      },
      formatCostReport: () => "",
    });

    try {
      // When
      input.end("/undo --to 2\n");

      // Then
      await session;
      expect(stdout).toBe("Restored 2 checkpoints\n");
      expect(stderr).toBe("");
      expect(providerResolved).toBe(false);
      expect(await readFile(join(workspace, "first.txt"), "utf8")).toBe(
        "before first\n",
      );
      expect(await readFile(join(workspace, "second.txt"), "utf8")).toBe(
        "before second\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an edit checkpoint no longer matches the workspace,
    When user enters /undo,
    Then the command reports the block without starting a model turn`, async () => {
    // Given
    const workspace = await createGitWorkspace(
      "keel-interactive-undo-blocked-",
    );
    await commitFile(workspace, "note.txt", "before\n");
    await writeFile(join(workspace, "note.txt"), "after\n", "utf8");
    recordLastEditCheckpoint({
      workspace,
      filePath: join(workspace, "note.txt"),
      beforeContent: "before\n",
      afterContent: "after\n",
    });
    await writeFile(join(workspace, "note.txt"), "user change\n", "utf8");

    const input = new PassThrough();
    let stdout = "";
    let stderr = "";
    let providerResolved = false;
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace,
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => {
        providerResolved = true;
        throw new Error("blocked undo should not resolve a provider");
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => {
        throw new Error("blocked undo should not start a model turn");
      },
      formatCostReport: () => "",
    });

    try {
      // When
      input.end("/undo\n");

      // Then
      await session;
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "user change\n",
      );
      expect(stdout).toBe("");
      expect(stderr).toBe(
        "Cannot undo note.txt: Refusing to overwrite user changes.\n",
      );
      expect(providerResolved).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an interactive task edits two files,
    When user enters /undo before another prompt,
    Then both files are restored and the next model turn sees the restore status`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-interactive-undo-task-");
    await commitFile(workspace, "first.txt", "first old\n");
    await commitFile(workspace, "second.txt", "second old\n");

    let request = 0;
    const observedContexts: Message[][] = [];
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        request++;
        observedContexts.push(structuredClone([...options.messages]));
        switch (request) {
          case 1:
            yield {
              type: "tool_call",
              id: "read_first",
              tool: "read",
              path: "first.txt",
              limit: 10,
            };
            break;
          case 2:
            yield {
              type: "tool_call",
              id: "edit_first",
              tool: "edit",
              path: "first.txt",
              edits: [{ oldText: "first old", newText: "first new" }],
            };
            break;
          case 3:
            yield {
              type: "tool_call",
              id: "read_second",
              tool: "read",
              path: "second.txt",
              limit: 10,
            };
            break;
          case 4:
            yield {
              type: "tool_call",
              id: "edit_second",
              tool: "edit",
              path: "second.txt",
              edits: [{ oldText: "second old", newText: "second new" }],
            };
            break;
          case 5:
            yield { type: "text", text: "Updated both files." };
            break;
          case 6:
            yield { type: "text", text: "Checked restored workspace." };
            break;
          default:
            throw new Error("unexpected provider request");
        }
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    let stdout = "";
    let stderr = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace,
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    try {
      // When
      input.end("update both files\n/undo\ncheck restored workspace\n");

      // Then
      await session;
      expect(await readFile(join(workspace, "first.txt"), "utf8")).toBe(
        "first old\n",
      );
      expect(await readFile(join(workspace, "second.txt"), "utf8")).toBe(
        "second old\n",
      );
      expect(stdout).toBe(
        "Updated both files.\nRestored 2 files\nChecked restored workspace.\n",
      );
      expect(stderr).toBe("");
      const nextPromptContext = observedContexts[5];
      expect(nextPromptContext).toContainEqual({
        role: "user",
        content:
          "Keel local command /undo restored 2 files. Treat this as workspace state, not as a new user request.",
      });
      expect(nextPromptContext).toContainEqual({
        role: "user",
        content: "check restored workspace",
      });
      expect(
        observedContexts
          .flat()
          .some(
            (message) => message.role === "user" && message.content === "/undo",
          ),
      ).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given undo restores a file after the assistant reread it,
    When the next turn edits without rereading,
    Then read-before-edit is cleared and the edit is rejected`, async () => {
    // Given
    const workspace = await createGitWorkspace(
      "keel-interactive-undo-read-visibility-",
    );
    await commitFile(workspace, "note.txt", "old\n");

    let request = 0;
    const observedContexts: Message[][] = [];
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        request++;
        observedContexts.push(structuredClone([...options.messages]));
        switch (request) {
          case 1:
            yield {
              type: "tool_call",
              id: "read_before_edit",
              tool: "read",
              path: "note.txt",
              limit: 10,
            };
            break;
          case 2:
            yield {
              type: "tool_call",
              id: "edit_note",
              tool: "edit",
              path: "note.txt",
              edits: [{ oldText: "old", newText: "new" }],
            };
            break;
          case 3:
            yield {
              type: "tool_call",
              id: "read_after_edit",
              tool: "read",
              path: "note.txt",
              limit: 10,
            };
            break;
          case 4:
            yield { type: "text", text: "Updated and reread." };
            break;
          case 5:
            yield {
              type: "tool_call",
              id: "edit_without_reread",
              tool: "edit",
              path: "note.txt",
              edits: [{ oldText: "old", newText: "final" }],
            };
            break;
          case 6:
            yield { type: "text", text: "Need to reread." };
            break;
          default:
            throw new Error("unexpected provider request");
        }
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    let stdout = "";
    let stderr = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace,
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    try {
      // When
      input.end("update and reread\n/undo\ntry edit without rereading\n");

      // Then
      await session;
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe("old\n");
      expect(stdout).toBe(
        "Updated and reread.\nRestored note.txt\nNeed to reread.\n",
      );
      expect(stderr).toBe("");
      const finalContext = observedContexts[5];
      const failedEditMessage = finalContext?.find(
        (message) =>
          message.role === "tool" &&
          message.toolCallId === "edit_without_reread",
      );
      expect(failedEditMessage?.content).toContain("file has not been read");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a named session has queued undo input,
    When undo restores a checkpoint,
    Then resume preserves the restore status without replaying the undo command`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-interactive-undo-resume-");
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    let now = 0;
    const runtime = {
      env: (key: string) => (key === "KEEL_HOME" ? home : undefined),
      now: () => now,
    };
    await commitFile(workspace, "note.txt", "before\n");
    await writeFile(join(workspace, "note.txt"), "after\n", "utf8");
    recordLastEditCheckpoint({
      workspace,
      filePath: join(workspace, "note.txt"),
      beforeContent: "before\n",
      afterContent: "after\n",
    });
    const storedSession = createSessionStore({
      sessionId: "undo-resume",
      workspace,
      runtime,
    });
    const queuedUndo = persistSessionQueuedInput({
      session: storedSession,
      sequence: 1,
      line: "/undo",
      runtime,
    });
    let persistedMessages: readonly Message[] = storedSession.messages;
    const firstInput = new PassThrough();
    let firstStdout = "";
    let firstStderr = "";
    const firstRun = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace,
      platform: process.platform,
      initialMessages: storedSession.messages,
      initialQueuedInputs: [queuedUndo],
      input: firstInput,
      writeStdout: (text) => {
        firstStdout += text;
      },
      writeStderr: (text) => {
        firstStderr += text;
      },
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => {
        throw new Error("queued undo should not resolve a provider");
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => {
        throw new Error("queued undo should not start a model turn");
      },
      formatCostReport: () => "",
      persistSessionMessages: (messages, reason, consumedInputIds) => {
        now = 1;
        persistedMessages = persistSessionMessages({
          session: storedSession,
          previousMessages: persistedMessages,
          currentMessages: messages,
          runtime,
          reason,
          consumedInputIds,
        });
      },
    });
    firstInput.end();

    try {
      await firstRun;
      const resumed = resumeSessionStore({
        sessionId: "undo-resume",
        workspace,
        runtime,
      });
      const observedContexts: Message[][] = [];
      const provider: LLMProvider = {
        id: "fake",
        async *stream(options) {
          observedContexts.push(structuredClone([...options.messages]));
          yield { type: "text", text: "Resumed after undo." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
        },
      };
      const secondInput = new PassThrough();
      let secondStdout = "";
      const secondRun = runInteractiveSession({
        cliArgs: { bashMode: "disabled" },
        workspace,
        platform: process.platform,
        initialMessages: resumed.messages,
        initialQueuedInputs: resumed.pendingInputs,
        input: secondInput,
        writeStdout: (text) => {
          secondStdout += text;
        },
        writeStderr: () => {},
        onSigint: () => {},
        offSigint: () => {},
        setExitCode: () => {},
        forceExit: (code) => {
          throw new ForcedExit(code);
        },
        resolveProvider: () => ({
          provider,
          providerId: "fake",
          model: "fake",
          costModel: ZERO_COST_MODEL,
        }),
        requireKnownCostModel: () => ZERO_COST_MODEL,
        printAgentEvents: async (stream) => {
          let finalEnd:
            | Extract<AgentEvent, { readonly type: "end" }>
            | undefined;
          for await (const event of stream) {
            if (event.type === "text") {
              secondStdout += event.text;
            } else if (event.type === "end") {
              finalEnd = event;
            }
          }
          return finalEnd;
        },
        formatCostReport: () => "",
      });

      // When
      secondInput.end("continue after undo\n");
      await secondRun;

      // Then
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "before\n",
      );
      expect(firstStdout).toBe("Restored note.txt\n");
      expect(firstStderr).toBe("");
      expect(resumed.pendingInputs).toEqual([]);
      expect(resumed.messages).toEqual([
        {
          role: "user",
          content:
            "Keel local command /undo restored note.txt. Treat this as workspace state, not as a new user request.",
        },
      ]);
      expect(observedContexts).toEqual([
        [
          {
            role: "user",
            content:
              "Keel local command /undo restored note.txt. Treat this as workspace state, not as a new user request.",
          },
          { role: "user", content: "continue after undo" },
        ],
      ]);
      expect(secondStdout).toBe("Resumed after undo.\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
});
