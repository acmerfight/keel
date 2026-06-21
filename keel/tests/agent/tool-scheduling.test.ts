import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../src/agent/loop.ts";
import { runAgent, runAgentTurn } from "../../src/agent/loop.ts";
import { defaultStopPolicy } from "../../src/agent/stop-policy.ts";
import type { LLMProvider, Message, Usage } from "../../src/llm/types.ts";

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
          yield { type: "stop", usage: ZERO_USAGE };
          return;
        }

        followUpMessages = options.messages;
        yield { type: "text", text: "Inspected both files." };
        yield { type: "stop", usage: ZERO_USAGE };
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
          yield { type: "stop", usage: ZERO_USAGE };
          return;
        }

        if (turn === 1) {
          turn++;
          yield {
            type: "tool_call",
            id: "update_note",
            tool: "edit",
            path: "note.txt",
            oldString: "before",
            newString: "after",
          };
          yield {
            type: "tool_call",
            id: "read_note",
            tool: "read",
            path: "note.txt",
          };
          yield { type: "stop", usage: ZERO_USAGE };
          return;
        }

        turn++;
        followUpMessages = options.messages;
        yield { type: "text", text: "Updated and checked the note." };
        yield { type: "stop", usage: ZERO_USAGE };
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
          yield { type: "stop", usage: ZERO_USAGE };
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
            oldString: "before",
            newString: "after",
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
          yield { type: "stop", usage: ZERO_USAGE };
          return;
        }

        turn++;
        followUpMessages = options.messages;
        yield { type: "text", text: "Updated the note after inspection." };
        yield { type: "stop", usage: ZERO_USAGE };
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
          yield { type: "stop", usage: ZERO_USAGE };
          return;
        }

        if (turn === 1) {
          turn++;
          yield {
            type: "tool_call",
            id: "expand_alpha",
            tool: "edit",
            path: "note.txt",
            oldString: "alpha",
            newString: "alpha beta",
          };
          yield {
            type: "tool_call",
            id: "expand_beta",
            tool: "edit",
            path: "note.txt",
            oldString: "alpha beta",
            newString: "alpha beta gamma",
          };
          yield { type: "stop", usage: ZERO_USAGE };
          return;
        }

        yield { type: "text", text: "Expanded the note." };
        yield { type: "stop", usage: ZERO_USAGE };
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

  test(`Given a read-only batch has a source-earlier success before cancellation,
    When a later parallel-safe tool rejects with a terminal error,
    Then the successful result is still recorded before the run fails`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "note.txt"), "visible\n", "utf8");
    const abortController = new AbortController();
    abortController.abort();
    const messages: Message[] = [
      { role: "user", content: "inspect and search" },
    ];
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
        yield { type: "stop", usage: ZERO_USAGE };
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
      expect(messages).toContainEqual({
        role: "tool",
        toolCallId: "read_note",
        content: expect.stringContaining("visible"),
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
});
