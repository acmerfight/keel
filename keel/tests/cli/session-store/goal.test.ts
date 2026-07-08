import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createSessionStore,
  persistSessionGoal,
  persistSessionMessages,
  persistSessionQueuedInput,
  resumeSessionStore,
} from "../../../src/cli/session-store.ts";
import { SESSION_GOAL_OBJECTIVE_MAX_LENGTH } from "../../../src/core/session-goal.ts";
import type { Message } from "../../../src/llm/types.ts";
import { runtime } from "../../../src/testing/session-store-fixtures.ts";

describe("Session Store Goal", () => {
  test(`Given a session goal is persisted with queued input,
    When the session is resumed,
    Then the goal is restored and the command input is consumed`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));

    try {
      const session = createSessionStore({
        sessionId: "session-goal",
        workspace,
        runtime: runtime(home),
      });
      const queuedInput = persistSessionQueuedInput({
        session,
        sequence: 1,
        line: "/goal Fix checkout tests",
        runtime: runtime(home, 1),
      });

      // When
      persistSessionGoal({
        session,
        goal: { objective: "Fix checkout tests", status: "active" },
        consumedInputIds: [queuedInput.id],
        runtime: runtime(home, 2),
      });
      const resumed = resumeSessionStore({
        sessionId: "session-goal",
        workspace,
        runtime: runtime(home, 3),
      });

      // Then
      expect(resumed.goal).toEqual({
        objective: "Fix checkout tests",
        status: "active",
      });
      expect(resumed.pendingInputs).toEqual([]);
      const ledgerRecords = (await readFile(session.filePath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(ledgerRecords.at(-1)).toEqual({
        schemaVersion: 2,
        type: "session_goal",
        timestamp: "1970-01-01T00:00:00.002Z",
        goal: {
          objective: "Fix checkout tests",
          status: "active",
        },
        consumedInputIds: [queuedInput.id],
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a session goal exists when a bounded snapshot is written,
    When the session is resumed from the snapshot,
    Then the goal survives the snapshot boundary`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const largeMessages: readonly Message[] = [
      { role: "user", content: "x".repeat(16 * 1024 * 1024) },
    ];

    try {
      const session = createSessionStore({
        sessionId: "session-goal-snapshot",
        workspace,
        runtime: runtime(home),
      });
      persistSessionGoal({
        session,
        goal: { objective: "Keep the checkout suite green", status: "active" },
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
        sessionId: "session-goal-snapshot",
        workspace,
        runtime: runtime(home, 3),
      });

      // Then
      expect(resumed.goal).toEqual({
        objective: "Keep the checkout suite green",
        status: "active",
      });
      const ledgerRecords = (await readFile(session.filePath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(ledgerRecords.at(-1)).toMatchObject({
        type: "snapshot",
        goal: {
          objective: "Keep the checkout suite green",
          status: "active",
        },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a session goal is cleared,
    When the session is resumed,
    Then no durable goal remains`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));

    try {
      const session = createSessionStore({
        sessionId: "session-goal-clear",
        workspace,
        runtime: runtime(home),
      });
      persistSessionGoal({
        session,
        goal: { objective: "Remove stale goal", status: "active" },
        runtime: runtime(home, 1),
      });

      // When
      const clearedGoal = persistSessionGoal({
        session,
        goal: null,
        runtime: runtime(home, 2),
      });
      const resumed = resumeSessionStore({
        sessionId: "session-goal-clear",
        workspace,
        runtime: runtime(home, 3),
      });

      // Then
      expect(clearedGoal).toBeUndefined();
      expect(resumed.goal).toBeUndefined();
      const ledgerRecords = (await readFile(session.filePath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(ledgerRecords.at(-1)).toMatchObject({
        type: "session_goal",
        goal: null,
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given an invalid goal objective is persisted directly,
    When the store validates it,
    Then the write fails before appending a goal record`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));

    try {
      const session = createSessionStore({
        sessionId: "session-goal-invalid",
        workspace,
        runtime: runtime(home),
      });

      // When / Then
      expect(() =>
        persistSessionGoal({
          session,
          goal: { objective: "   ", status: "active" },
          runtime: runtime(home, 1),
        }),
      ).toThrow("Error: /goal requires non-empty text.");
      expect(() =>
        persistSessionGoal({
          session,
          goal: {
            objective: "x".repeat(SESSION_GOAL_OBJECTIVE_MAX_LENGTH + 1),
            status: "active",
          },
          runtime: runtime(home, 2),
        }),
      ).toThrow(
        `Error: /goal objective must be ${SESSION_GOAL_OBJECTIVE_MAX_LENGTH} characters or fewer.`,
      );
      const ledgerRecords = (await readFile(session.filePath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(ledgerRecords).toHaveLength(1);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
});
