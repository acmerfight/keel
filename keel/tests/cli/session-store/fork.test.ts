import {
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
import type { SessionMessage } from "../../../src/agent/session-message.ts";
import {
  createSessionStore,
  forkSessionStore,
  persistSessionMessages,
  persistSessionModelSwitch,
  resumeSessionStore,
} from "../../../src/cli/session-store.ts";
import {
  appendLine,
  headerLine,
  restoredUserMessageId,
  runtime,
  snapshotLine,
  storedMessages,
} from "../../../src/testing/session-store-fixtures.ts";

describe("Session Store Fork", () => {
  test(`Given a source session switches models between completed prompts,
    When it is forked before the later prompt,
    Then the fork resumes with the model that was active at that fork point`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const firstTurn: readonly SessionMessage[] = [
      {
        role: "user",
        content: "remember alpha",
        origin: { type: "user_prompt" },
      },
      {
        role: "assistant",
        content: "Remembered: remember alpha",
        toolCalls: [],
      },
    ];
    const allMessages: readonly SessionMessage[] = [
      ...firstTurn,
      {
        role: "user",
        content: "remember beta",
        origin: { type: "user_prompt" },
      },
      {
        role: "assistant",
        content: "Remembered: remember beta",
        toolCalls: [],
      },
    ];

    try {
      const source = createSessionStore({
        sessionId: "source-with-model-switch",
        workspace,
        runtime: runtime(home),
      });
      const persistedFirstTurn = persistSessionMessages({
        session: source,
        previousMessages: [],
        currentMessages: firstTurn,
        reason: "turn",
        consumedInputIds: [],
        runtime: runtime(home, 1),
      });
      persistSessionModelSwitch({
        session: source,
        from: { providerId: "fake", model: "fake" },
        to: { providerId: "qwen", model: "qwen3.7-plus" },
        consumedInputIds: [],
        runtime: runtime(home, 2),
      });
      persistSessionMessages({
        session: source,
        previousMessages: persistedFirstTurn,
        currentMessages: allMessages,
        reason: "turn",
        consumedInputIds: [],
        runtime: runtime(home, 3),
      });
      const restoredSource = resumeSessionStore({
        sessionId: "source-with-model-switch",
        workspace,
        runtime: runtime(home, 4),
      });
      const betaMessageId = restoredUserMessageId(
        restoredSource,
        "remember beta",
      );

      // When
      const target = forkSessionStore({
        source: restoredSource,
        targetSessionId: "target-after-model-switch",
        forkPoint: {
          beforeMessageId: betaMessageId,
          optionName: "--before-message",
        },
        runtime: runtime(home, 5),
      });
      const resumedTarget = resumeSessionStore({
        sessionId: "target-after-model-switch",
        workspace,
        runtime: runtime(home, 6),
      });

      // Then
      expect(target.activeModel).toEqual({
        providerId: "qwen",
        model: "qwen3.7-plus",
      });
      expect(resumedTarget.activeModel).toEqual({
        providerId: "qwen",
        model: "qwen3.7-plus",
      });
      expect(resumedTarget.messages).toEqual(firstTurn);
      const targetLedgerLines = (await readFile(target.filePath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(targetLedgerLines).toContainEqual({
        schemaVersion: 11,
        type: "model_switch",
        timestamp: "1970-01-01T00:00:00.005Z",
        from: null,
        to: { providerId: "qwen", model: "qwen3.7-plus" },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a source session switches models after the first prompt,
    When it is forked before the first restored user message,
    Then the fork does not inherit the later model switch`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const sourceMessages: readonly SessionMessage[] = [
      {
        role: "user",
        content: "remember alpha",
        origin: { type: "user_prompt" },
      },
      {
        role: "assistant",
        content: "Remembered: remember alpha",
        toolCalls: [],
      },
    ];

    try {
      const source = createSessionStore({
        sessionId: "source-before-later-switch",
        workspace,
        runtime: runtime(home),
      });
      const persistedMessages = persistSessionMessages({
        session: source,
        previousMessages: [],
        currentMessages: sourceMessages,
        reason: "turn",
        consumedInputIds: [],
        runtime: runtime(home, 1),
      });
      persistSessionModelSwitch({
        session: source,
        from: { providerId: "fake", model: "fake" },
        to: { providerId: "qwen", model: "qwen3.7-plus" },
        consumedInputIds: [],
        runtime: runtime(home, 2),
      });
      expect(persistedMessages).toEqual(sourceMessages);
      const restoredSource = resumeSessionStore({
        sessionId: "source-before-later-switch",
        workspace,
        runtime: runtime(home, 3),
      });
      const alphaMessageId = restoredUserMessageId(
        restoredSource,
        "remember alpha",
      );

      // When
      const target = forkSessionStore({
        source: restoredSource,
        targetSessionId: "target-before-later-switch",
        forkPoint: {
          beforeMessageId: alphaMessageId,
          optionName: "--before-message",
        },
        runtime: runtime(home, 4),
      });
      const resumedTarget = resumeSessionStore({
        sessionId: "target-before-later-switch",
        workspace,
        runtime: runtime(home, 5),
      });

      // Then
      expect(restoredSource.activeModel).toEqual({
        providerId: "qwen",
        model: "qwen3.7-plus",
      });
      expect(target.activeModel).toBeUndefined();
      expect(resumedTarget.activeModel).toBeUndefined();
      expect(resumedTarget.messages).toEqual([]);
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
    const snapshottedMessages: readonly SessionMessage[] = [
      {
        role: "user",
        content: "x".repeat(contentLength),
        origin: { type: "user_prompt" },
      },
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
        messages: storedMessages(snapshottedMessages),
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
          schemaVersion: 11,
          type: "session",
          id: "empty-target",
          createdAt: "1970-01-01T00:00:00.001Z",
          workspace: source.workspace,
          graph: {
            graphId: "empty-source",
            rootSessionId: "empty-source",
            parentSessionId: "empty-source",
            branchTitle: "empty-target",
            forkPoint: {
              kind: "end",
              sourceSessionId: "empty-source",
              sourceLastMessageId: null,
              sourceOrdinal: 0,
              preview: "full restored history",
            },
            forkPolicy: {
              transcript: "copy_prefix",
              pendingInputs: "drop",
              queuedInputs: "drop",
            },
          },
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
    const sourceMessages: readonly SessionMessage[] = [
      {
        role: "user",
        content: "remember alpha",
        origin: { type: "user_prompt" },
      },
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
      const forkMessageId = restoredUserMessageId(
        restoredSource,
        "remember alpha",
      );

      // When
      const target = forkSessionStore({
        source: restoredSource,
        targetSessionId: "target",
        forkPoint: {
          beforeMessageId: forkMessageId,
          optionName: "--fork-before-message",
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
          schemaVersion: 11,
          type: "session",
          id: "target",
          createdAt: "1970-01-01T00:00:00.003Z",
          workspace: source.workspace,
          graph: {
            graphId: "source",
            rootSessionId: "source",
            parentSessionId: "source",
            branchTitle: "target",
            forkPoint: {
              kind: "before_message",
              sourceSessionId: "source",
              sourceMessageId: forkMessageId,
              sourceOrdinal: 1,
              preview: "remember alpha",
            },
            forkPolicy: {
              transcript: "copy_prefix",
              pendingInputs: "drop",
              queuedInputs: "drop",
            },
          },
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
    const retainedMessages: readonly SessionMessage[] = [
      {
        role: "user",
        content: "inspect workspace",
        origin: { type: "user_prompt" },
      },
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
    const sourceMessages: readonly SessionMessage[] = [
      ...retainedMessages,
      {
        role: "user",
        content: "now remember beta",
        origin: { type: "user_prompt" },
      },
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
      const forkMessageId = restoredUserMessageId(
        restoredSource,
        "now remember beta",
      );

      // When
      const target = forkSessionStore({
        source: restoredSource,
        targetSessionId: "target",
        forkPoint: {
          beforeMessageId: forkMessageId,
          optionName: "--fork-before-message",
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
        messages: restoredSource.storedMessages.slice(
          0,
          retainedMessages.length,
        ),
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a source session has stable stored message ids,
    When it is forked before a restored message id,
    Then the target ledger records graph provenance and copies only the stored prefix`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const retainedMessages: readonly SessionMessage[] = [
      {
        role: "user",
        content: "remember alpha",
        origin: { type: "user_prompt" },
      },
      {
        role: "assistant",
        content: "Remembered: remember alpha",
        toolCalls: [],
      },
    ];
    const sourceMessages: readonly SessionMessage[] = [
      ...retainedMessages,
      {
        role: "user",
        content: "now remember beta",
        origin: { type: "user_prompt" },
      },
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
      const forkMessage = restoredSource.storedMessages.find(
        (storedMessage) =>
          storedMessage.message.role === "user" &&
          storedMessage.message.content === "now remember beta",
      );
      if (forkMessage === undefined) {
        throw new Error(
          "expected restored source to expose the beta message id",
        );
      }

      // When
      const target = forkSessionStore({
        source: restoredSource,
        targetSessionId: "target",
        forkPoint: {
          beforeMessageId: forkMessage.id,
          optionName: "--before-message",
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
      expect(targetLedgerLines[0]).toEqual({
        schemaVersion: 11,
        type: "session",
        id: "target",
        createdAt: "1970-01-01T00:00:00.003Z",
        workspace: source.workspace,
        graph: {
          graphId: "source",
          rootSessionId: "source",
          parentSessionId: "source",
          branchTitle: "target",
          forkPoint: {
            kind: "before_message",
            sourceSessionId: "source",
            sourceMessageId: forkMessage.id,
            sourceOrdinal: 3,
            preview: "now remember beta",
          },
          forkPolicy: {
            transcript: "copy_prefix",
            pendingInputs: "drop",
            queuedInputs: "drop",
          },
        },
      });
      expect(targetLedgerLines[1]).toEqual({
        schemaVersion: 11,
        type: "append",
        timestamp: "1970-01-01T00:00:00.003Z",
        reason: "turn",
        messages: restoredSource.storedMessages.slice(0, 2),
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
});
