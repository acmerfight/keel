import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../src/agent/loop.ts";
import { runAgent } from "../../src/agent/loop.ts";
import {
  createFakeProvider,
  fakeEditResponse,
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

  test(`Given a file does not contain the target text,
    When the LLM asks the agent to edit that text,
    Then the edit is rejected and the file is unchanged`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "note.txt"), "hello world\n", "utf8");
    const provider = createFakeProvider([
      fakeEditResponse("note.txt", "missing", "new"),
    ]);

    try {
      // When / Then
      await expect(
        collect(
          runAgent({
            workspace,
            provider,
            userMessage: "replace missing text",
            systemPrompt: "You are a helpful assistant.",
            signal: freshSignal(),
          }),
        ),
      ).rejects.toThrow("old string not found");
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "hello world\n",
      );
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

  test(`Given the LLM references a nonexistent file,
    When the agent runs the edit tool,
    Then the edit is rejected`, async () => {
    // Given
    const workspace = await createWorkspace();
    const provider = createFakeProvider([
      fakeEditResponse("missing.txt", "old", "new"),
    ]);

    try {
      // When / Then
      await expect(
        collect(
          runAgent({
            workspace,
            provider,
            userMessage: "edit missing file",
            systemPrompt: "You are a helpful assistant.",
            signal: freshSignal(),
          }),
        ),
      ).rejects.toThrow("file not found");
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
});
