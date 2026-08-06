import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runAgent } from "../../../src/agent/loop.ts";
import { defaultStopPolicy } from "../../../src/agent/stop-policy.ts";
import {
  createFakeProvider,
  fakeResponse,
  fakeToolResponse,
} from "../../../src/llm/providers/fake.ts";
import type { LLMProvider, ProviderMessage } from "../../../src/llm/types.ts";
import {
  collect,
  createWorkspace,
  freshSignal,
} from "../../../src/testing/file-editing-fixtures.ts";

describe("File Editing Multi Edit And Apply Patch", () => {
  test(`Given the assistant requests replacing every exact occurrence in a file,
    When the agent handles the edit tool call,
    Then all occurrences are updated before the assistant replies`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "note.txt"), "old one\nold two\n", "utf8");
    let turn = 0;
    let secondTurnMessages: readonly ProviderMessage[] = [];
    const provider: LLMProvider = {
      id: "replace-all-edit",
      async *stream(options) {
        if (turn === 0) {
          turn++;
          yield {
            type: "tool_call",
            id: "read_note",
            tool: "read",
            path: "note.txt",
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
            type: "tool_call",
            id: "replace_all_edit",
            tool: "edit",
            path: "note.txt",
            edits: [{ oldText: "old", newText: "new", replaceAll: true }],
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
          secondTurnMessages = options.messages;
          yield { type: "text", text: "Updated every occurrence." };
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
      },
    };

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "replace every occurrence",
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          bash: { kind: "disabled" },
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "new one\nnew two\n",
      );
      expect(
        secondTurnMessages.filter((message) => message.role === "tool"),
      ).toEqual([
        {
          role: "tool",
          toolCallId: "read_note",
          content: "old one\nold two\n",
        },
        {
          role: "tool",
          toolCallId: "replace_all_edit",
          content: "Edited note.txt",
        },
      ]);
      expect(events).toContainEqual({
        type: "text",
        text: "Updated every occurrence.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the assistant proposes multiple file changes in one response,
    When the agent handles the tool calls,
    Then each file is updated before the assistant replies`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "first.txt"), "first old\n", "utf8");
    await writeFile(join(workspace, "second.txt"), "second old\n", "utf8");
    let turn = 0;
    let secondTurnMessages: readonly ProviderMessage[] = [];
    const provider: LLMProvider = {
      id: "multiple-edits",
      async *stream(options) {
        if (turn === 0) {
          turn++;
          yield {
            type: "tool_call",
            id: "read_first",
            tool: "read",
            path: "first.txt",
          };
          yield {
            type: "tool_call",
            id: "read_second",
            tool: "read",
            path: "second.txt",
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
            type: "tool_call",
            id: "first_edit",
            tool: "edit",
            path: "first.txt",
            edits: [{ oldText: "old", newText: "new" }],
          };
          yield {
            type: "tool_call",
            id: "second_edit",
            tool: "edit",
            path: "second.txt",
            edits: [{ oldText: "old", newText: "new" }],
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
          secondTurnMessages = options.messages;
          yield {
            type: "text",
            text: "Both files updated.",
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
      },
    };

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "edit both files",
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          bash: { kind: "disabled" },
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(await readFile(join(workspace, "first.txt"), "utf8")).toBe(
        "first new\n",
      );
      expect(await readFile(join(workspace, "second.txt"), "utf8")).toBe(
        "second new\n",
      );
      const editMessages = secondTurnMessages.filter(
        (message) =>
          message.role === "tool" &&
          (message.toolCallId === "first_edit" ||
            message.toolCallId === "second_edit"),
      );
      expect(editMessages).toEqual([
        {
          role: "tool",
          toolCallId: "first_edit",
          content: "Edited first.txt",
        },
        {
          role: "tool",
          toolCallId: "second_edit",
          content: "Edited second.txt",
        },
      ]);
      expect(events).toContainEqual({
        type: "text",
        text: "Both files updated.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given one of multiple requested file changes cannot be applied,
    When the agent handles the tool calls,
    Then it reports that failure and still returns the successful tool result`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "first.txt"), "first old\n", "utf8");
    await writeFile(join(workspace, "second.txt"), "second old\n", "utf8");
    let turn = 0;
    let secondTurnMessages: readonly ProviderMessage[] = [];
    const provider: LLMProvider = {
      id: "mixed-multiple-edits",
      async *stream(options) {
        if (turn === 0) {
          turn++;
          yield {
            type: "tool_call",
            id: "read_first",
            tool: "read",
            path: "first.txt",
          };
          yield {
            type: "tool_call",
            id: "read_second",
            tool: "read",
            path: "second.txt",
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
            type: "tool_call",
            id: "missing_edit",
            tool: "edit",
            path: "first.txt",
            edits: [{ oldText: "missing", newText: "new" }],
          };
          yield {
            type: "tool_call",
            id: "second_edit",
            tool: "edit",
            path: "second.txt",
            edits: [{ oldText: "old", newText: "new" }],
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
          secondTurnMessages = options.messages;
          yield {
            type: "text",
            text: "One edit failed and one edit succeeded.",
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
      },
    };

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "edit both files",
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          bash: { kind: "disabled" },
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(await readFile(join(workspace, "first.txt"), "utf8")).toBe(
        "first old\n",
      );
      expect(await readFile(join(workspace, "second.txt"), "utf8")).toBe(
        "second new\n",
      );
      const toolMessages = secondTurnMessages.filter(
        (message) =>
          message.role === "tool" &&
          (message.toolCallId === "missing_edit" ||
            message.toolCallId === "second_edit"),
      );
      expect(toolMessages[0]).toMatchObject({
        role: "tool",
        toolCallId: "missing_edit",
        content: expect.stringContaining("Tool failed:"),
      });
      expect(toolMessages[1]).toEqual({
        role: "tool",
        toolCallId: "second_edit",
        content: "Edited second.txt",
      });
      expect(events).toContainEqual({
        type: "text",
        text: "One edit failed and one edit succeeded.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given one of multiple requested file changes uses an empty old string,
    When the agent handles the tool calls,
    Then it reports that failure and still applies the remaining file change`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "empty.txt"), "", "utf8");
    await writeFile(join(workspace, "second.txt"), "second old\n", "utf8");
    let turn = 0;
    let secondTurnMessages: readonly ProviderMessage[] = [];
    const provider: LLMProvider = {
      id: "empty-old-string-with-success",
      async *stream(options) {
        if (turn === 0) {
          turn++;
          yield {
            type: "tool_call",
            id: "read_second",
            tool: "read",
            path: "second.txt",
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
            type: "tool_call",
            id: "empty_file_edit",
            tool: "edit",
            path: "empty.txt",
            edits: [{ oldText: "", newText: "created\n" }],
          };
          yield {
            type: "tool_call",
            id: "second_edit",
            tool: "edit",
            path: "second.txt",
            edits: [{ oldText: "old", newText: "new" }],
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
          secondTurnMessages = options.messages;
          yield {
            type: "text",
            text: "One edit was not valid and one edit succeeded.",
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
      },
    };

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "edit both files",
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          bash: { kind: "disabled" },
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(await readFile(join(workspace, "empty.txt"), "utf8")).toBe("");
      expect(await readFile(join(workspace, "second.txt"), "utf8")).toBe(
        "second new\n",
      );
      const toolMessages = secondTurnMessages.filter(
        (message) =>
          message.role === "tool" &&
          (message.toolCallId === "empty_file_edit" ||
            message.toolCallId === "second_edit"),
      );
      expect(toolMessages[0]).toMatchObject({
        role: "tool",
        toolCallId: "empty_file_edit",
        content: expect.stringContaining("old string is empty"),
      });
      expect(toolMessages[0]?.content).toContain("Recovery:");
      expect(toolMessages[1]).toEqual({
        role: "tool",
        toolCallId: "second_edit",
        content: "Edited second.txt",
      });
      expect(events).toContainEqual({
        type: "text",
        text: "One edit was not valid and one edit succeeded.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the assistant patches multiple files after reading the update targets,
    When the agent handles the apply_patch tool call,
    Then all patch changes are visible before the assistant replies`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "src.ts"), "export const value = 1;\n");
    const provider = createFakeProvider([
      fakeToolResponse("read", { path: "src.ts" }),
      fakeToolResponse("apply_patch", {
        patch: [
          "*** Begin Patch",
          "*** Update File: src.ts",
          "@@",
          "-export const value = 1;",
          "+export const value = 2;",
          "*** Add File: docs/note.md",
          "+patched",
          "*** End Patch",
        ].join("\n"),
      }),
      fakeResponse("Applied the patch."),
    ]);

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "patch src.ts and create docs/note.md",
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          bash: { kind: "disabled" },
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(await readFile(join(workspace, "src.ts"), "utf8")).toBe(
        "export const value = 2;\n",
      );
      expect(await readFile(join(workspace, "docs", "note.md"), "utf8")).toBe(
        "patched\n",
      );
      expect(events).toContainEqual({
        type: "text",
        text: "Applied the patch.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the assistant proposes a standard unified diff after reading the target,
    When the agent handles the apply_patch tool call,
    Then the diff update is visible before the assistant replies`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(
      join(workspace, "src.ts"),
      ["export function run() {", "  return 1;", "}", ""].join("\n"),
      "utf8",
    );
    const provider = createFakeProvider([
      fakeToolResponse("read", { path: "src.ts" }),
      fakeToolResponse("apply_patch", {
        patch: [
          "diff --git a/src.ts b/src.ts",
          "--- a/src.ts",
          "+++ b/src.ts",
          "@@ -1,3 +1,3 @@",
          " export function run() {",
          "-  return 1;",
          "+  return 2;",
          " }",
        ].join("\n"),
      }),
      fakeResponse("Applied the standard diff."),
    ]);

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "apply this standard diff",
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          bash: { kind: "disabled" },
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(await readFile(join(workspace, "src.ts"), "utf8")).toBe(
        ["export function run() {", "  return 2;", "}", ""].join("\n"),
      );
      expect(events).toContainEqual({
        type: "text",
        text: "Applied the standard diff.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the assistant proposes a standard unified diff that renames and edits a read file,
    When the agent handles the apply_patch tool call,
    Then the old path is removed and the new path contains the edited text before the assistant replies`, async () => {
    // Given
    const workspace = await createWorkspace();
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(
      join(workspace, "src", "old.ts"),
      "export const value = 1;\n",
      "utf8",
    );
    const provider = createFakeProvider([
      fakeToolResponse("read", { path: "src/old.ts" }),
      fakeToolResponse("apply_patch", {
        patch: [
          "diff --git a/src/old.ts b/src/new.ts",
          "similarity index 80%",
          "rename from src/old.ts",
          "rename to src/new.ts",
          "index 1111111..2222222 100644",
          "--- a/src/old.ts",
          "+++ b/src/new.ts",
          "@@ -1 +1 @@",
          "-export const value = 1;",
          "+export const value = 2;",
        ].join("\n"),
      }),
      fakeResponse("Applied the standard rename diff."),
    ]);

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "apply this standard rename diff",
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          bash: { kind: "disabled" },
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      await expect(
        readFile(join(workspace, "src", "old.ts"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(workspace, "src", "new.ts"), "utf8")).toBe(
        "export const value = 2;\n",
      );
      expect(events).toContainEqual({
        type: "text",
        text: "Applied the standard rename diff.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the assistant proposes a standard unified diff that copies and edits a read file,
    When the agent handles the apply_patch tool call,
    Then the old path remains and the new path contains the edited text before the assistant replies`, async () => {
    // Given
    const workspace = await createWorkspace();
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(
      join(workspace, "src", "template.ts"),
      "export const value = 1;\n",
      "utf8",
    );
    const provider = createFakeProvider([
      fakeToolResponse("read", { path: "src/template.ts" }),
      fakeToolResponse("apply_patch", {
        patch: [
          "diff --git a/src/template.ts b/src/copied.ts",
          "similarity index 80%",
          "copy from src/template.ts",
          "copy to src/copied.ts",
          "index 1111111..2222222 100644",
          "--- a/src/template.ts",
          "+++ b/src/copied.ts",
          "@@ -1 +1 @@",
          "-export const value = 1;",
          "+export const value = 2;",
        ].join("\n"),
      }),
      fakeResponse("Applied the standard copy diff."),
    ]);

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "apply this standard copy diff",
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          bash: { kind: "disabled" },
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(
        await readFile(join(workspace, "src", "template.ts"), "utf8"),
      ).toBe("export const value = 1;\n");
      expect(await readFile(join(workspace, "src", "copied.ts"), "utf8")).toBe(
        "export const value = 2;\n",
      );
      expect(events).toContainEqual({
        type: "text",
        text: "Applied the standard copy diff.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the assistant proposes a standard unified diff that adds and deletes files,
    When the agent handles the apply_patch tool call,
    Then the file addition and deletion are visible before the assistant replies`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "obsolete.txt"), "remove me\n", "utf8");
    const provider = createFakeProvider([
      fakeToolResponse("read", { path: "obsolete.txt" }),
      fakeToolResponse("apply_patch", {
        patch: [
          "diff --git a/docs/new.md b/docs/new.md",
          "new file mode 100644",
          "index 0000000..1111111",
          "--- /dev/null",
          "+++ b/docs/new.md",
          "@@ -0,0 +1,2 @@",
          "+# New",
          "+created by standard diff",
          "diff --git a/obsolete.txt b/obsolete.txt",
          "deleted file mode 100644",
          "index 2222222..0000000",
          "--- a/obsolete.txt",
          "+++ /dev/null",
          "@@ -1 +0,0 @@",
          "-remove me",
        ].join("\n"),
      }),
      fakeResponse("Applied the standard add/delete diff."),
    ]);

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "apply this standard diff that adds and deletes files",
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          bash: { kind: "disabled" },
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(await readFile(join(workspace, "docs", "new.md"), "utf8")).toBe(
        "# New\ncreated by standard diff\n",
      );
      await expect(
        readFile(join(workspace, "obsolete.txt"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(events).toContainEqual({
        type: "text",
        text: "Applied the standard add/delete diff.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the assistant proposes a standard unified diff that changes an executable bit,
    When the agent handles the apply_patch tool call,
    Then the file mode changes before the assistant replies`, async () => {
    // Given
    const workspace = await createWorkspace();
    await mkdir(join(workspace, "scripts"));
    const scriptPath = join(workspace, "scripts", "run.sh");
    await writeFile(scriptPath, "#!/bin/sh\necho hi\n", "utf8");
    if (process.platform !== "win32") {
      await chmod(scriptPath, 0o644);
    }
    const provider = createFakeProvider([
      fakeToolResponse("read", { path: "scripts/run.sh" }),
      fakeToolResponse("apply_patch", {
        patch: [
          "diff --git a/scripts/run.sh b/scripts/run.sh",
          "old mode 100644",
          "new mode 100755",
        ].join("\n"),
      }),
      fakeResponse("Made the script executable."),
    ]);

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "make this script executable using the standard diff",
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          bash: { kind: "disabled" },
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(await readFile(scriptPath, "utf8")).toBe("#!/bin/sh\necho hi\n");
      if (process.platform !== "win32") {
        expect((await stat(scriptPath)).mode & 0o777).toBe(0o755);
      }
      expect(events).toContainEqual({
        type: "text",
        text: "Made the script executable.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a nested AGENTS.md applies to an apply_patch addition,
    When the assistant patches before seeing those instructions,
    Then the first patch is blocked and the retry can create the file`, async () => {
    // Given
    const workspace = await createWorkspace();
    await mkdir(join(workspace, "packages", "api"), { recursive: true });
    await writeFile(
      join(workspace, "packages", "api", "AGENTS.md"),
      "API rule: patch additions need the generated header.\n",
      "utf8",
    );
    const targetPath = join(workspace, "packages", "api", "src", "patched.ts");
    let turn = 0;
    let secondTurnMessages: readonly ProviderMessage[] = [];
    let fileExistedBeforeRetry = false;
    const provider: LLMProvider = {
      id: "scoped-agents-apply-patch-retry",
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
            id: "retry_patch",
            tool: "apply_patch",
            patch: [
              "*** Begin Patch",
              "*** Add File: packages/api/src/patched.ts",
              "+// generated header",
              "+export const patched = true;",
              "*** End Patch",
            ].join("\n"),
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
          yield { type: "text", text: "Applied scoped patch." };
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
          id: "initial_patch",
          tool: "apply_patch",
          patch: [
            "*** Begin Patch",
            "*** Add File: packages/api/src/patched.ts",
            "+export const patched = true;",
            "*** End Patch",
          ].join("\n"),
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
          userMessage: "patch in an API file",
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          bash: { kind: "disabled" },
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      const failedToolMessage = secondTurnMessages.find(
        (message) => message.role === "tool",
      );
      expect(failedToolMessage).toMatchObject({
        role: "tool",
        toolCallId: "initial_patch",
        content: expect.stringContaining(
          "Project instructions from packages/api/AGENTS.md",
        ),
      });
      expect(failedToolMessage?.content).toContain("Tool failed:");
      expect(failedToolMessage?.content).toContain(
        "API rule: patch additions need the generated header.",
      );
      expect(failedToolMessage?.content).toContain("Recovery:");
      expect(fileExistedBeforeRetry).toBe(false);
      expect(await readFile(targetPath, "utf8")).toBe(
        "// generated header\nexport const patched = true;\n",
      );
      expect(events).toContainEqual({
        type: "text",
        text: "Applied scoped patch.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given apply_patch updates multiple files in one tool call,
    When the assistant tries to edit one patched file without rereading it,
    Then the follow-up edit is rejected until that file is read again`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "first.txt"), "first old\n", "utf8");
    await writeFile(join(workspace, "second.txt"), "second old\n", "utf8");
    let turn = 0;
    let finalTurnMessages: readonly ProviderMessage[] = [];
    const provider: LLMProvider = {
      id: "apply-patch-invalidates-all-files",
      async *stream(options) {
        if (turn === 0) {
          turn++;
          yield {
            type: "tool_call",
            id: "read_first",
            tool: "read",
            path: "first.txt",
          };
          yield {
            type: "tool_call",
            id: "read_second",
            tool: "read",
            path: "second.txt",
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
            type: "tool_call",
            id: "patch_both",
            tool: "apply_patch",
            patch: [
              "*** Begin Patch",
              "*** Update File: first.txt",
              "@@",
              "-first old",
              "+first new",
              "*** Update File: second.txt",
              "@@",
              "-second old",
              "+second new",
              "*** End Patch",
            ].join("\n"),
          };
          yield {
            type: "tool_call",
            id: "edit_second",
            tool: "edit",
            path: "second.txt",
            edits: [{ oldText: "second new", newText: "second final" }],
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

        finalTurnMessages = options.messages;
        yield { type: "text", text: "Patch applied; edit needs a reread." };
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
          userMessage: "patch both files then refine second.txt",
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          bash: { kind: "disabled" },
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(await readFile(join(workspace, "first.txt"), "utf8")).toBe(
        "first new\n",
      );
      expect(await readFile(join(workspace, "second.txt"), "utf8")).toBe(
        "second new\n",
      );
      const toolMessages = finalTurnMessages.filter(
        (message) =>
          message.role === "tool" && message.toolCallId === "edit_second",
      );
      expect(toolMessages[0]?.content).toContain(
        "file has not been read: second.txt",
      );
      expect(events).toContainEqual({
        type: "text",
        text: "Patch applied; edit needs a reread.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
