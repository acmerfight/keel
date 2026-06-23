import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  acquireSessionLock,
  consumeSessionQueuedInputs,
  createSessionStore,
  ensureSessionCanBeCreated,
  forkSessionStore,
  persistSessionBashApprovalGrant,
  persistSessionMessages,
  persistSessionQueuedInput,
  resumeSessionStore,
  type SessionQueuedInput,
  SessionStoreError,
} from "../../src/cli/session-store.ts";
import type { Message } from "../../src/llm/types.ts";
import type { BashApprovalGrant } from "../../src/permissions/bash.ts";

function runtime(home: string, now = 0) {
  return {
    env: (key: string) => (key === "KEEL_HOME" ? home : undefined),
    now: () => now,
  };
}

function headerLine(sessionId: string, workspace: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    type: "session",
    id: sessionId,
    createdAt: "1970-01-01T00:00:00.000Z",
    workspace,
  });
}

function appendLine(messages: readonly Message[]): string {
  return JSON.stringify({
    schemaVersion: 1,
    type: "append",
    timestamp: "1970-01-01T00:00:00.000Z",
    reason: "turn",
    messages,
  });
}

function snapshotLine(
  messages: readonly Message[],
  pendingInputs: readonly SessionQueuedInput[],
): string {
  return JSON.stringify({
    schemaVersion: 1,
    type: "snapshot",
    timestamp: "1970-01-01T00:00:00.000Z",
    reason: "size_threshold",
    messages,
    pendingInputs,
  });
}

function inputAdmittedLine(input: SessionQueuedInput): string {
  return JSON.stringify({
    schemaVersion: 1,
    type: "input_admitted",
    timestamp: input.timestamp,
    id: input.id,
    sequence: input.sequence,
    line: input.line,
  });
}

function inputConsumedLine(inputIds: readonly string[]): string {
  return JSON.stringify({
    schemaVersion: 1,
    type: "input_consumed",
    timestamp: "1970-01-01T00:00:00.005Z",
    inputIds,
  });
}

