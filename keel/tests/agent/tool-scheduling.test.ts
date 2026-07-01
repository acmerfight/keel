import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../src/agent/events.ts";
import { runAgent, runAgentTurn } from "../../src/agent/loop.ts";
import { defaultStopPolicy } from "../../src/agent/stop-policy.ts";
import type {
  ToolOutputArtifactSaveInput,
  ToolOutputArtifactStore,
} from "../../src/agent/tool-output-artifacts.ts";
import { restoreLastEditCheckpoint } from "../../src/core/git.ts";
import type { LLMProvider, Message, Usage } from "../../src/llm/types.ts";
import { createGitWorkspace } from "../../src/testing/cli-harness.ts";

const ZERO_USAGE: Usage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  uncachedInputTokens: 0,
  outputTokens: 0,
};

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

function isToolMessage(
  message: Message,
): message is Extract<Message, { readonly role: "tool" }> {
  return message.role === "tool";
}

function toolEventTrace(events: readonly AgentEvent[]): readonly string[] {
  return events
    .filter((event) => event.type === "tool_start" || event.type === "tool_end")
    .map((event) =>
      event.type === "tool_start"
        ? `${event.toolCall.id}:start`
        : `${event.toolCall.id}:end:${event.ok}`,
    );
}

function storedArtifactStore(
  saved: ToolOutputArtifactSaveInput[],
): ToolOutputArtifactStore {
  const existingRefs = new Set<string>();
  return {
    exists: async (ref) => existingRefs.has(ref),
    save: async (input) => {
      saved.push(input);
      const ref = `tool-output:test/${saved.length}`;
      existingRefs.add(ref);
      return { status: "stored", ref };
    },
  };
}

async function createWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "keel-tool-scheduling-"));
}

