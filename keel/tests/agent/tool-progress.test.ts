import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../src/agent/events.ts";
import { runAgent } from "../../src/agent/loop.ts";
import { defaultStopPolicy } from "../../src/agent/stop-policy.ts";
import {
  createFakeProvider,
  fakeResponse,
  fakeToolResponse,
} from "../../src/llm/providers/fake.ts";

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
  return mkdtemp(join(tmpdir(), "keel-tool-progress-"));
}

describe("Tool Progress", () => {
  test(`Given a workspace file contains text to replace,
    When the agent edits the file,
    Then the user can observe the edit starting and succeeding before the final reply`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "note.txt"), "hello old world\n", "utf8");
    const provider = createFakeProvider([
      fakeToolResponse("read", { path: "note.txt" }),
      fakeToolResponse("edit", {
        path: "note.txt",
        edits: [{ oldText: "old", newText: "new" }],
      }),
      fakeResponse("Done."),
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
          bash: { kind: "disabled" },
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "hello new world\n",
      );
      const startIndex = events.findIndex(
        (event) =>
          event.type === "tool_start" && event.toolCall.tool === "edit",
      );
      const endIndex = events.findIndex(
        (event) => event.type === "tool_end" && event.toolCall.tool === "edit",
      );
      const replyIndex = events.findIndex(
        (event) => event.type === "text" && event.text === "Done.",
      );
      expect(startIndex).toBeGreaterThanOrEqual(0);
      expect(endIndex).toBeGreaterThan(startIndex);
      expect(replyIndex).toBeGreaterThan(endIndex);
      expect(events[endIndex]).toMatchObject({ type: "tool_end", ok: true });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an edit targets text that does not exist,
    When the agent reports the failure and recovers,
    Then the user can observe the failed tool call`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "note.txt"), "hello world\n", "utf8");
    const provider = createFakeProvider([
      fakeToolResponse("edit", {
        path: "note.txt",
        edits: [{ oldText: "missing", newText: "new" }],
      }),
      fakeResponse("The text was not found."),
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
          bash: { kind: "disabled" },
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(events).toContainEqual({
        type: "tool_end",
        toolCall: {
          id: "fake_tool_call_1",
          tool: "edit",
          path: "note.txt",
          edits: [{ oldText: "missing", newText: "new" }],
        },
        ok: false,
      });
      expect(events).toContainEqual({
        type: "text",
        text: "The text was not found.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an edit call has no replacement entries,
    When the agent executes the tool call,
    Then it reports a recoverable tool failure instead of aborting the turn`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "note.txt"), "hello world\n", "utf8");
    const provider = createFakeProvider([
      fakeToolResponse("edit", {
        path: "note.txt",
        edits: [],
      }),
      fakeResponse("I need at least one replacement."),
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
          bash: { kind: "disabled" },
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(events).toContainEqual({
        type: "tool_end",
        toolCall: {
          id: "fake_tool_call_1",
          tool: "edit",
          path: "note.txt",
          edits: [],
        },
        ok: false,
      });
      expect(events).toContainEqual({
        type: "text",
        text: "I need at least one replacement.",
      });
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "hello world\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