describe("Session Store", () => {
  test(`Given a completed interactive transcript was persisted,
    When the session is resumed,
    Then the provider-visible messages are restored`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const messages: readonly Message[] = [
      { role: "user", content: "remember alpha" },
      { role: "assistant", content: "Remembered alpha.", toolCalls: [] },
    ];

    try {
      const session = createSessionStore({
        sessionId: "demo",
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
        sessionId: "demo",
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

  test(`Given prompt input was queued while a named session was busy,
    When the session is resumed before another turn consumes it,
    Then the queued input is restored without changing provider-visible history`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));

    try {
      const session = createSessionStore({
        sessionId: "pending-input",
        workspace,
        runtime: runtime(home),
      });
      const queuedInput = persistSessionQueuedInput({
        session,
        sequence: 3,
        line: "continue with beta",
        runtime: runtime(home, 1),
      });

      // When
      const resumed = resumeSessionStore({
        sessionId: "pending-input",
        workspace,
        runtime: runtime(home, 2),
      });

      // Then
      expect(resumed.messages).toEqual([]);
      expect(resumed.pendingInputs).toEqual([queuedInput]);
      const ledgerLines = (await readFile(session.filePath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(ledgerLines[1]).toEqual({
        schemaVersion: 1,
        type: "input_admitted",
        timestamp: "1970-01-01T00:00:00.001Z",
        id: queuedInput.id,
        sequence: 3,
        line: "continue with beta",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a queued input is consumed by a persisted turn,
    When the session is resumed,
    Then the turn is restored and the queued input is not replayed`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const messages: readonly Message[] = [
      { role: "user", content: "continue with beta" },
      { role: "assistant", content: "Beta complete.", toolCalls: [] },
    ];

    try {
      const session = createSessionStore({
        sessionId: "consume-input",
        workspace,
        runtime: runtime(home),
      });
      const queuedInput = persistSessionQueuedInput({
        session,
        sequence: 4,
        line: "continue with beta",
        runtime: runtime(home, 1),
      });

      // When
      persistSessionMessages({
        session,
        previousMessages: [],
        currentMessages: messages,
        runtime: runtime(home, 2),
        reason: "turn",
        consumedInputIds: [queuedInput.id, queuedInput.id],
      });
      const resumed = resumeSessionStore({
        sessionId: "consume-input",
        workspace,
        runtime: runtime(home, 3),
      });

      // Then
      expect(resumed.messages).toEqual(messages);
      expect(resumed.pendingInputs).toEqual([]);
      const ledgerLines = (await readFile(session.filePath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(ledgerLines[2]).toEqual({
        schemaVersion: 1,
        type: "append",
        timestamp: "1970-01-01T00:00:00.002Z",
        reason: "turn",
        messages,
        consumedInputIds: [queuedInput.id],
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given pending inputs were admitted out of order,
    When the session is resumed,
    Then pending inputs replay by sequence, timestamp, and id`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    await mkdir(join(home, "sessions", "ordered-inputs"), {
      recursive: true,
    });
    await writeFile(
      join(home, "sessions", "ordered-inputs", "ledger.jsonl"),
      `${[
        headerLine("ordered-inputs", ledgerWorkspace),
        JSON.stringify({
          schemaVersion: 1,
          type: "input_admitted",
          timestamp: "1970-01-01T00:00:00.003Z",
          id: "sequence-last",
          sequence: 3,
          line: "third",
        }),
        JSON.stringify({
          schemaVersion: 1,
          type: "input_admitted",
          timestamp: "1970-01-01T00:00:00.002Z",
          id: "same-sequence-later",
          sequence: 1,
          line: "second by timestamp",
        }),
        JSON.stringify({
          schemaVersion: 1,
          type: "input_admitted",
          timestamp: "1970-01-01T00:00:00.001Z",
          id: "same-sequence-earlier",
          sequence: 1,
          line: "first by timestamp",
        }),
        JSON.stringify({
          schemaVersion: 1,
          type: "input_admitted",
          timestamp: "1970-01-01T00:00:00.004Z",
          id: "same-time-b",
          sequence: 2,
          line: "same timestamp second id",
        }),
        JSON.stringify({
          schemaVersion: 1,
          type: "input_admitted",
          timestamp: "1970-01-01T00:00:00.004Z",
          id: "same-time-a",
          sequence: 2,
          line: "same timestamp first id",
        }),
      ].join("\n")}\n`,
      "utf8",
    );

    try {
      // When
      const resumed = resumeSessionStore({
        sessionId: "ordered-inputs",
        workspace,
        runtime: runtime(home),
      });

      // Then
      expect(resumed.pendingInputs.map((input) => input.id)).toEqual([
        "same-sequence-earlier",
        "same-sequence-later",
        "same-time-a",
        "same-time-b",
        "sequence-last",
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a queued command is handled without changing the transcript,
    When the queued input is marked consumed,
    Then later resumes do not replay that command`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));

    try {
      const session = createSessionStore({
        sessionId: "consume-command",
        workspace,
        runtime: runtime(home),
      });
      const queuedInput = persistSessionQueuedInput({
        session,
        sequence: 5,
        line: "/compact",
        runtime: runtime(home, 1),
      });

      // When
      consumeSessionQueuedInputs({
        session,
        inputIds: [queuedInput.id],
        runtime: runtime(home, 2),
      });
      const resumed = resumeSessionStore({
        sessionId: "consume-command",
        workspace,
        runtime: runtime(home, 3),
      });

      // Then
      expect(resumed.messages).toEqual([]);
      expect(resumed.pendingInputs).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given no queued input ids are consumed,
    When the consume request is persisted,
    Then the ledger is left unchanged`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));

    try {
      const session = createSessionStore({
        sessionId: "consume-empty",
        workspace,
        runtime: runtime(home),
      });
      const before = await readFile(session.filePath, "utf8");

      // When
      consumeSessionQueuedInputs({
        session,
        inputIds: [],
        runtime: runtime(home, 1),
      });

      // Then
      expect(await readFile(session.filePath, "utf8")).toBe(before);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a queued input is consumed after the transcript is already persisted,
    When persistence receives the same transcript with the consumed input id,
    Then it records only input consumption without duplicating messages`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const messages: readonly Message[] = [
      { role: "user", content: "remember alpha" },
      { role: "assistant", content: "Remembered alpha.", toolCalls: [] },
    ];

    try {
      const session = createSessionStore({
        sessionId: "consume-after-noop",
        workspace,
        runtime: runtime(home),
      });
      const queuedInput = persistSessionQueuedInput({
        session,
        sequence: 6,
        line: "/compact",
        runtime: runtime(home, 1),
      });
      const persisted = persistSessionMessages({
        session,
        previousMessages: [],
        currentMessages: messages,
        runtime: runtime(home, 2),
        reason: "turn",
      });

      // When
      persistSessionMessages({
        session,
        previousMessages: persisted,
        currentMessages: messages,
        runtime: runtime(home, 3),
        reason: "compaction",
        consumedInputIds: [queuedInput.id],
      });
      const resumed = resumeSessionStore({
        sessionId: "consume-after-noop",
        workspace,
        runtime: runtime(home, 4),
      });

      // Then
      expect(resumed.messages).toEqual(messages);
      expect(resumed.pendingInputs).toEqual([]);
      const ledgerLines = (await readFile(session.filePath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(ledgerLines.at(-1)).toEqual({
        schemaVersion: 1,
        type: "input_consumed",
        timestamp: "1970-01-01T00:00:00.003Z",
        inputIds: [queuedInput.id],
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

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
      { role: "tool", toolCallId: "read_with_range", content: "read result" },
      { role: "tool", toolCallId: "ls_with_options", content: "ls result" },
      { role: "tool", toolCallId: "glob_with_path", content: "glob result" },
      { role: "tool", toolCallId: "grep_with_path", content: "grep result" },
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
        schemaVersion: 1,
        type: "append",
        timestamp: "1970-01-01T00:00:00.003Z",
        reason: "turn",
        messages: [followUp],
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
        schemaVersion: 1,
        type: "append",
        timestamp: "1970-01-01T00:00:00.003Z",
        reason: "turn",
        messages: [followUp],
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
        schemaVersion: 1,
        type: "replace",
        timestamp: "1970-01-01T00:00:00.003Z",
        reason: "turn",
        messages: changedMessages,
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
        sessionId: "pending-before-user",
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
          sessionId: "pending-before-user",
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

  test(`Given a session id already exists,
    When a user starts the same named session again,
    Then creation fails instead of overwriting the transcript`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));

    try {
      createSessionStore({
        sessionId: "existing",
        workspace,
        runtime: runtime(home),
      });

      // When / Then
      expect(() =>
        createSessionStore({
          sessionId: "existing",
          workspace,
          runtime: runtime(home, 1),
        }),
      ).toThrow(SessionStoreError);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a session ledger already exists,
    When a user checks whether the name can be created,
    Then the store reports that the session should be resumed instead`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));

    try {
      createSessionStore({
        sessionId: "existing-check",
        workspace,
        runtime: runtime(home),
      });

      // When / Then
      expect(() =>
        ensureSessionCanBeCreated({
          sessionId: "existing-check",
          runtime: runtime(home),
        }),
      ).toThrow(SessionStoreError);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a session lock is already held,
    When the same session lock is acquired again,
    Then it fails closed until the original lock is released`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const firstLock = acquireSessionLock({
      sessionId: "active",
      runtime: runtime(home),
    });

    try {
      // When / Then
      expect(() =>
        acquireSessionLock({
          sessionId: "active",
          runtime: runtime(home, 1),
        }),
      ).toThrow(SessionStoreError);
    } finally {
      firstLock.release();
    }

    try {
      // Then
      const secondLock = acquireSessionLock({
        sessionId: "active",
        runtime: runtime(home, 2),
      });
      secondLock.release();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a previous process left a stale session lock,
    When the same session lock is acquired again,
    Then the store recovers the stale lock and acquires a fresh one`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const lockPath = join(home, "sessions", "stale", "active.lock");
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      join(lockPath, "owner.json"),
      `${JSON.stringify({
        pid: 999_999_999,
        token: "stale",
        createdAt: "1970-01-01T00:00:00.000Z",
      })}\n`,
      "utf8",
    );

    try {
      // When
      const lock = acquireSessionLock({
        sessionId: "stale",
        runtime: runtime(home, 1),
      });

      // Then
      expect(lock.lockPath).toBe(lockPath);
      expect(() =>
        acquireSessionLock({
          sessionId: "stale",
          runtime: runtime(home, 2),
        }),
      ).toThrow(SessionStoreError);
      lock.release();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given KEEL_HOME is not configured,
    When a user checks whether a fresh session name can be created,
    Then the default session home is accepted without creating a ledger`, () => {
    // Given
    const sessionId = `default-home-${randomUUID()}`;
    const defaultRuntime = {
      env: () => undefined,
      now: () => 0,
    };

    // When / Then
    expect(() =>
      ensureSessionCanBeCreated({
        sessionId,
        runtime: defaultRuntime,
      }),
    ).not.toThrow();
  });

  test(`Given a session id contains path traversal,
    When a user starts that session,
    Then the id is rejected before writing files`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));

    try {
      // When / Then
      expect(() =>
        createSessionStore({
          sessionId: "../escape",
          workspace,
          runtime: runtime(home),
        }),
      ).toThrow(SessionStoreError);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a session id contains a parent-directory marker,
    When a user starts that session,
    Then the id is rejected before resolving a ledger path`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));

    try {
      // When / Then
      expect(() =>
        createSessionStore({
          sessionId: "bad..id",
          workspace,
          runtime: runtime(home),
        }),
      ).toThrow(SessionStoreError);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a session ledger cannot be inspected,
    When a user starts that named session,
    Then the store fails closed before the turn starts`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    await mkdir(join(home, "sessions"), { recursive: true });
    await writeFile(join(home, "sessions", "blocked"), "not a directory");

    try {
      // When / Then
      expect(() =>
        ensureSessionCanBeCreated({
          sessionId: "blocked",
          runtime: runtime(home),
        }),
      ).toThrow(SessionStoreError);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a session does not exist,
    When a user resumes it,
    Then resume fails closed before returning messages`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));

    try {
      // When / Then
      expect(() =>
        resumeSessionStore({
          sessionId: "missing",
          workspace,
          runtime: runtime(home),
        }),
      ).toThrow(SessionStoreError);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given the session home blocks directory creation,
    When a user starts a named session,
    Then creating the ledger fails closed`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const homeParent = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const home = join(homeParent, "not-a-directory");
    await writeFile(home, "file");

    try {
      // When / Then
      expect(() =>
        createSessionStore({
          sessionId: "cannot-create",
          workspace,
          runtime: runtime(home),
        }),
      ).toThrow(SessionStoreError);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(homeParent, { recursive: true, force: true });
    }
  });

  test(`Given the session ledger is replaced by a directory after creation,
    When persistence appends another completed turn,
    Then writing fails closed with a session-store error`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));

    try {
      const session = createSessionStore({
        sessionId: "write-blocked",
        workspace,
        runtime: runtime(home),
      });
      await rm(session.filePath, { force: true });
      await mkdir(session.filePath);

      // When / Then
      expect(() =>
        persistSessionMessages({
          session,
          previousMessages: [],
          currentMessages: [{ role: "user", content: "hello" }],
          runtime: runtime(home, 1),
          reason: "turn",
        }),
      ).toThrow(SessionStoreError);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a session ledger path is not a readable file,
    When a user resumes it,
    Then resume fails closed with a session-load error`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    await mkdir(join(home, "sessions", "directory-ledger", "ledger.jsonl"), {
      recursive: true,
    });

    try {
      // When / Then
      expect(() =>
        resumeSessionStore({
          sessionId: "directory-ledger",
          workspace,
          runtime: runtime(home),
        }),
      ).toThrow(SessionStoreError);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a persisted session belongs to another workspace,
    When the user resumes it from the current workspace,
    Then resume fails closed with a workspace mismatch`, async () => {
    // Given
    const originalWorkspace = await mkdtemp(
      join(tmpdir(), "keel-session-workspace-"),
    );
    const currentWorkspace = await mkdtemp(
      join(tmpdir(), "keel-session-workspace-"),
    );
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    await mkdir(join(home, "sessions", "wrong-workspace"), {
      recursive: true,
    });
    await writeFile(
      join(home, "sessions", "wrong-workspace", "ledger.jsonl"),
      `${headerLine("wrong-workspace", originalWorkspace)}\n`,
      "utf8",
    );

    try {
      // When / Then
      expect(() =>
        resumeSessionStore({
          sessionId: "wrong-workspace",
          workspace: currentWorkspace,
          runtime: runtime(home),
        }),
      ).toThrow(SessionStoreError);
    } finally {
      await rm(originalWorkspace, { recursive: true, force: true });
      await rm(currentWorkspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a ledger header belongs to a different session id,
    When the user resumes the requested session,
    Then resume fails closed before replaying records`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    await mkdir(join(home, "sessions", "requested"), { recursive: true });
    await writeFile(
      join(home, "sessions", "requested", "ledger.jsonl"),
      `${headerLine("other", workspace)}\n`,
      "utf8",
    );

    try {
      // When / Then
      expect(() =>
        resumeSessionStore({
          sessionId: "requested",
          workspace,
          runtime: runtime(home),
        }),
      ).toThrow(SessionStoreError);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a ledger has no session header,
    When the user resumes it,
    Then resume fails closed before replaying append records`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    await mkdir(join(home, "sessions", "no-header"), { recursive: true });
    await writeFile(
      join(home, "sessions", "no-header", "ledger.jsonl"),
      `${JSON.stringify({
        schemaVersion: 1,
        type: "append",
        timestamp: "1970-01-01T00:00:00.000Z",
        reason: "turn",
        messages: [{ role: "user", content: "hello" }],
      })}\n`,
      "utf8",
    );

    try {
      // When / Then
      expect(() =>
        resumeSessionStore({
          sessionId: "no-header",
          workspace,
          runtime: runtime(home),
        }),
      ).toThrow(SessionStoreError);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a session ledger file is empty,
    When the user resumes it,
    Then resume fails closed before returning an empty transcript`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    await mkdir(join(home, "sessions", "empty-ledger"), { recursive: true });
    await writeFile(
      join(home, "sessions", "empty-ledger", "ledger.jsonl"),
      "",
      "utf8",
    );

    try {
      // When / Then
      expect(() =>
        resumeSessionStore({
          sessionId: "empty-ledger",
          workspace,
          runtime: runtime(home),
        }),
      ).toThrow(SessionStoreError);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a ledger repeats the session header,
    When the user resumes it,
    Then resume fails closed before returning duplicate history`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    await mkdir(join(home, "sessions", "duplicate-header"), {
      recursive: true,
    });
    await writeFile(
      join(home, "sessions", "duplicate-header", "ledger.jsonl"),
      [
        headerLine("duplicate-header", workspace),
        headerLine("duplicate-header", workspace),
      ].join("\n"),
      "utf8",
    );

    try {
      // When / Then
      expect(() =>
        resumeSessionStore({
          sessionId: "duplicate-header",
          workspace,
          runtime: runtime(home),
        }),
      ).toThrow(SessionStoreError);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a persisted session contains malformed JSONL,
    When the session is resumed,
    Then it fails closed with a session-load error`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const malformedLines = [headerLine("broken", workspace), "{not-json"];
    const malformedLedger = malformedLines.join("\n");
    await mkdir(join(home, "sessions", "broken"), { recursive: true });
    await writeFile(
      join(home, "sessions", "broken", "ledger.jsonl"),
      malformedLedger,
      "utf8",
    );

    try {
      // When / Then
      expect(() =>
        resumeSessionStore({
          sessionId: "broken",
          workspace,
          runtime: runtime(home),
        }),
      ).toThrow(SessionStoreError);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given the session ledger path cannot be inspected,
    When the session is resumed,
    Then the store fails closed before reading ledger bytes`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    await mkdir(join(home, "sessions"), { recursive: true });
    await writeFile(join(home, "sessions", "blocked"), "not a directory");

    try {
      // When
      let resumeError: unknown;
      try {
        resumeSessionStore({
          sessionId: "blocked",
          workspace,
          runtime: runtime(home),
        });
      } catch (error) {
        resumeError = error;
      }

      // Then
      expect(resumeError).toBeInstanceOf(SessionStoreError);
      if (!(resumeError instanceof Error)) {
        throw new Error("Expected resume to throw an Error");
      }
      expect(resumeError.message).toContain(
        'Error: cannot resume session "blocked": cannot inspect session ledger',
      );
      expect(resumeError.message).not.toContain("cannot read session ledger");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given the session ledger path is a directory,
    When the session is resumed,
    Then the store reports that the ledger cannot be read`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    await mkdir(join(home, "sessions", "directory-ledger", "ledger.jsonl"), {
      recursive: true,
    });

    try {
      // When
      let resumeError: unknown;
      try {
        resumeSessionStore({
          sessionId: "directory-ledger",
          workspace,
          runtime: runtime(home),
        });
      } catch (error) {
        resumeError = error;
      }

      // Then
      expect(resumeError).toBeInstanceOf(SessionStoreError);
      if (!(resumeError instanceof Error)) {
        throw new Error("Expected resume to throw an Error");
      }
      expect(resumeError.message).toContain(
        'Error: cannot resume session "directory-ledger": cannot read session ledger',
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a persisted session ledger is larger than the resume cap,
    When the session is resumed,
    Then the store reports recovery guidance before parsing JSONL records`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const ledgerPath = join(home, "sessions", "huge", "ledger.jsonl");
    await mkdir(join(home, "sessions", "huge"), { recursive: true });
    await writeFile(
      ledgerPath,
      `${headerLine("huge", workspace)}\n{not-json`,
      "utf8",
    );
    await truncate(ledgerPath, 32 * 1024 * 1024 + 1);

    try {
      // When
      let resumeError: unknown;
      try {
        resumeSessionStore({
          sessionId: "huge",
          workspace,
          runtime: runtime(home),
        });
      } catch (error) {
        resumeError = error;
      }

      // Then
      expect(resumeError).toBeInstanceOf(SessionStoreError);
      if (!(resumeError instanceof Error)) {
        throw new Error("Expected resume to throw an Error");
      }
      expect(resumeError.message).toContain(
        'Error: cannot resume session "huge": cannot load session ledger',
      );
      expect(resumeError.message).toContain(
        "ledger is too large to resume safely",
      );
      expect(resumeError.message).not.toContain("not valid JSON");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given an oversized session ledger has no header line,
    When the session is resumed,
    Then the store reports the missing header before tail replay`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const ledgerPath = join(home, "sessions", "no-header", "ledger.jsonl");
    await mkdir(join(home, "sessions", "no-header"), { recursive: true });
    await writeFile(ledgerPath, "\n", "utf8");
    await truncate(ledgerPath, 32 * 1024 * 1024 + 1);

    try {
      // When
      let resumeError: unknown;
      try {
        resumeSessionStore({
          sessionId: "no-header",
          workspace,
          runtime: runtime(home),
        });
      } catch (error) {
        resumeError = error;
      }

      // Then
      expect(resumeError).toBeInstanceOf(SessionStoreError);
      if (!(resumeError instanceof Error)) {
        throw new Error("Expected resume to throw an Error");
      }
      expect(resumeError.message).toContain(
        'Error: cannot resume session "no-header": cannot load session ledger',
      );
      expect(resumeError.message).toContain("ledger has no session header");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given an oversized session ledger cannot be opened for reading,
    When the session is resumed,
    Then the store reports that the ledger cannot be read`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const ledgerPath = join(
      home,
      "sessions",
      "unreadable-huge",
      "ledger.jsonl",
    );
    await mkdir(join(home, "sessions", "unreadable-huge"), {
      recursive: true,
    });
    await writeFile(
      ledgerPath,
      `${headerLine("unreadable-huge", ledgerWorkspace)}\n`,
      "utf8",
    );
    await truncate(ledgerPath, 32 * 1024 * 1024 + 1);
    await chmod(ledgerPath, 0o000);

    try {
      // When
      let resumeError: unknown;
      try {
        resumeSessionStore({
          sessionId: "unreadable-huge",
          workspace,
          runtime: runtime(home),
        });
      } catch (error) {
        resumeError = error;
      }

      // Then
      expect(resumeError).toBeInstanceOf(SessionStoreError);
      if (!(resumeError instanceof Error)) {
        throw new Error("Expected resume to throw an Error");
      }
      expect(resumeError.message).toContain(
        'Error: cannot resume session "unreadable-huge": cannot read session ledger',
      );
    } finally {
      await chmod(ledgerPath, 0o600);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given an oversized session ledger tail has no complete records,
    When the session is resumed,
    Then the store reports recovery guidance without parsing partial bytes`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const ledgerPath = join(home, "sessions", "partial-tail", "ledger.jsonl");
    const header = `${headerLine("partial-tail", ledgerWorkspace)}\n`;
    await mkdir(join(home, "sessions", "partial-tail"), { recursive: true });
    await writeFile(ledgerPath, header, "utf8");
    await truncate(ledgerPath, header.length + 32 * 1024 * 1024 + 1);

    try {
      // When
      let resumeError: unknown;
      try {
        resumeSessionStore({
          sessionId: "partial-tail",
          workspace,
          runtime: runtime(home),
        });
      } catch (error) {
        resumeError = error;
      }

      // Then
      expect(resumeError).toBeInstanceOf(SessionStoreError);
      if (!(resumeError instanceof Error)) {
        throw new Error("Expected resume to throw an Error");
      }
      expect(resumeError.message).toContain(
        'Error: cannot resume session "partial-tail": cannot load session ledger',
      );
      expect(resumeError.message).toContain(
        "ledger is too large to resume safely",
      );
      expect(resumeError.message).not.toContain("not valid JSON");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given an oversized session ledger tail has records but no snapshot,
    When the session is resumed,
    Then the store refuses to replay from an unbounded suffix`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const ledgerPath = join(home, "sessions", "suffix-only", "ledger.jsonl");
    await mkdir(join(home, "sessions", "suffix-only"), { recursive: true });
    await writeFile(
      ledgerPath,
      `${headerLine("suffix-only", ledgerWorkspace)}\n`,
      "utf8",
    );
    await truncate(ledgerPath, 32 * 1024 * 1024 + 1);
    await writeFile(
      ledgerPath,
      `\n${appendLine([{ role: "user", content: "unbounded suffix" }])}\n`,
      { encoding: "utf8", flag: "a" },
    );

    try {
      // When
      let resumeError: unknown;
      try {
        resumeSessionStore({
          sessionId: "suffix-only",
          workspace,
          runtime: runtime(home),
        });
      } catch (error) {
        resumeError = error;
      }

      // Then
      expect(resumeError).toBeInstanceOf(SessionStoreError);
      if (!(resumeError instanceof Error)) {
        throw new Error("Expected resume to throw an Error");
      }
      expect(resumeError.message).toContain(
        'Error: cannot resume session "suffix-only": cannot load session ledger',
      );
      expect(resumeError.message).toContain("no bounded snapshot was found");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given an oversized session ledger tail starts on a record boundary,
    When the session is resumed,
    Then the store restores the latest snapshot from that bounded tail`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const ledgerPath = join(home, "sessions", "boundary-tail", "ledger.jsonl");
    const snapshottedMessages: readonly Message[] = [
      { role: "user", content: "remember boundary" },
      { role: "assistant", content: "Boundary retained.", toolCalls: [] },
    ];
    const snapshotRecord = `${snapshotLine(snapshottedMessages, [])}\n`;
    const emptyPaddingRecord = `${appendLine([
      { role: "user", content: "" },
    ])}\n`;
    const paddingContentLength =
      32 * 1024 * 1024 -
      Buffer.byteLength(snapshotRecord, "utf8") -
      Buffer.byteLength(emptyPaddingRecord, "utf8");
    expect(paddingContentLength).toBeGreaterThan(0);
    const tail = `${appendLine([
      { role: "user", content: "x".repeat(paddingContentLength) },
    ])}\n${snapshotRecord}`;
    expect(Buffer.byteLength(tail, "utf8")).toBe(32 * 1024 * 1024);
    await mkdir(join(home, "sessions", "boundary-tail"), { recursive: true });
    await writeFile(
      ledgerPath,
      `${headerLine("boundary-tail", ledgerWorkspace)}\n`,
      "utf8",
    );
    await writeFile(ledgerPath, tail, { encoding: "utf8", flag: "a" });

    try {
      // When
      const resumed = resumeSessionStore({
        sessionId: "boundary-tail",
        workspace,
        runtime: runtime(home),
      });

      // Then
      expect(resumed.messages).toEqual(snapshottedMessages);
      expect(resumed.pendingInputs).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given an oversized session ledger tail has a corrupt snapshot record,
    When the session is resumed,
    Then the store refuses to trust the corrupt snapshot`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const ledgerPath = join(
      home,
      "sessions",
      "corrupt-snapshot",
      "ledger.jsonl",
    );
    await mkdir(join(home, "sessions", "corrupt-snapshot"), {
      recursive: true,
    });
    await writeFile(
      ledgerPath,
      `${headerLine("corrupt-snapshot", ledgerWorkspace)}\n`,
      "utf8",
    );
    await truncate(ledgerPath, 32 * 1024 * 1024 + 1);
    await writeFile(
      ledgerPath,
      `\n${JSON.stringify({
        schemaVersion: 1,
        type: "snapshot",
        timestamp: "1970-01-01T00:00:00.001Z",
        reason: "size_threshold",
        messages: "not-message-array",
        pendingInputs: [],
      })}\n`,
      { encoding: "utf8", flag: "a" },
    );

    try {
      // When
      let resumeError: unknown;
      try {
        resumeSessionStore({
          sessionId: "corrupt-snapshot",
          workspace,
          runtime: runtime(home),
        });
      } catch (error) {
        resumeError = error;
      }

      // Then
      expect(resumeError).toBeInstanceOf(SessionStoreError);
      if (!(resumeError instanceof Error)) {
        throw new Error("Expected resume to throw an Error");
      }
      expect(resumeError.message).toContain(
        'Error: cannot resume session "corrupt-snapshot": cannot load session ledger',
      );
      expect(resumeError.message).toContain("no bounded snapshot was found");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given an oversized session ledger has a bounded snapshot and newer records,
    When the session is resumed,
    Then snapshot state is restored and only the suffix is replayed`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const ledgerPath = join(home, "sessions", "snapshot-huge", "ledger.jsonl");
    const snapshottedMessages: readonly Message[] = [
      { role: "user", content: "remember alpha" },
      { role: "assistant", content: "Remembered alpha.", toolCalls: [] },
    ];
    const suffixMessages: readonly Message[] = [
      { role: "user", content: "continue with beta" },
      { role: "assistant", content: "Beta complete.", toolCalls: [] },
    ];
    const retainedInput: SessionQueuedInput = {
      id: "retained-before-snapshot",
      timestamp: "1970-01-01T00:00:00.002Z",
      sequence: 1,
      line: "continue with alpha",
    };
    const consumedInput: SessionQueuedInput = {
      id: "consumed-after-snapshot",
      timestamp: "1970-01-01T00:00:00.003Z",
      sequence: 2,
      line: "skip after suffix",
    };
    const admittedInput: SessionQueuedInput = {
      id: "admitted-after-snapshot",
      timestamp: "1970-01-01T00:00:00.004Z",
      sequence: 3,
      line: "continue with gamma",
    };
    await mkdir(join(home, "sessions", "snapshot-huge"), { recursive: true });
    await writeFile(
      ledgerPath,
      `${headerLine("snapshot-huge", ledgerWorkspace)}\n`,
      "utf8",
    );
    await truncate(ledgerPath, 32 * 1024 * 1024 + 1);
    await writeFile(
      ledgerPath,
      `\n${[
        snapshotLine(snapshottedMessages, [retainedInput, consumedInput]),
        appendLine(suffixMessages),
        inputConsumedLine([consumedInput.id]),
        inputAdmittedLine(admittedInput),
      ].join("\n")}\n`,
      { encoding: "utf8", flag: "a" },
    );

    try {
      // When
      const resumed = resumeSessionStore({
        sessionId: "snapshot-huge",
        workspace,
        runtime: runtime(home),
      });

      // Then
      expect(resumed.messages).toEqual([
        ...snapshottedMessages,
        ...suffixMessages,
      ]);
      expect(resumed.pendingInputs).toEqual([retainedInput, admittedInput]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a completed turn pushes a session ledger past the snapshot threshold,
    When the turn is persisted,
    Then the ledger stores a bounded snapshot with pending input`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const largeMessages: readonly Message[] = [
      { role: "user", content: "x".repeat(16 * 1024 * 1024) },
      { role: "assistant", content: "Large context noted.", toolCalls: [] },
    ];
    const compactedMessages: readonly Message[] = [
      { role: "user", content: "summary: alpha is important" },
      { role: "assistant", content: "Summary retained.", toolCalls: [] },
    ];

    try {
      const session = createSessionStore({
        sessionId: "snapshot-threshold",
        workspace,
        runtime: runtime(home),
      });
      const queuedInput = persistSessionQueuedInput({
        session,
        sequence: 7,
        line: "continue after the summary",
        runtime: runtime(home, 1),
      });
      const persistedLargeMessages = persistSessionMessages({
        session,
        previousMessages: [],
        currentMessages: largeMessages,
        runtime: runtime(home, 2),
        reason: "turn",
      });

      // When
      persistSessionMessages({
        session,
        previousMessages: persistedLargeMessages,
        currentMessages: compactedMessages,
        runtime: runtime(home, 3),
        reason: "compaction",
      });

      // Then
      const ledgerLines = (await readFile(session.filePath, "utf8"))
        .trimEnd()
        .split("\n");
      const lastLine = ledgerLines.at(-1);
      expect(lastLine).toBeDefined();
      if (lastLine === undefined) {
        throw new Error("Expected snapshot line");
      }
      expect(JSON.parse(lastLine)).toEqual({
        schemaVersion: 1,
        type: "snapshot",
        timestamp: "1970-01-01T00:00:00.003Z",
        reason: "size_threshold",
        messages: compactedMessages,
        pendingInputs: [queuedInput],
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given session bash approval grants are snapshotted,
    When the session is resumed from the bounded snapshot,
    Then the approval grants are restored`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const grant = {
      type: "exact",
      cwd: ledgerWorkspace,
      command: "npm test",
    } satisfies BashApprovalGrant;
    const largeMessages: readonly Message[] = [
      { role: "user", content: "x".repeat(16 * 1024 * 1024) },
    ];

    try {
      const session = createSessionStore({
        sessionId: "snapshot-bash-approvals",
        workspace,
        runtime: runtime(home),
      });
      persistSessionBashApprovalGrant({
        session,
        grant,
        runtime: runtime(home, 1),
      });

      // When
      persistSessionMessages({
        session,
        previousMessages: [],
        currentMessages: largeMessages,
        runtime: runtime(home, 2),
        reason: "turn",
      });
      const resumed = resumeSessionStore({
        sessionId: "snapshot-bash-approvals",
        workspace,
        runtime: runtime(home, 3),
      });

      // Then
      expect(resumed.bashApprovalGrants).toEqual([grant]);
      const ledgerLines = (await readFile(session.filePath, "utf8"))
        .trimEnd()
        .split("\n");
      const lastLine = ledgerLines.at(-1);
      expect(lastLine).toBeDefined();
      if (lastLine === undefined) {
        throw new Error("Expected snapshot line");
      }
      expect(JSON.parse(lastLine)).toMatchObject({
        type: "snapshot",
        bashApprovalGrants: [grant],
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a source session has bash approval grants,
    When it is forked into a new session,
    Then the target session starts without source approval grants`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const grant = {
      type: "prefix",
      cwd: ledgerWorkspace,
      argvPrefix: ["git", "status"],
    } satisfies BashApprovalGrant;

    try {
      const source = createSessionStore({
        sessionId: "source-with-approval",
        workspace,
        runtime: runtime(home),
      });
      persistSessionBashApprovalGrant({
        session: source,
        grant,
        runtime: runtime(home, 1),
      });

      // When
      const target = forkSessionStore({
        source,
        targetSessionId: "target-without-approval",
        runtime: runtime(home, 2),
      });
      const resumedTarget = resumeSessionStore({
        sessionId: "target-without-approval",
        workspace,
        runtime: runtime(home, 3),
      });

      // Then
      expect(source.bashApprovalGrants).toEqual([grant]);
      expect(target.bashApprovalGrants).toEqual([]);
      expect(resumedTarget.bashApprovalGrants).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given an oversized source session is restored from a bounded snapshot,
    When it is forked into a new session,
    Then the forked target can be resumed immediately`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const sourceLedgerPath = join(
      home,
      "sessions",
      "oversized-source",
      "ledger.jsonl",
    );
    const targetHeader = `${headerLine("target", ledgerWorkspace)}\n`;
    const emptyAppendLine = `${appendLine([{ role: "user", content: "" }])}\n`;
    const emptySnapshotLine = `${snapshotLine([{ role: "user", content: "" }], [])}\n`;
    const resumeCapBytes = 32 * 1024 * 1024;
    const contentLength =
      resumeCapBytes -
      Buffer.byteLength(targetHeader, "utf8") -
      Buffer.byteLength(emptyAppendLine, "utf8") +
      80;
    expect(contentLength).toBeLessThan(
      resumeCapBytes - Buffer.byteLength(emptySnapshotLine, "utf8"),
    );
    const snapshottedMessages: readonly Message[] = [
      { role: "user", content: "x".repeat(contentLength) },
    ];
    const snapshotRecord = `${snapshotLine(snapshottedMessages, [])}\n`;
    expect(Buffer.byteLength(snapshotRecord, "utf8")).toBeLessThan(
      resumeCapBytes,
    );
    await mkdir(join(home, "sessions", "oversized-source"), {
      recursive: true,
    });
    await writeFile(
      sourceLedgerPath,
      `${headerLine("oversized-source", ledgerWorkspace)}\n`,
      "utf8",
    );
    await truncate(sourceLedgerPath, resumeCapBytes + 1);
    await writeFile(sourceLedgerPath, `\n${snapshotRecord}`, {
      encoding: "utf8",
      flag: "a",
    });

    try {
      const source = resumeSessionStore({
        sessionId: "oversized-source",
        workspace,
        runtime: runtime(home),
      });

      // When
      const target = forkSessionStore({
        source,
        targetSessionId: "target",
        runtime: runtime(home, 1),
      });
      const resumedTarget = resumeSessionStore({
        sessionId: "target",
        workspace,
        runtime: runtime(home, 2),
      });

      // Then
      expect(resumedTarget.messages).toEqual(snapshottedMessages);
      expect(resumedTarget.pendingInputs).toEqual([]);
      const targetLedgerLines = (await readFile(target.filePath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(targetLedgerLines.at(-1)).toMatchObject({
        type: "snapshot",
        messages: snapshottedMessages,
        pendingInputs: [],
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a source session has no completed history,
    When it is forked into a new session,
    Then the target resumes as an empty fork`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));

    try {
      const source = createSessionStore({
        sessionId: "empty-source",
        workspace,
        runtime: runtime(home),
      });

      // When
      const target = forkSessionStore({
        source,
        targetSessionId: "empty-target",
        runtime: runtime(home, 1),
      });
      const resumedTarget = resumeSessionStore({
        sessionId: "empty-target",
        workspace,
        runtime: runtime(home, 2),
      });

      // Then
      expect(resumedTarget.messages).toEqual([]);
      expect(resumedTarget.pendingInputs).toEqual([]);
      const targetLedgerLines = (await readFile(target.filePath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(targetLedgerLines).toEqual([
        {
          schemaVersion: 1,
          type: "session",
          id: "empty-target",
          createdAt: "1970-01-01T00:00:00.001Z",
          workspace: source.workspace,
          forkedFrom: "empty-source",
        },
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a source session has completed history,
    When it is forked before the first restored user message,
    Then the target resumes as an empty fork`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const sourceMessages: readonly Message[] = [
      { role: "user", content: "remember alpha" },
      {
        role: "assistant",
        content: "Remembered: remember alpha",
        toolCalls: [],
      },
    ];

    try {
      const source = createSessionStore({
        sessionId: "source",
        workspace,
        runtime: runtime(home),
      });
      persistSessionMessages({
        session: source,
        previousMessages: [],
        currentMessages: sourceMessages,
        reason: "turn",
        consumedInputIds: [],
        runtime: runtime(home, 1),
      });
      const restoredSource = resumeSessionStore({
        sessionId: "source",
        workspace,
        runtime: runtime(home, 2),
      });

      // When
      const target = forkSessionStore({
        source: restoredSource,
        targetSessionId: "target",
        forkPoint: {
          beforeUser: 1,
          optionName: "--fork-before-user",
        },
        runtime: runtime(home, 3),
      });
      const resumedTarget = resumeSessionStore({
        sessionId: "target",
        workspace,
        runtime: runtime(home, 4),
      });

      // Then
      expect(resumedTarget.messages).toEqual([]);
      expect(resumedTarget.pendingInputs).toEqual([]);
      const targetLedgerLines = (await readFile(target.filePath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(targetLedgerLines).toEqual([
        {
          schemaVersion: 1,
          type: "session",
          id: "target",
          createdAt: "1970-01-01T00:00:00.003Z",
          workspace: source.workspace,
          forkedFrom: "source",
        },
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a source session has completed tool-call history before a later prompt,
    When it is forked before that later restored user message,
    Then the target keeps the complete tool-call prefix`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const retainedMessages: readonly Message[] = [
      { role: "user", content: "inspect workspace" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "tool-1",
            tool: "read",
            path: "README.md",
          },
        ],
      },
      { role: "tool", toolCallId: "tool-1", content: "README" },
      {
        role: "assistant",
        content: "The workspace has a README.",
        toolCalls: [],
      },
    ];
    const sourceMessages: readonly Message[] = [
      ...retainedMessages,
      { role: "user", content: "now remember beta" },
      {
        role: "assistant",
        content: "Remembered: now remember beta",
        toolCalls: [],
      },
    ];

    try {
      const source = createSessionStore({
        sessionId: "source",
        workspace,
        runtime: runtime(home),
      });
      persistSessionMessages({
        session: source,
        previousMessages: [],
        currentMessages: sourceMessages,
        reason: "turn",
        consumedInputIds: [],
        runtime: runtime(home, 1),
      });
      const restoredSource = resumeSessionStore({
        sessionId: "source",
        workspace,
        runtime: runtime(home, 2),
      });

      // When
      const target = forkSessionStore({
        source: restoredSource,
        targetSessionId: "target",
        forkPoint: {
          beforeUser: 2,
          optionName: "--fork-before-user",
        },
        runtime: runtime(home, 3),
      });
      const resumedTarget = resumeSessionStore({
        sessionId: "target",
        workspace,
        runtime: runtime(home, 4),
      });

      // Then
      expect(resumedTarget.messages).toEqual(retainedMessages);
      expect(resumedTarget.pendingInputs).toEqual([]);
      const targetLedgerLines = (await readFile(target.filePath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(targetLedgerLines.at(1)).toMatchObject({
        type: "append",
        messages: retainedMessages,
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a persisted session record has an invalid shape,
    When the session is resumed,
    Then it fails closed before restoring partial history`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    await mkdir(join(home, "sessions", "bad-record"), { recursive: true });
    await writeFile(
      join(home, "sessions", "bad-record", "ledger.jsonl"),
      [
        headerLine("bad-record", workspace),
        JSON.stringify({
          schemaVersion: 1,
          type: "append",
          timestamp: "1970-01-01T00:00:00.000Z",
          reason: "turn",
          messages: [{ role: "assistant", content: "missing toolCalls" }],
        }),
      ].join("\n"),
      "utf8",
    );

    try {
      // When / Then
      expect(() =>
        resumeSessionStore({
          sessionId: "bad-record",
          workspace,
          runtime: runtime(home),
        }),
      ).toThrow(SessionStoreError);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a persisted session uses an unsupported schema version,
    When the session is resumed,
    Then it fails closed before restoring messages`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    await mkdir(join(home, "sessions", "future"), { recursive: true });
    await writeFile(
      join(home, "sessions", "future", "ledger.jsonl"),
      `${JSON.stringify({
        schemaVersion: 2,
        type: "session",
        id: "future",
        createdAt: "1970-01-01T00:00:00.000Z",
        workspace,
      })}\n`,
      "utf8",
    );

    try {
      // When / Then
      expect(() =>
        resumeSessionStore({
          sessionId: "future",
          workspace,
          runtime: runtime(home),
        }),
      ).toThrow(SessionStoreError);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given no new messages were added after the last persisted state,
    When persistence is asked to save again,
    Then the ledger is left unchanged`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const messages: readonly Message[] = [{ role: "user", content: "hello" }];

    try {
      const session = createSessionStore({
        sessionId: "unchanged",
        workspace,
        runtime: runtime(home),
      });
      const persisted = persistSessionMessages({
        session,
        previousMessages: [],
        currentMessages: messages,
        runtime: runtime(home, 1),
        reason: "turn",
      });
      const before = await readFile(session.filePath, "utf8");

      // When
      const afterPersisted = persistSessionMessages({
        session,
        previousMessages: persisted,
        currentMessages: messages,
        runtime: runtime(home, 2),
        reason: "turn",
      });

      // Then
      const after = await readFile(session.filePath, "utf8");
      expect(afterPersisted).toEqual(messages);
      expect(after).toBe(before);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a completed transcript has already been persisted,
    When persistence receives a malformed follow-up transcript,
    Then it rejects the update before appending corrupted history`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const firstTurn: readonly Message[] = [
      { role: "user", content: "start" },
      { role: "assistant", content: "started", toolCalls: [] },
    ];
    const malformedFollowUp: readonly Message[] = [
      ...firstTurn,
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "duplicate", tool: "read", path: "a.txt" },
          { id: "duplicate", tool: "read", path: "b.txt" },
        ],
      },
    ];

    try {
      const session = createSessionStore({
        sessionId: "reject-malformed-persist",
        workspace,
        runtime: runtime(home),
      });
      const persisted = persistSessionMessages({
        session,
        previousMessages: [],
        currentMessages: firstTurn,
        runtime: runtime(home, 1),
        reason: "turn",
      });
      const before = await readFile(session.filePath, "utf8");

      const persistMalformedFollowUp = () =>
        persistSessionMessages({
          session,
          previousMessages: persisted,
          currentMessages: malformedFollowUp,
          runtime: runtime(home, 2),
          reason: "turn",
        });

      // When / Then
      expect(persistMalformedFollowUp).toThrow(SessionStoreError);
      expect(persistMalformedFollowUp).toThrow(
        'Error: cannot persist session "reject-malformed-persist": ledger contains duplicate pending tool call "duplicate".',
      );
      expect(await readFile(session.filePath, "utf8")).toBe(before);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
});