describe("Tool Scheduling", () => {
  test(`Given the assistant inspects independent files in one turn,
    When every requested tool is read-only,
    Then the user sees both reads start before either result and the model receives ordered results`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "existing.txt"), "visible\n", "utf8");
    let turn = 0;
    let followUpMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "parallel-read-provider",
      async *stream(options) {
        if (turn === 0) {
          turn++;
          yield {
            type: "tool_call",
            id: "read_missing",
            tool: "read",
            path: "missing.txt",
          };
          yield {
            type: "tool_call",
            id: "read_existing",
            tool: "read",
            path: "existing.txt",
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        followUpMessages = options.messages;
        yield { type: "text", text: "Inspected both files." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "inspect the files",
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(toolEventTrace(events)).toEqual([
        "read_missing:start",
        "read_existing:start",
        "read_missing:end:false",
        "read_existing:end:true",
      ]);
      const toolMessages = followUpMessages.filter(isToolMessage);
      expect(toolMessages.map((message) => message.toolCallId)).toEqual([
        "read_missing",
        "read_existing",
      ]);
      expect(toolMessages[0]?.content).toContain("file not found");
      expect(toolMessages[1]?.content).toContain("visible");
      expect(events).toContainEqual({
        type: "text",
        text: "Inspected both files.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the assistant edits a file and reads it in one turn,
    When the batch includes a workspace mutation,
    Then the read waits for the edit and sees the updated content`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "note.txt"), "before\n", "utf8");
    let turn = 0;
    let followUpMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "mixed-edit-read-provider",
      async *stream(options) {
        if (turn === 0) {
          turn++;
          yield {
            type: "tool_call",
            id: "read_note_before_edit",
            tool: "read",
            path: "note.txt",
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        if (turn === 1) {
          turn++;
          yield {
            type: "tool_call",
            id: "update_note",
            tool: "edit",
            path: "note.txt",
            edits: [{ oldText: "before", newText: "after" }],
          };
          yield {
            type: "tool_call",
            id: "read_note",
            tool: "read",
            path: "note.txt",
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        turn++;
        followUpMessages = options.messages;
        yield { type: "text", text: "Updated and checked the note." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "update note.txt and check it",
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(toolEventTrace(events)).toEqual([
        "read_note_before_edit:start",
        "read_note_before_edit:end:true",
        "update_note:start",
        "update_note:end:true",
        "read_note:start",
        "read_note:end:true",
      ]);
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "after\n",
      );
      const toolMessages = followUpMessages.filter(isToolMessage);
      expect(toolMessages.map((message) => message.toolCallId)).toEqual([
        "read_note_before_edit",
        "update_note",
        "read_note",
      ]);
      expect(toolMessages[2]?.content).toContain("after");
      expect(events).toContainEqual({
        type: "text",
        text: "Updated and checked the note.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the assistant inspects files before and after editing in one turn,
    When read-only calls are separated by a workspace mutation,
    Then independent reads overlap on each side while the edit remains a barrier`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "note.txt"), "before\n", "utf8");
    await writeFile(join(workspace, "todo.txt"), "todo: before\n", "utf8");
    let turn = 0;
    let followUpMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "mixed-batch-provider",
      async *stream(options) {
        if (turn === 0) {
          turn++;
          yield {
            type: "tool_call",
            id: "read_note_initial",
            tool: "read",
            path: "note.txt",
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        if (turn === 1) {
          turn++;
          yield {
            type: "tool_call",
            id: "read_note_before",
            tool: "read",
            path: "note.txt",
          };
          yield {
            type: "tool_call",
            id: "grep_todo",
            tool: "grep",
            pattern: "todo",
          };
          yield {
            type: "tool_call",
            id: "update_note",
            tool: "edit",
            path: "note.txt",
            edits: [{ oldText: "before", newText: "after" }],
          };
          yield {
            type: "tool_call",
            id: "read_note_after",
            tool: "read",
            path: "note.txt",
          };
          yield {
            type: "tool_call",
            id: "list_workspace",
            tool: "ls",
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        turn++;
        followUpMessages = options.messages;
        yield { type: "text", text: "Updated the note after inspection." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "inspect the workspace, update note.txt, and verify it",
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(toolEventTrace(events)).toEqual([
        "read_note_initial:start",
        "read_note_initial:end:true",
        "read_note_before:start",
        "grep_todo:start",
        "read_note_before:end:true",
        "grep_todo:end:true",
        "update_note:start",
        "update_note:end:true",
        "read_note_after:start",
        "list_workspace:start",
        "read_note_after:end:true",
        "list_workspace:end:true",
      ]);
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "after\n",
      );
      const toolMessages = followUpMessages.filter(isToolMessage);
      expect(toolMessages.map((message) => message.toolCallId)).toEqual([
        "read_note_initial",
        "read_note_before",
        "grep_todo",
        "update_note",
        "read_note_after",
        "list_workspace",
      ]);
      expect(toolMessages[4]?.content).toContain("after");
      expect(events).toContainEqual({
        type: "text",
        text: "Updated the note after inspection.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the assistant requests dependent edits to the same file after one read,
    When the batch includes workspace mutations,
    Then the second edit is rejected until the assistant rereads the file`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "note.txt"), "alpha\n", "utf8");
    let turn = 0;
    const provider: LLMProvider = {
      id: "dependent-edits-provider",
      async *stream() {
        if (turn === 0) {
          turn++;
          yield {
            type: "tool_call",
            id: "read_note",
            tool: "read",
            path: "note.txt",
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        if (turn === 1) {
          turn++;
          yield {
            type: "tool_call",
            id: "expand_alpha",
            tool: "edit",
            path: "note.txt",
            edits: [{ oldText: "alpha", newText: "alpha beta" }],
          };
          yield {
            type: "tool_call",
            id: "expand_beta",
            tool: "edit",
            path: "note.txt",
            edits: [{ oldText: "alpha beta", newText: "alpha beta gamma" }],
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        yield { type: "text", text: "Expanded the note." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "expand note.txt",
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(toolEventTrace(events)).toEqual([
        "read_note:start",
        "read_note:end:true",
        "expand_alpha:start",
        "expand_alpha:end:true",
        "expand_beta:start",
        "expand_beta:end:false",
      ]);
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "alpha beta\n",
      );
      expect(events).toContainEqual({
        type: "text",
        text: "Expanded the note.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the assistant updates independent files in one turn,
    When both mutations target different files that were already read,
    Then the user sees both edits start in the same batch and one undo checkpoint restores the task`, async () => {
    // Given
    const workspace = await createGitWorkspace(
      "keel-tool-scheduling-independent-edits-",
    );
    await writeFile(join(workspace, "alpha.txt"), "alpha old\n", "utf8");
    await writeFile(join(workspace, "beta.txt"), "beta old\n", "utf8");
    let turn = 0;
    let followUpMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "independent-edits-provider",
      async *stream(options) {
        if (turn === 0) {
          turn++;
          yield {
            type: "tool_call",
            id: "read_alpha",
            tool: "read",
            path: "alpha.txt",
          };
          yield {
            type: "tool_call",
            id: "read_beta",
            tool: "read",
            path: "beta.txt",
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        if (turn === 1) {
          turn++;
          yield {
            type: "tool_call",
            id: "edit_alpha",
            tool: "edit",
            path: "alpha.txt",
            edits: [{ oldText: "alpha old", newText: "alpha new" }],
          };
          yield {
            type: "tool_call",
            id: "edit_beta",
            tool: "edit",
            path: "beta.txt",
            edits: [{ oldText: "beta old", newText: "beta new" }],
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        followUpMessages = options.messages;
        yield { type: "text", text: "Updated both files." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "update alpha.txt and beta.txt",
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(toolEventTrace(events)).toEqual([
        "read_alpha:start",
        "read_beta:start",
        "read_alpha:end:true",
        "read_beta:end:true",
        "edit_alpha:start",
        "edit_beta:start",
        "edit_alpha:end:true",
        "edit_beta:end:true",
      ]);
      expect(await readFile(join(workspace, "alpha.txt"), "utf8")).toBe(
        "alpha new\n",
      );
      expect(await readFile(join(workspace, "beta.txt"), "utf8")).toBe(
        "beta new\n",
      );

      const restore = restoreLastEditCheckpoint(workspace);
      expect(restore).toEqual({
        status: "restored",
        restoredLabel: "2 files",
      });
      expect(await readFile(join(workspace, "alpha.txt"), "utf8")).toBe(
        "alpha old\n",
      );
      expect(await readFile(join(workspace, "beta.txt"), "utf8")).toBe(
        "beta old\n",
      );

      const toolMessages = followUpMessages.filter(isToolMessage);
      expect(toolMessages.map((message) => message.toolCallId)).toEqual([
        "read_alpha",
        "read_beta",
        "edit_alpha",
        "edit_beta",
      ]);
      expect(events).toContainEqual({
        type: "text",
        text: "Updated both files.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the assistant creates independent files in one turn,
    When both writes target different paths,
    Then the user sees both writes start in the same batch and one undo checkpoint restores the task`, async () => {
    // Given
    const workspace = await createGitWorkspace(
      "keel-tool-scheduling-independent-writes-",
    );
    let followUpMessages: readonly Message[] = [];
    let turn = 0;
    const provider: LLMProvider = {
      id: "independent-writes-provider",
      async *stream(options) {
        if (turn === 0) {
          turn++;
          yield {
            type: "tool_call",
            id: "write_alpha",
            tool: "write",
            path: "generated/alpha.txt",
            content: "alpha\n",
          };
          yield {
            type: "tool_call",
            id: "write_beta",
            tool: "write",
            path: "generated/beta.txt",
            content: "beta\n",
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        followUpMessages = options.messages;
        yield { type: "text", text: "Created both files." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "create alpha and beta files",
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(toolEventTrace(events)).toEqual([
        "write_alpha:start",
        "write_beta:start",
        "write_alpha:end:true",
        "write_beta:end:true",
      ]);
      expect(
        await readFile(join(workspace, "generated", "alpha.txt"), "utf8"),
      ).toBe("alpha\n");
      expect(
        await readFile(join(workspace, "generated", "beta.txt"), "utf8"),
      ).toBe("beta\n");

      const restore = restoreLastEditCheckpoint(workspace);
      expect(restore).toEqual({
        status: "restored",
        restoredLabel: "2 files",
      });
      await expect(
        readFile(join(workspace, "generated", "alpha.txt"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        readFile(join(workspace, "generated", "beta.txt"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });

      const toolMessages = followUpMessages.filter(isToolMessage);
      expect(toolMessages.map((message) => message.toolCallId)).toEqual([
        "write_alpha",
        "write_beta",
      ]);
      expect(events).toContainEqual({
        type: "text",
        text: "Created both files.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a read-only batch has a source-earlier success before cancellation,
    When a later scheduled tool rejects with a terminal error,
    Then the artifact-backed successful result is still recorded before the run fails`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(
      join(workspace, "note.txt"),
      ["VISIBLE_START", "visible ".repeat(120), "VISIBLE_END"].join("\n"),
      "utf8",
    );
    const abortController = new AbortController();
    abortController.abort();
    const messages: Message[] = [
      { role: "user", content: "inspect and search" },
    ];
    const saved: ToolOutputArtifactSaveInput[] = [];
    const provider: LLMProvider = {
      id: "terminal-parallel-search-provider",
      async *stream() {
        yield {
          type: "tool_call",
          id: "read_note",
          tool: "read",
          path: "note.txt",
        };
        yield {
          type: "tool_call",
          id: "cancelled_search",
          tool: "grep",
          pattern: "visible",
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const events: AgentEvent[] = [];

    try {
      // When / Then
      await expect(async () => {
        for await (const event of runAgentTurn({
          workspace,
          provider,
          messages,
          systemPrompt: "You are a helpful assistant.",
          signal: abortController.signal,
          allowBash: false,
          stopPolicy: defaultStopPolicy(),
          toolOutputArtifacts: {
            store: storedArtifactStore(saved),
            maxInlineChars: 64,
          },
        })) {
          events.push(event);
        }
      }).rejects.toMatchObject({
        name: "AbortError",
        code: "ABORT_ERR",
      });

      expect(toolEventTrace(events)).toEqual([
        "read_note:start",
        "cancelled_search:start",
        "read_note:end:true",
      ]);
      expect(events).toContainEqual({
        type: "tool_output_artifact",
        status: "stored",
        ref: "tool-output:test/1",
        toolCallId: "read_note",
        toolName: "read",
        sourceStatus: "complete",
        omittedChars: expect.any(Number),
      });
      expect(saved).toHaveLength(1);
      expect(messages).toContainEqual({
        role: "tool",
        toolCallId: "read_note",
        content: expect.stringContaining(
          "keel artifacts show tool-output:test/1",
        ),
      });
      expect(
        messages.some(
          (message) =>
            message.role === "tool" &&
            message.toolCallId === "cancelled_search",
        ),
      ).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a sequential tool throws after a source-earlier success,
    When the pending success is artifact-backed,
    Then the artifact notice is emitted before the run fails`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(
      join(workspace, "note.txt"),
      ["VISIBLE_START", "visible ".repeat(120), "VISIBLE_END"].join("\n"),
      "utf8",
    );
    const abortController = new AbortController();
    abortController.abort();
    const messages: Message[] = [{ role: "user", content: "inspect then run" }];
    const saved: ToolOutputArtifactSaveInput[] = [];
    const provider: LLMProvider = {
      id: "terminal-single-bash-provider",
      async *stream() {
        yield {
          type: "tool_call",
          id: "read_note",
          tool: "read",
          path: "note.txt",
        };
        yield {
          type: "tool_call",
          id: "cancelled_bash",
          tool: "bash",
          command: "printf done",
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const events: AgentEvent[] = [];

    try {
      // When / Then
      await expect(async () => {
        for await (const event of runAgentTurn({
          workspace,
          provider,
          messages,
          systemPrompt: "You are a helpful assistant.",
          signal: abortController.signal,
          allowBash: true,
          stopPolicy: defaultStopPolicy(),
          toolOutputArtifacts: {
            store: storedArtifactStore(saved),
            maxInlineChars: 64,
          },
        })) {
          events.push(event);
        }
      }).rejects.toMatchObject({
        name: "KeelError",
        code: "tool_aborted",
      });

      expect(toolEventTrace(events)).toEqual([
        "read_note:start",
        "read_note:end:true",
        "cancelled_bash:start",
      ]);
      expect(events).toContainEqual({
        type: "tool_output_artifact",
        status: "stored",
        ref: "tool-output:test/1",
        toolCallId: "read_note",
        toolName: "read",
        sourceStatus: "complete",
        omittedChars: expect.any(Number),
      });
      expect(saved).toHaveLength(1);
      expect(messages).toContainEqual({
        role: "tool",
        toolCallId: "read_note",
        content: expect.stringContaining(
          "keel artifacts show tool-output:test/1",
        ),
      });
      expect(
        messages.some(
          (message) =>
            message.role === "tool" && message.toolCallId === "cancelled_bash",
        ),
      ).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
