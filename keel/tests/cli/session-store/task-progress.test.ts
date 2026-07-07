import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createSessionStore,
  forkSessionStore,
  persistSessionMessages,
  persistSessionTaskProgress,
  resumeSessionStore,
} from "../../../src/cli/session-store.ts";
import type { Message } from "../../../src/llm/types.ts";
import {
  restoredUserMessageId,
  runtime,
} from "../../../src/testing/session-store-fixtures.ts";

describe("Session Store Task Progress", () => {
  test(`Given task progress is persisted in a named session,
    When the session is resumed,
    Then the current task progress is restored from the ledger`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));

    try {
      const session = createSessionStore({
        sessionId: "task-progress",
        workspace,
        runtime: runtime(home),
      });

      // When
      persistSessionTaskProgress({
        session,
        taskProgress: {
          tasks: [
            { step: "Inspect the failure", status: "completed" },
            { step: "Patch the bug", status: "in_progress" },
          ],
        },
        runtime: runtime(home, 1),
      });
      const resumed = resumeSessionStore({
        sessionId: "task-progress",
        workspace,
        runtime: runtime(home, 2),
      });

      // Then
      expect(resumed.taskProgress).toEqual({
        tasks: [
          { step: "Inspect the failure", status: "completed" },
          { step: "Patch the bug", status: "in_progress" },
        ],
      });
      const ledgerRecords = (await readFile(session.filePath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(ledgerRecords.at(-1)).toEqual({
        schemaVersion: 2,
        type: "task_progress",
        timestamp: "1970-01-01T00:00:00.001Z",
        messageOrdinal: 0,
        tasks: [
          { step: "Inspect the failure", status: "completed" },
          { step: "Patch the bug", status: "in_progress" },
        ],
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given task progress exists when a bounded snapshot is written,
    When the session is resumed from the snapshot,
    Then the task progress survives the snapshot boundary`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const largeMessages: readonly Message[] = [
      { role: "user", content: "x".repeat(16 * 1024 * 1024) },
    ];

    try {
      const session = createSessionStore({
        sessionId: "task-progress-snapshot",
        workspace,
        runtime: runtime(home),
      });
      persistSessionTaskProgress({
        session,
        taskProgress: {
          tasks: [{ step: "Patch the bug", status: "in_progress" }],
        },
        runtime: runtime(home, 1),
      });

      // When
      persistSessionMessages({
        session,
        previousMessages: [],
        currentMessages: largeMessages,
        reason: "turn",
        runtime: runtime(home, 2),
      });
      const resumed = resumeSessionStore({
        sessionId: "task-progress-snapshot",
        workspace,
        runtime: runtime(home, 3),
      });

      // Then
      expect(resumed.taskProgress).toEqual({
        tasks: [{ step: "Patch the bug", status: "in_progress" }],
      });
      const ledgerRecords = (await readFile(session.filePath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(ledgerRecords.at(-1)).toMatchObject({
        type: "snapshot",
        taskProgressCheckpoints: [
          {
            messageOrdinal: 0,
            taskProgress: {
              tasks: [{ step: "Patch the bug", status: "in_progress" }],
            },
          },
        ],
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given unchanged task progress is persisted twice,
    When the second write repeats the same deterministic state,
    Then the session ledger does not append a duplicate checkpoint`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const taskProgress = {
      tasks: [{ step: "Patch the bug", status: "in_progress" as const }],
    };

    try {
      const session = createSessionStore({
        sessionId: "task-progress-dedupe",
        workspace,
        runtime: runtime(home),
      });

      // When
      persistSessionTaskProgress({
        session,
        taskProgress,
        runtime: runtime(home, 1),
      });
      persistSessionTaskProgress({
        session,
        taskProgress,
        runtime: runtime(home, 2),
      });

      // Then
      const ledgerRecords = (await readFile(session.filePath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(
        ledgerRecords.filter((record) => record.type === "task_progress"),
      ).toHaveLength(1);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given task progress exists when session history is replaced,
    When the session is resumed and forked before the replacement history,
    Then task progress is rebased to the new transcript boundary`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const originalMessages: readonly Message[] = [
      { role: "user", content: "remember alpha" },
      {
        role: "assistant",
        content: "Remembered: remember alpha",
        toolCalls: [],
      },
    ];
    const replacedMessages: readonly Message[] = [
      { role: "user", content: "remember beta" },
      {
        role: "assistant",
        content: "Remembered: remember beta",
        toolCalls: [],
      },
    ];

    try {
      const session = createSessionStore({
        sessionId: "task-progress-replace",
        workspace,
        runtime: runtime(home),
      });
      const persistedOriginal = persistSessionMessages({
        session,
        previousMessages: [],
        currentMessages: originalMessages,
        reason: "turn",
        runtime: runtime(home, 1),
      });
      persistSessionTaskProgress({
        session,
        taskProgress: {
          tasks: [{ step: "Patch the bug", status: "in_progress" }],
        },
        runtime: runtime(home, 2),
      });

      // When
      persistSessionMessages({
        session,
        previousMessages: persistedOriginal,
        currentMessages: replacedMessages,
        reason: "compaction",
        runtime: runtime(home, 3),
      });
      const resumed = resumeSessionStore({
        sessionId: "task-progress-replace",
        workspace,
        runtime: runtime(home, 4),
      });
      const betaMessageId = restoredUserMessageId(resumed, "remember beta");
      const forked = forkSessionStore({
        source: resumed,
        targetSessionId: "task-progress-replace-target",
        forkPoint: {
          beforeMessageId: betaMessageId,
          optionName: "--before-message",
        },
        runtime: runtime(home, 5),
      });

      // Then
      expect(resumed.taskProgress).toEqual({
        tasks: [{ step: "Patch the bug", status: "in_progress" }],
      });
      expect(forked.messages).toEqual([]);
      expect(forked.taskProgress).toEqual({
        tasks: [{ step: "Patch the bug", status: "in_progress" }],
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given task progress changes across session turns,
    When the session is forked before a later turn,
    Then the fork restores the task progress that existed at that fork point`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const firstTurn: readonly Message[] = [
      { role: "user", content: "remember alpha" },
      {
        role: "assistant",
        content: "Remembered: remember alpha",
        toolCalls: [],
      },
    ];
    const allMessages: readonly Message[] = [
      ...firstTurn,
      { role: "user", content: "remember beta" },
      {
        role: "assistant",
        content: "Remembered: remember beta",
        toolCalls: [],
      },
    ];

    try {
      const source = createSessionStore({
        sessionId: "task-progress-fork-source",
        workspace,
        runtime: runtime(home),
      });
      const persistedFirstTurn = persistSessionMessages({
        session: source,
        previousMessages: [],
        currentMessages: firstTurn,
        reason: "turn",
        runtime: runtime(home, 1),
      });
      persistSessionTaskProgress({
        session: source,
        taskProgress: {
          tasks: [{ step: "Inspect alpha", status: "completed" }],
        },
        runtime: runtime(home, 2),
      });
      persistSessionMessages({
        session: source,
        previousMessages: persistedFirstTurn,
        currentMessages: allMessages,
        reason: "turn",
        runtime: runtime(home, 3),
      });
      persistSessionTaskProgress({
        session: source,
        taskProgress: {
          tasks: [
            { step: "Inspect alpha", status: "completed" },
            { step: "Inspect beta", status: "in_progress" },
          ],
        },
        runtime: runtime(home, 4),
      });
      const restoredSource = resumeSessionStore({
        sessionId: "task-progress-fork-source",
        workspace,
        runtime: runtime(home, 5),
      });
      const betaMessageId = restoredUserMessageId(
        restoredSource,
        "remember beta",
      );

      // When
      const target = forkSessionStore({
        source: restoredSource,
        targetSessionId: "task-progress-fork-target",
        forkPoint: {
          beforeMessageId: betaMessageId,
          optionName: "--before-message",
        },
        runtime: runtime(home, 6),
      });
      const resumedTarget = resumeSessionStore({
        sessionId: "task-progress-fork-target",
        workspace,
        runtime: runtime(home, 7),
      });

      // Then
      expect(target.taskProgress).toEqual({
        tasks: [{ step: "Inspect alpha", status: "completed" }],
      });
      expect(resumedTarget.taskProgress).toEqual({
        tasks: [{ step: "Inspect alpha", status: "completed" }],
      });
      expect(resumedTarget.messages).toEqual(firstTurn);
      const targetLedgerRecords = (await readFile(target.filePath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(targetLedgerRecords).toContainEqual({
        schemaVersion: 2,
        type: "task_progress",
        timestamp: "1970-01-01T00:00:00.006Z",
        messageOrdinal: 0,
        tasks: [{ step: "Inspect alpha", status: "completed" }],
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
});
