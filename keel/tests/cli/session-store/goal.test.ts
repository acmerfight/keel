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
import {
  SESSION_GOAL_COMPLETION_CRITERION_MAX_LENGTH,
  SESSION_GOAL_COMPLETION_EVIDENCE_REASON_MAX_LENGTH,
  SESSION_GOAL_OBJECTIVE_MAX_LENGTH,
  SESSION_GOAL_RUNTIME_OUTCOME_REASON_MAX_LENGTH,
  SESSION_GOAL_STATUS_REASON_MAX_LENGTH,
} from "../../../src/core/session-goal.ts";
import type { Message } from "../../../src/llm/types.ts";
import { runtime } from "../../../src/testing/session-store-fixtures.ts";

const REDACTION_EXPANDING_SECRET = " sk-aaaa";
const REDACTION_EXPANDING_SECRET_REPETITIONS = 40;

function redactionExpandingText(maxLength: number): string {
  return `${"x".repeat(
    maxLength -
      REDACTION_EXPANDING_SECRET.length *
        REDACTION_EXPANDING_SECRET_REPETITIONS,
  )}${REDACTION_EXPANDING_SECRET.repeat(
    REDACTION_EXPANDING_SECRET_REPETITIONS,
  )}`;
}

describe("Session Store Goal", () => {
  test(`Given a budgeted session goal is persisted with queued input and usage,
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
        goal: {
          objective: "Fix checkout tests",
          status: "active",
          budget: { turns: 12, tokens: 50_000, activeTimeMs: 600_000 },
          usage: { turns: 3, tokens: 8_200, activeTimeMs: 91_000 },
          criterionKind: "command",
          completionCriterion: " pnpm   test ",
        },
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
        budget: { turns: 12, tokens: 50_000, activeTimeMs: 600_000 },
        usage: { turns: 3, tokens: 8_200, activeTimeMs: 91_000 },
        criterionKind: "command",
        completionCriterion: "pnpm   test",
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
          budget: { turns: 12, tokens: 50_000, activeTimeMs: 600_000 },
          usage: { turns: 3, tokens: 8_200, activeTimeMs: 91_000 },
          criterionKind: "command",
          completionCriterion: "pnpm   test",
        },
        consumedInputIds: [queuedInput.id],
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given an assertion criterion has uneven whitespace,
    When the session goal is persisted,
    Then Keel normalizes it as prose and restores the criterion contract`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));

    try {
      const session = createSessionStore({
        sessionId: "session-goal-assertion",
        workspace,
        runtime: runtime(home),
      });

      // When
      persistSessionGoal({
        session,
        goal: {
          objective: "Publish release notes",
          status: "active",
          budget: {},
          usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
          criterionKind: "assertion",
          completionCriterion: " release   notes\ncover every changed command ",
        },
        runtime: runtime(home, 1),
      });
      const resumed = resumeSessionStore({
        sessionId: "session-goal-assertion",
        workspace,
        runtime: runtime(home, 2),
      });

      // Then
      expect(resumed.goal).toEqual({
        objective: "Publish release notes",
        status: "active",
        budget: {},
        usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
        criterionKind: "assertion",
        completionCriterion: "release notes cover every changed command",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a completed session goal has command completion evidence,
    When the session is resumed,
    Then the durable goal explains why completion was accepted`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));

    try {
      const session = createSessionStore({
        sessionId: "session-goal-completed-evidence",
        workspace,
        runtime: runtime(home),
      });

      // When
      persistSessionGoal({
        session,
        goal: {
          objective: "Fix checkout tests",
          status: "completed",
          budget: {},
          usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
          criterionKind: "command",
          completionCriterion: "pnpm test",
          completionEvidence: {
            kind: "command",
            command: " pnpm test ",
            cwd: workspace,
            exitCode: 0,
            freshness: "after_latest_workspace_mutation",
          },
        },
        runtime: runtime(home, 1),
      });
      const resumed = resumeSessionStore({
        sessionId: "session-goal-completed-evidence",
        workspace,
        runtime: runtime(home, 2),
      });

      // Then
      expect(resumed.goal).toEqual({
        objective: "Fix checkout tests",
        status: "completed",
        budget: {},
        usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
        criterionKind: "command",
        completionCriterion: "pnpm test",
        completionEvidence: {
          kind: "command",
          command: "pnpm test",
          cwd: workspace,
          exitCode: 0,
          freshness: "after_latest_workspace_mutation",
        },
      });
      const ledgerRecords = (await readFile(session.filePath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(ledgerRecords.at(-1)).toEqual({
        schemaVersion: 2,
        type: "session_goal",
        timestamp: "1970-01-01T00:00:00.001Z",
        goal: {
          objective: "Fix checkout tests",
          status: "completed",
          budget: {},
          usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
          criterionKind: "command",
          completionCriterion: "pnpm test",
          completionEvidence: {
            kind: "command",
            command: "pnpm test",
            cwd: workspace,
            exitCode: 0,
            freshness: "after_latest_workspace_mutation",
          },
        },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a completed session goal has assertion evaluator evidence,
    When the session is resumed,
    Then the evaluator reason survives the ledger boundary`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));

    try {
      const session = createSessionStore({
        sessionId: "session-goal-assertion-evidence",
        workspace,
        runtime: runtime(home),
      });

      // When
      persistSessionGoal({
        session,
        goal: {
          objective: "Publish release notes",
          status: "completed",
          budget: {},
          usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
          criterionKind: "assertion",
          completionCriterion: "release notes explain the command",
          completionEvidence: {
            kind: "assertion_evaluator",
            reason: " Evaluator\napproved the RELEASE.md evidence. ",
          },
        },
        runtime: runtime(home, 1),
      });
      const resumed = resumeSessionStore({
        sessionId: "session-goal-assertion-evidence",
        workspace,
        runtime: runtime(home, 2),
      });

      // Then
      expect(resumed.goal).toEqual({
        objective: "Publish release notes",
        status: "completed",
        budget: {},
        usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
        criterionKind: "assertion",
        completionCriterion: "release notes explain the command",
        completionEvidence: {
          kind: "assertion_evaluator",
          reason: "Evaluator approved the RELEASE.md evidence.",
        },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given assertion completion evidence expands during redaction,
    When the completed goal is persisted,
    Then Keel stores bounded redacted evidence instead of rejecting completion`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const reason = redactionExpandingText(
      SESSION_GOAL_COMPLETION_EVIDENCE_REASON_MAX_LENGTH,
    );

    try {
      const session = createSessionStore({
        sessionId: "session-goal-redaction-expansion",
        workspace,
        runtime: runtime(home),
      });

      // When
      persistSessionGoal({
        session,
        goal: {
          objective: "Publish release notes",
          status: "completed",
          budget: {},
          usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
          criterionKind: "assertion",
          completionCriterion: "release notes explain the command",
          completionEvidence: {
            kind: "assertion_evaluator",
            reason,
          },
        },
        runtime: runtime(home, 1),
      });
      const resumed = resumeSessionStore({
        sessionId: "session-goal-redaction-expansion",
        workspace,
        runtime: runtime(home, 2),
      });

      // Then
      if (resumed.goal?.status !== "completed") {
        throw new Error("expected completed goal");
      }
      expect(resumed.goal.completionEvidence.kind).toBe("assertion_evaluator");
      if (resumed.goal.completionEvidence.kind !== "assertion_evaluator") {
        throw new Error("expected assertion evaluator evidence");
      }
      expect(resumed.goal.completionEvidence.reason.length).toBeLessThanOrEqual(
        SESSION_GOAL_COMPLETION_EVIDENCE_REASON_MAX_LENGTH,
      );
      expect(resumed.goal.completionEvidence.reason).toContain(
        "[REDACTED_SECRET]",
      );
      expect(resumed.goal.completionEvidence.reason).not.toContain("sk-aaaa");
      const ledgerRecords = (await readFile(session.filePath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(JSON.stringify(ledgerRecords.at(-1))).not.toContain("sk-aaaa");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a latest runtime outcome expands during persistence redaction,
    When the saved session is resumed,
    Then the bounded redacted outcome survives without leaking the source secret`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const reason = redactionExpandingText(
      SESSION_GOAL_RUNTIME_OUTCOME_REASON_MAX_LENGTH,
    );

    try {
      const session = createSessionStore({
        sessionId: "session-goal-outcome-redaction",
        workspace,
        runtime: runtime(home),
      });

      // When
      persistSessionGoal({
        session,
        goal: {
          objective: "Recover the saved goal",
          status: "active",
          budget: {},
          usage: { turns: 1, tokens: 20, activeTimeMs: 30 },
          criterionKind: "assertion",
          completionCriterion: "The report exists.",
          latestRuntimeOutcome: {
            kind: "completion_rejected",
            reason,
            observedEvidenceFingerprints: [`tools:${"a".repeat(64)}`],
          },
        },
        runtime: runtime(home, 1),
      });
      const resumed = resumeSessionStore({
        sessionId: "session-goal-outcome-redaction",
        workspace,
        runtime: runtime(home, 2),
      });

      // Then
      expect(resumed.goal?.latestRuntimeOutcome).toMatchObject({
        kind: "completion_rejected",
        reason: expect.stringContaining("[REDACTED_SECRET]"),
        observedEvidenceFingerprints: [`tools:${"a".repeat(64)}`],
      });
      expect(
        resumed.goal?.latestRuntimeOutcome?.reason.length,
      ).toBeLessThanOrEqual(SESSION_GOAL_RUNTIME_OUTCOME_REASON_MAX_LENGTH);
      expect(resumed.goal?.latestRuntimeOutcome?.reason).not.toContain(
        "sk-aaaa",
      );
      expect(await readFile(session.filePath, "utf8")).not.toContain("sk-aaaa");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given paused, blocked, and limited session goals are persisted,
    When the session is resumed,
    Then lifecycle state and status reason survive the ledger boundary`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));

    try {
      const session = createSessionStore({
        sessionId: "session-goal-lifecycle",
        workspace,
        runtime: runtime(home),
      });

      // When
      persistSessionGoal({
        session,
        goal: {
          objective: "Finish lifecycle states",
          status: "paused",
          budget: {},
          usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
          criterionKind: "command",
          completionCriterion: "pnpm test",
        },
        runtime: runtime(home, 1),
      });
      persistSessionGoal({
        session,
        goal: {
          objective: "Finish lifecycle states",
          status: "blocked",
          budget: {},
          usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
          statusReason: " Need credentials\nfrom the user. ",
          criterionKind: "command",
          completionCriterion: "pnpm test",
        },
        runtime: runtime(home, 2),
      });
      persistSessionGoal({
        session,
        goal: {
          objective: "Finish lifecycle states",
          status: "usage_limited",
          budget: {},
          usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
          statusReason: " Automatic continuation stopped. ",
          criterionKind: "command",
          completionCriterion: "pnpm test",
        },
        runtime: runtime(home, 3),
      });
      persistSessionGoal({
        session,
        goal: {
          objective: "Finish lifecycle states",
          status: "budget_limited",
          budget: {},
          usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
          statusReason: " Session budget stopped continuation. ",
          criterionKind: "command",
          completionCriterion: "pnpm test",
        },
        runtime: runtime(home, 4),
      });
      const resumed = resumeSessionStore({
        sessionId: "session-goal-lifecycle",
        workspace,
        runtime: runtime(home, 5),
      });

      // Then
      expect(resumed.goal).toEqual({
        objective: "Finish lifecycle states",
        status: "budget_limited",
        budget: {},
        usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
        statusReason: "Session budget stopped continuation.",
        criterionKind: "command",
        completionCriterion: "pnpm test",
      });
      const ledgerRecords = (await readFile(session.filePath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(ledgerRecords.at(-4)).toMatchObject({
        type: "session_goal",
        goal: {
          objective: "Finish lifecycle states",
          status: "paused",
          budget: {},
          usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
          criterionKind: "command",
          completionCriterion: "pnpm test",
        },
      });
      expect(ledgerRecords.at(-3)).toMatchObject({
        type: "session_goal",
        goal: {
          objective: "Finish lifecycle states",
          status: "blocked",
          budget: {},
          usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
          statusReason: "Need credentials from the user.",
          criterionKind: "command",
          completionCriterion: "pnpm test",
        },
      });
      expect(ledgerRecords.at(-2)).toMatchObject({
        type: "session_goal",
        goal: {
          objective: "Finish lifecycle states",
          status: "usage_limited",
          budget: {},
          usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
          statusReason: "Automatic continuation stopped.",
          criterionKind: "command",
          completionCriterion: "pnpm test",
        },
      });
      expect(ledgerRecords.at(-1)).toMatchObject({
        type: "session_goal",
        goal: {
          objective: "Finish lifecycle states",
          status: "budget_limited",
          budget: {},
          usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
          statusReason: "Session budget stopped continuation.",
          criterionKind: "command",
          completionCriterion: "pnpm test",
        },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given an active session goal has a pending blocked audit,
    When the session is resumed,
    Then the blocked audit survives the ledger boundary`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-session-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));

    try {
      const session = createSessionStore({
        sessionId: "session-goal-blocked-audit",
        workspace,
        runtime: runtime(home),
      });

      // When
      persistSessionGoal({
        session,
        goal: {
          objective: "Finish blocked audit",
          status: "active",
          budget: {},
          usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
          criterionKind: "command",
          completionCriterion: "pnpm test",
          blockedAudit: {
            consecutiveCount: 2,
            reason: " Need credentials\nfrom the user. ",
          },
        },
        runtime: runtime(home, 1),
      });
      const resumed = resumeSessionStore({
        sessionId: "session-goal-blocked-audit",
        workspace,
        runtime: runtime(home, 2),
      });

      // Then
      expect(resumed.goal).toEqual({
        objective: "Finish blocked audit",
        status: "active",
        budget: {},
        usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
        criterionKind: "command",
        completionCriterion: "pnpm test",
        blockedAudit: {
          consecutiveCount: 2,
          reason: "Need credentials from the user.",
        },
      });
      const ledgerRecords = (await readFile(session.filePath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(ledgerRecords.at(-1)).toMatchObject({
        type: "session_goal",
        goal: {
          objective: "Finish blocked audit",
          status: "active",
          budget: {},
          usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
          criterionKind: "command",
          completionCriterion: "pnpm test",
          blockedAudit: {
            consecutiveCount: 2,
            reason: "Need credentials from the user.",
          },
        },
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
        goal: {
          objective: "Keep the checkout suite green",
          status: "active",
          budget: {},
          usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
          criterionKind: "command",
          completionCriterion: "pnpm test:coverage",
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
        sessionId: "session-goal-snapshot",
        workspace,
        runtime: runtime(home, 3),
      });

      // Then
      expect(resumed.goal).toEqual({
        objective: "Keep the checkout suite green",
        status: "active",
        budget: {},
        usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
        criterionKind: "command",
        completionCriterion: "pnpm test:coverage",
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
          budget: {},
          usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
          criterionKind: "command",
          completionCriterion: "pnpm test:coverage",
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
        goal: {
          objective: "Remove stale goal",
          status: "active",
          budget: {},
          usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
        },
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
          goal: {
            objective: "   ",
            status: "active",
            budget: {},
            usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
          },
          runtime: runtime(home, 1),
        }),
      ).toThrow("Error: /goal requires non-empty text.");
      expect(() =>
        persistSessionGoal({
          session,
          goal: {
            objective: "x".repeat(SESSION_GOAL_OBJECTIVE_MAX_LENGTH + 1),
            status: "active",
            budget: {},
            usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
          },
          runtime: runtime(home, 2),
        }),
      ).toThrow(
        `Error: /goal objective must be ${SESSION_GOAL_OBJECTIVE_MAX_LENGTH} characters or fewer.`,
      );
      expect(() =>
        persistSessionGoal({
          session,
          goal: {
            objective: "Verify command",
            status: "active",
            budget: {},
            usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
            criterionKind: "command",
            completionCriterion: "   ",
          },
          runtime: runtime(home, 3),
        }),
      ).toThrow("Error: /goal completion criterion requires text.");
      expect(() =>
        persistSessionGoal({
          session,
          goal: {
            objective: "Verify command",
            status: "active",
            budget: {},
            usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
            criterionKind: "assertion",
            completionCriterion: "x".repeat(
              SESSION_GOAL_COMPLETION_CRITERION_MAX_LENGTH + 1,
            ),
          },
          runtime: runtime(home, 4),
        }),
      ).toThrow(
        `Error: /goal completion criterion must be ${SESSION_GOAL_COMPLETION_CRITERION_MAX_LENGTH} characters or fewer.`,
      );
      expect(() =>
        persistSessionGoal({
          session,
          goal: {
            objective: "Blocked command",
            status: "blocked",
            budget: {},
            usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
            statusReason: "   ",
          },
          runtime: runtime(home, 5),
        }),
      ).toThrow("Error: /goal blocked or limited status requires a reason.");
      expect(() =>
        persistSessionGoal({
          session,
          goal: {
            objective: "Blocked command",
            status: "blocked",
            budget: {},
            usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
            statusReason: "x".repeat(SESSION_GOAL_STATUS_REASON_MAX_LENGTH + 1),
          },
          runtime: runtime(home, 6),
        }),
      ).toThrow(
        `Error: /goal blocked or limited reason must be ${SESSION_GOAL_STATUS_REASON_MAX_LENGTH} characters or fewer.`,
      );
      expect(() =>
        persistSessionGoal({
          session,
          goal: {
            objective: "Blocked audit",
            status: "active",
            budget: {},
            usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
            blockedAudit: {
              consecutiveCount: 1,
              reason: "   ",
            },
          },
          runtime: runtime(home, 7),
        }),
      ).toThrow("Error: /goal blocked audit requires a reason.");
      expect(() =>
        persistSessionGoal({
          session,
          goal: {
            objective: "Blocked audit",
            status: "active",
            budget: {},
            usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
            blockedAudit: {
              consecutiveCount: 1,
              reason: "x".repeat(SESSION_GOAL_STATUS_REASON_MAX_LENGTH + 1),
            },
          },
          runtime: runtime(home, 8),
        }),
      ).toThrow(
        `Error: /goal blocked audit reason must be ${SESSION_GOAL_STATUS_REASON_MAX_LENGTH} characters or fewer.`,
      );
      expect(() =>
        persistSessionGoal({
          session,
          goal: {
            objective: "Blank runtime outcome",
            status: "active",
            budget: {},
            usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
            latestRuntimeOutcome: {
              kind: "recovery_requested",
              reason: "   ",
            },
          },
          runtime: runtime(home, 9),
        }),
      ).toThrow("Error: /goal runtime outcome requires a reason.");
      expect(() =>
        persistSessionGoal({
          session,
          goal: {
            objective: "Long runtime outcome",
            status: "active",
            budget: {},
            usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
            latestRuntimeOutcome: {
              kind: "recovery_requested",
              reason: "x".repeat(
                SESSION_GOAL_RUNTIME_OUTCOME_REASON_MAX_LENGTH + 1,
              ),
            },
          },
          runtime: runtime(home, 10),
        }),
      ).toThrow(
        `Error: /goal runtime outcome reason must be ${SESSION_GOAL_RUNTIME_OUTCOME_REASON_MAX_LENGTH} characters or fewer.`,
      );
      expect(() =>
        persistSessionGoal({
          session,
          goal: JSON.parse(
            JSON.stringify({
              objective: "Completed without evidence",
              status: "completed",
              budget: {},
              usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
            }),
          ),
          runtime: runtime(home, 11),
        }),
      ).toThrow("Error: /goal completed status requires evidence.");
      expect(() =>
        persistSessionGoal({
          session,
          goal: JSON.parse(
            JSON.stringify({
              objective: "Completed with blank evidence command",
              status: "completed",
              budget: {},
              usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
              completionEvidence: {
                kind: "command",
                command: "   ",
                cwd: workspace,
                exitCode: 0,
                freshness: "after_latest_workspace_mutation",
              },
            }),
          ),
          runtime: runtime(home, 10),
        }),
      ).toThrow("Error: /goal completion evidence command is empty.");
      expect(() =>
        persistSessionGoal({
          session,
          goal: JSON.parse(
            JSON.stringify({
              objective: "Completed with long evidence command",
              status: "completed",
              budget: {},
              usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
              completionEvidence: {
                kind: "command",
                command: "x".repeat(
                  SESSION_GOAL_COMPLETION_CRITERION_MAX_LENGTH + 1,
                ),
                cwd: workspace,
                exitCode: 0,
                freshness: "after_latest_workspace_mutation",
              },
            }),
          ),
          runtime: runtime(home, 11),
        }),
      ).toThrow(
        `Error: /goal completion evidence command must be ${SESSION_GOAL_COMPLETION_CRITERION_MAX_LENGTH} characters or fewer.`,
      );
      expect(() =>
        persistSessionGoal({
          session,
          goal: JSON.parse(
            JSON.stringify({
              objective: "Completed with blank evidence cwd",
              status: "completed",
              budget: {},
              usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
              completionEvidence: {
                kind: "command",
                command: "pnpm test",
                cwd: "   ",
                exitCode: 0,
                freshness: "after_latest_workspace_mutation",
              },
            }),
          ),
          runtime: runtime(home, 12),
        }),
      ).toThrow("Error: /goal completion evidence cwd is empty.");
      expect(() =>
        persistSessionGoal({
          session,
          goal: JSON.parse(
            JSON.stringify({
              objective: "Completed with long evidence cwd",
              status: "completed",
              budget: {},
              usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
              completionEvidence: {
                kind: "command",
                command: "pnpm test",
                cwd: "x".repeat(SESSION_GOAL_OBJECTIVE_MAX_LENGTH + 1),
                exitCode: 0,
                freshness: "after_latest_workspace_mutation",
              },
            }),
          ),
          runtime: runtime(home, 13),
        }),
      ).toThrow(
        `Error: /goal completion evidence cwd must be ${SESSION_GOAL_OBJECTIVE_MAX_LENGTH} characters or fewer.`,
      );
      expect(() =>
        persistSessionGoal({
          session,
          goal: JSON.parse(
            JSON.stringify({
              objective: "Completed with blank evaluator reason",
              status: "completed",
              budget: {},
              usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
              completionEvidence: {
                kind: "assertion_evaluator",
                reason: "   ",
              },
            }),
          ),
          runtime: runtime(home, 14),
        }),
      ).toThrow("Error: /goal completion evidence reason is empty.");
      expect(() =>
        persistSessionGoal({
          session,
          goal: JSON.parse(
            JSON.stringify({
              objective: "Completed with long evaluator reason",
              status: "completed",
              budget: {},
              usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
              completionEvidence: {
                kind: "assertion_evaluator",
                reason: "x".repeat(
                  SESSION_GOAL_COMPLETION_EVIDENCE_REASON_MAX_LENGTH + 1,
                ),
              },
            }),
          ),
          runtime: runtime(home, 15),
        }),
      ).toThrow(
        `Error: /goal completion evidence reason must be ${SESSION_GOAL_COMPLETION_EVIDENCE_REASON_MAX_LENGTH} characters or fewer.`,
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
