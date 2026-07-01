import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createSessionStore,
  persistSessionMessages,
  resumeSessionStore,
  SessionStoreError,
} from "../../../src/cli/session-store.ts";
import type { Message } from "../../../src/llm/types.ts";
import {
  appendLine,
  expectedStoredMessages,
  headerLine,
  runtime,
} from "../../../src/testing/session-store-fixtures.ts";

describe("Session Store Tool Call Ledger", () => {
  test(`Given a persisted transcript contains every tool-call shape,
    When the session is resumed,
    Then optional tool-call fields survive the disk boundary`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const messages: readonly Message[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "read_with_range",
            tool: "read",
            path: "src/index.ts",
            offset: 2,
            limit: 5,
          },
          {
            id: "ls_with_options",
            tool: "ls",
            path: "src",
            limit: 10,
          },
          {
            id: "glob_with_path",
            tool: "glob",
            pattern: "**/*.ts",
            path: "src",
          },
          {
            id: "grep_with_path",
            tool: "grep",
            pattern: "SessionStore",
            path: "src",
          },
          {
            id: "edit_all",
            tool: "edit",
            path: "src/index.ts",
            edits: [{ oldText: "old", newText: "new", replaceAll: true }],
          },
          {
            id: "write_file",
            tool: "write",
            path: "out.txt",
            content: "content\n",
          },
          {
            id: "bash_timeout",
            tool: "bash",
            command: "echo ok",
            timeoutMs: 1_000,
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "read_with_range",
        content: "read result",
        sourceTruncated: false,
      },
      { role: "tool", toolCallId: "ls_with_options", content: "ls result" },
      { role: "tool", toolCallId: "glob_with_path", content: "glob result" },
      {
        role: "tool",
        toolCallId: "grep_with_path",
        content: "grep result",
        sourceTruncated: true,
      },
      { role: "tool", toolCallId: "edit_all", content: "edit result" },
      { role: "tool", toolCallId: "write_file", content: "write result" },
      { role: "tool", toolCallId: "bash_timeout", content: "bash result" },
    ];

    try {
      const session = createSessionStore({
        sessionId: "tool-shapes",
        workspace,
        runtime: runtime(home),
      });
      persistSessionMessages({
        session,
        previousMessages: [],
        currentMessages: messages,
        runtime: runtime(home, 1),
        reason: "turn",
      });

      // When
      const resumed = resumeSessionStore({
        sessionId: "tool-shapes",
        workspace,
        runtime: runtime(home, 2),
      });

      // Then
      expect(resumed.messages).toEqual(messages);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a persisted assistant message has provider reasoning metadata,
    When the session is resumed,
    Then the reasoning metadata survives the disk boundary`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const messages: readonly Message[] = [
      { role: "user", content: "read note" },
      {
        role: "assistant",
        content: "I need to inspect note.txt.",
        providerMetadata: {
          openaiCompatible: {
            reasoningContent: "The user asked about note.txt.",
          },
        },
        toolCalls: [
          {
            id: "read_note",
            tool: "read",
            path: "note.txt",
          },
        ],
      },
      { role: "tool", toolCallId: "read_note", content: "note body" },
    ];

    try {
      const session = createSessionStore({
        sessionId: "provider-metadata",
        workspace,
        runtime: runtime(home),
      });
      persistSessionMessages({
        session,
        previousMessages: [],
        currentMessages: messages,
        runtime: runtime(home, 1),
        reason: "turn",
      });

      // When
      const resumed = resumeSessionStore({
        sessionId: "provider-metadata",
        workspace,
        runtime: runtime(home, 2),
      });

      // Then
      expect(resumed.messages).toEqual(messages);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given tool calls omit optional fields,
    When the session is resumed,
    Then the minimal tool-call shapes survive the disk boundary`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const messages: readonly Message[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "read_minimal", tool: "read", path: "src/index.ts" },
          { id: "ls_minimal", tool: "ls" },
          { id: "glob_minimal", tool: "glob", pattern: "**/*.ts" },
          { id: "grep_minimal", tool: "grep", pattern: "SessionStore" },
          {
            id: "edit_minimal",
            tool: "edit",
            path: "src/index.ts",
            edits: [{ oldText: "old", newText: "new" }],
          },
          { id: "bash_minimal", tool: "bash", command: "echo ok" },
        ],
      },
      { role: "tool", toolCallId: "read_minimal", content: "read result" },
      { role: "tool", toolCallId: "ls_minimal", content: "ls result" },
      { role: "tool", toolCallId: "glob_minimal", content: "glob result" },
      { role: "tool", toolCallId: "grep_minimal", content: "grep result" },
      { role: "tool", toolCallId: "edit_minimal", content: "edit result" },
      { role: "tool", toolCallId: "bash_minimal", content: "bash result" },
    ];

    try {
      const session = createSessionStore({
        sessionId: "minimal-tool-shapes",
        workspace,
        runtime: runtime(home),
      });
      persistSessionMessages({
        session,
        previousMessages: [],
        currentMessages: messages,
        runtime: runtime(home, 1),
        reason: "turn",
      });

      // When
      const resumed = resumeSessionStore({
        sessionId: "minimal-tool-shapes",
        workspace,
        runtime: runtime(home, 2),
      });

      // Then
      expect(resumed.messages).toEqual(messages);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given persisted tool calls contain explicit null optional arguments,
    When the session is resumed,
    Then null optionals are normalized to absent tool-call fields`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const expectedMessages: readonly Message[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "read_nulls", tool: "read", path: "src/index.ts" },
          {
            id: "edit_nulls",
            tool: "edit",
            path: "src/index.ts",
            edits: [{ oldText: "old", newText: "new" }],
          },
          { id: "bash_null", tool: "bash", command: "echo ok" },
        ],
      },
      { role: "tool", toolCallId: "read_nulls", content: "read result" },
      { role: "tool", toolCallId: "edit_nulls", content: "edit result" },
      { role: "tool", toolCallId: "bash_null", content: "bash result" },
    ];

    try {
      const session = createSessionStore({
        sessionId: "null-tool-optionals",
        workspace,
        runtime: runtime(home),
      });
      const ledgerRecord = {
        schemaVersion: 2,
        type: "append",
        timestamp: "1970-01-01T00:00:00.001Z",
        reason: "turn",
        messages: [
          {
            id: "stored-message-1",
            message: {
              role: "assistant",
              content: "",
              toolCalls: [
                {
                  id: "read_nulls",
                  tool: "read",
                  path: "src/index.ts",
                  offset: null,
                  limit: null,
                },
                {
                  id: "edit_nulls",
                  tool: "edit",
                  path: "src/index.ts",
                  edits: [
                    {
                      oldText: "old",
                      newText: "new",
                      replaceAll: null,
                    },
                  ],
                },
                {
                  id: "bash_null",
                  tool: "bash",
                  command: "echo ok",
                  timeoutMs: null,
                },
              ],
            },
          },
          {
            id: "stored-message-2",
            message: {
              role: "tool",
              toolCallId: "read_nulls",
              content: "read result",
            },
          },
          {
            id: "stored-message-3",
            message: {
              role: "tool",
              toolCallId: "edit_nulls",
              content: "edit result",
            },
          },
          {
            id: "stored-message-4",
            message: {
              role: "tool",
              toolCallId: "bash_null",
              content: "bash result",
            },
          },
        ],
      };
      await writeFile(
        session.filePath,
        `${await readFile(session.filePath, "utf8")}${JSON.stringify(ledgerRecord)}\n`,
        "utf8",
      );

      // When
      const resumed = resumeSessionStore({
        sessionId: "null-tool-optionals",
        workspace,
        runtime: runtime(home, 2),
      });

      // Then
      expect(resumed.messages).toStrictEqual(expectedMessages);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given completed tool calls are already persisted,
    When the same transcript and then a follow-up are persisted,
    Then the store compares the structural prefix and appends only new messages`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const messages: readonly Message[] = [
      { role: "user", content: "list files" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "list_src", tool: "ls", path: "src", limit: 10 }],
      },
      { role: "tool", toolCallId: "list_src", content: "index.ts\n" },
      { role: "assistant", content: "Found index.ts.", toolCalls: [] },
    ];
    const followUp = { role: "user" as const, content: "thanks" };

    try {
      const session = createSessionStore({
        sessionId: "tool-prefix",
        workspace,
        runtime: runtime(home),
      });
      const afterFirstPersist = persistSessionMessages({
        session,
        previousMessages: [],
        currentMessages: messages,
        runtime: runtime(home, 1),
        reason: "turn",
      });

      // When
      const afterNoOpPersist = persistSessionMessages({
        session,
        previousMessages: afterFirstPersist,
        currentMessages: messages,
        runtime: runtime(home, 2),
        reason: "turn",
      });
      persistSessionMessages({
        session,
        previousMessages: afterNoOpPersist,
        currentMessages: [...messages, followUp],
        runtime: runtime(home, 3),
        reason: "turn",
      });

      // Then
      const ledgerLines = (await readFile(session.filePath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(ledgerLines).toHaveLength(3);
      expect(ledgerLines[2]).toEqual({
        schemaVersion: 2,
        type: "append",
        timestamp: "1970-01-01T00:00:00.003Z",
        reason: "turn",
        messages: expectedStoredMessages([followUp]),
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a completed edit tool call is resumed from disk,
    When the same structural transcript receives a follow-up message,
    Then the store compares nested canonical arguments and appends only the new message`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const messages: readonly Message[] = [
      { role: "user", content: "update settings" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "edit_settings",
            tool: "edit",
            path: "settings.ts",
            edits: [
              { oldText: "timeout = 1000", newText: "timeout = 2500" },
              { oldText: "retries = 2", newText: "retries = 5" },
            ],
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "edit_settings",
        content: "Edited settings.ts",
      },
      { role: "assistant", content: "Updated settings.", toolCalls: [] },
    ];
    const followUp = { role: "user" as const, content: "thanks" };

    try {
      const session = createSessionStore({
        sessionId: "edit-tool-prefix",
        workspace,
        runtime: runtime(home),
      });
      persistSessionMessages({
        session,
        previousMessages: [],
        currentMessages: messages,
        runtime: runtime(home, 1),
        reason: "turn",
      });
      const resumed = resumeSessionStore({
        sessionId: "edit-tool-prefix",
        workspace,
        runtime: runtime(home, 2),
      });

      // When
      persistSessionMessages({
        session: resumed,
        previousMessages: resumed.messages,
        currentMessages: [...messages, followUp],
        runtime: runtime(home, 3),
        reason: "turn",
      });

      // Then
      const ledgerLines = (await readFile(resumed.filePath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(ledgerLines).toHaveLength(3);
      expect(ledgerLines[2]).toEqual({
        schemaVersion: 2,
        type: "append",
        timestamp: "1970-01-01T00:00:00.003Z",
        reason: "turn",
        messages: expectedStoredMessages([followUp]),
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a resumed edit tool call has different nested arguments,
    When the changed transcript is persisted,
    Then the store replaces the transcript instead of treating it as an append`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const persistedMessages: readonly Message[] = [
      { role: "user", content: "update settings" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "edit_settings",
            tool: "edit",
            path: "settings.ts",
            edits: [{ oldText: "timeout = 1000", newText: "timeout = 2500" }],
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "edit_settings",
        content: "Edited settings.ts",
      },
    ];
    const changedMessages: readonly Message[] = [
      { role: "user", content: "update settings" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "edit_settings",
            tool: "edit",
            path: "settings.ts",
            edits: [
              {
                oldText: "timeout = 1000",
                newText: "timeout = 2500",
                replaceAll: true,
              },
            ],
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "edit_settings",
        content: "Edited settings.ts",
      },
    ];

    try {
      const session = createSessionStore({
        sessionId: "edit-tool-replace",
        workspace,
        runtime: runtime(home),
      });
      persistSessionMessages({
        session,
        previousMessages: [],
        currentMessages: persistedMessages,
        runtime: runtime(home, 1),
        reason: "turn",
      });
      const resumed = resumeSessionStore({
        sessionId: "edit-tool-replace",
        workspace,
        runtime: runtime(home, 2),
      });

      // When
      persistSessionMessages({
        session: resumed,
        previousMessages: resumed.messages,
        currentMessages: changedMessages,
        runtime: runtime(home, 3),
        reason: "turn",
      });

      // Then
      const ledgerLines = (await readFile(resumed.filePath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(ledgerLines).toHaveLength(3);
      expect(ledgerLines[2]).toEqual({
        schemaVersion: 2,
        type: "replace",
        timestamp: "1970-01-01T00:00:00.003Z",
        reason: "turn",
        messages: expectedStoredMessages(changedMessages),
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a persisted tool call violates the builtin registry schema,
    When the session is resumed,
    Then it fails closed before rebuilding provider context`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const messages: readonly Message[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "too_many_ls", tool: "ls", limit: 1_001 }],
      },
      { role: "tool", toolCallId: "too_many_ls", content: "ls result" },
    ];

    try {
      const session = createSessionStore({
        sessionId: "invalid-registry-tool",
        workspace,
        runtime: runtime(home),
      });
      await writeFile(
        session.filePath,
        `${await readFile(session.filePath, "utf8")}${appendLine(messages)}\n`,
        "utf8",
      );

      // When / Then
      expect(() =>
        resumeSessionStore({
          sessionId: "invalid-registry-tool",
          workspace,
          runtime: runtime(home, 2),
        }),
      ).toThrow(SessionStoreError);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given provider-visible messages violate the builtin registry schema,
    When the session store persists them,
    Then it rejects the transcript before writing an invalid ledger entry`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const messages: readonly Message[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "too_many_ls", tool: "ls", limit: 1_001 }],
      },
      { role: "tool", toolCallId: "too_many_ls", content: "ls result" },
    ];

    try {
      const session = createSessionStore({
        sessionId: "persist-invalid-registry-tool",
        workspace,
        runtime: runtime(home),
      });

      // When / Then
      expect(() =>
        persistSessionMessages({
          session,
          previousMessages: [],
          currentMessages: messages,
          runtime: runtime(home, 1),
          reason: "turn",
        }),
      ).toThrow(SessionStoreError);
      expect(await readFile(session.filePath, "utf8")).toBe(
        `${headerLine(session.id, session.workspace)}\n`,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a persisted session ends with a pending tool call,
    When the session is resumed,
    Then it fails closed instead of restoring in-flight work`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const messages: readonly Message[] = [
      { role: "user", content: "write the file" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "pending_write",
            tool: "write",
            path: "out.txt",
            content: "content\n",
          },
        ],
      },
    ];

    try {
      const session = createSessionStore({
        sessionId: "pending-tool",
        workspace,
        runtime: runtime(home),
      });
      await writeFile(
        session.filePath,
        `${await readFile(session.filePath, "utf8")}${appendLine(messages)}\n`,
        "utf8",
      );

      // When / Then
      expect(() =>
        resumeSessionStore({
          sessionId: "pending-tool",
          workspace,
          runtime: runtime(home, 2),
        }),
      ).toThrow(SessionStoreError);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a pending tool call is followed by a new user message,
    When the session is resumed,
    Then it fails closed before dropping the incomplete tool call`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const messages: readonly Message[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "pending_read",
            tool: "read",
            path: "todo.txt",
          },
        ],
      },
      { role: "user", content: "new request" },
    ];

    try {
      const session = createSessionStore({
        sessionId: "pending-before-message",
        workspace,
        runtime: runtime(home),
      });
      await writeFile(
        session.filePath,
        `${await readFile(session.filePath, "utf8")}${appendLine(messages)}\n`,
        "utf8",
      );

      // When / Then
      expect(() =>
        resumeSessionStore({
          sessionId: "pending-before-message",
          workspace,
          runtime: runtime(home, 2),
        }),
      ).toThrow(SessionStoreError);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given an assistant message repeats the same tool-call id,
    When the session is resumed,
    Then it fails closed before rebuilding provider context`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const messages: readonly Message[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "duplicate", tool: "read", path: "a.txt" },
          { id: "duplicate", tool: "read", path: "b.txt" },
        ],
      },
      { role: "tool", toolCallId: "duplicate", content: "first result" },
    ];

    try {
      const session = createSessionStore({
        sessionId: "duplicate-tool-id",
        workspace,
        runtime: runtime(home),
      });
      await writeFile(
        session.filePath,
        `${await readFile(session.filePath, "utf8")}${appendLine(messages)}\n`,
        "utf8",
      );

      // When / Then
      expect(() =>
        resumeSessionStore({
          sessionId: "duplicate-tool-id",
          workspace,
          runtime: runtime(home, 2),
        }),
      ).toThrow(SessionStoreError);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a persisted session contains a stray tool result,
    When the session is resumed,
    Then it fails closed before rebuilding provider context`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const messages: readonly Message[] = [
      { role: "tool", toolCallId: "missing_call", content: "orphan result" },
    ];

    try {
      const session = createSessionStore({
        sessionId: "stray-tool",
        workspace,
        runtime: runtime(home),
      });
      await writeFile(
        session.filePath,
        `${await readFile(session.filePath, "utf8")}${appendLine(messages)}\n`,
        "utf8",
      );

      // When / Then
      expect(() =>
        resumeSessionStore({
          sessionId: "stray-tool",
          workspace,
          runtime: runtime(home, 2),
        }),
      ).toThrow(SessionStoreError);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given compaction replaced the persisted transcript,
    When the session is resumed,
    Then only the compacted checkpoint history is restored`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const originalMessages: readonly Message[] = [
      { role: "user", content: "old task" },
      { role: "assistant", content: "old progress", toolCalls: [] },
    ];
    const compactedMessages: readonly Message[] = [
      {
        role: "user",
        content:
          "<conversation-checkpoint>\n<summary>\nOld task summarized.\n</summary>\n</conversation-checkpoint>",
      },
    ];

    try {
      const session = createSessionStore({
        sessionId: "compacted",
        workspace,
        runtime: runtime(home),
      });
      const afterFirstTurn = persistSessionMessages({
        session,
        previousMessages: [],
        currentMessages: originalMessages,
        runtime: runtime(home, 1),
        reason: "turn",
      });
      persistSessionMessages({
        session,
        previousMessages: afterFirstTurn,
        currentMessages: compactedMessages,
        runtime: runtime(home, 2),
        reason: "compaction",
      });

      // When
      const resumed = resumeSessionStore({
        sessionId: "compacted",
        workspace,
        runtime: runtime(home, 3),
      });

      // Then
      expect(resumed.messages).toEqual(compactedMessages);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
});
