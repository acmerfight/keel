import { describe, expect, test } from "vitest";
import {
  formatSessionStatusSnapshot,
  formatSessionTasks,
} from "../../src/cli/session-status-format.ts";
import { emptySessionTaskProgress } from "../../src/core/task-progress.ts";

describe("CLI Session Status Format", () => {
  test(`Given no recovery actions are available,
    When the status snapshot is formatted,
    Then no recovery section is printed`, () => {
    // Given / When
    const formatted = formatSessionStatusSnapshot({
      session: "scratch",
      workspace: "/tmp/workspace",
      activeModel: "(default for next prompt)",
      messages: [],
      messageCount: 0,
      pendingInputCount: 0,
      bashApprovalCount: 0,
      taskProgress: emptySessionTaskProgress(),
      modelSwitchCount: 0,
      undoCheckpoints: [],
      undoProtection: {
        status: "available",
        checkpointsWritten: 1,
        failures: [],
        latestCheckpoint: { written: true },
      },
      recoveryActions: [],
    });

    // Then
    expect(formatted).toContain("status:\n");
    expect(formatted).toContain(
      "  continue: send follow-ups or corrections here until the task is done\n",
    );
    expect(formatted).not.toContain("recovery:\n");
    expect(formatted).toContain(
      "  undo protection: available overall (latest: available; 0 failed, 1 written)\n",
    );
  });

  test(`Given a session goal is present,
    When the status snapshot is formatted,
    Then the goal status and objective are visible`, () => {
    // Given / When
    const formatted = formatSessionStatusSnapshot({
      session: "scratch",
      workspace: "/tmp/workspace",
      activeModel: "(default for next prompt)",
      goal: {
        objective: "Ship the release notes",
        status: "completed",
        budget: {},
        usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
        completionEvidence: { kind: "user_override" },
        latestRuntimeOutcome: {
          kind: "completed",
          reason: "The user explicitly completed the goal.",
        },
      },
      messages: [],
      messageCount: 0,
      pendingInputCount: 0,
      bashApprovalCount: 0,
      taskProgress: emptySessionTaskProgress(),
      modelSwitchCount: 0,
      undoCheckpoints: [],
      recoveryActions: [],
    });

    // Then
    expect(formatted).toContain(
      "  goal: completed - Ship the release notes; criterion: missing\n",
    );
    expect(formatted).toContain(
      "  goal outcome: completed - The user explicitly completed the goal.\n",
    );
    expect(formatted).toContain(
      "  goal evidence: user explicitly completed the goal with /goal complete\n",
    );
  });

  test(`Given a completed session goal has a long objective,
    When the status snapshot is formatted,
    Then completion evidence remains visible on its own line`, () => {
    // Given
    const longObjective =
      "Document the post-release verification evidence so a reviewer can audit exactly why completion happened after recovery ".repeat(
        4,
      );

    // When
    const formatted = formatSessionStatusSnapshot({
      session: "scratch",
      workspace: "/tmp/workspace",
      activeModel: "(default for next prompt)",
      goal: {
        objective: longObjective,
        status: "completed",
        budget: {},
        usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
        completionEvidence: { kind: "user_override" },
      },
      messages: [],
      messageCount: 0,
      pendingInputCount: 0,
      bashApprovalCount: 0,
      taskProgress: emptySessionTaskProgress(),
      modelSwitchCount: 0,
      undoCheckpoints: [],
      recoveryActions: [],
    });

    // Then
    expect(formatted).toContain("  goal: completed - Document");
    expect(formatted).toContain("...\n  goal evidence: user explicitly");
    expect(formatted).toContain(
      "  goal evidence: user explicitly completed the goal with /goal complete\n",
    );
  });

  test(`Given a recovery command is long and contains terminal controls,
    When the status snapshot is formatted,
    Then the command is escaped without truncation`, () => {
    // Given
    const longCommand = `keel --resume long-${"a".repeat(260)}\u001b\u202e`;

    // When
    const formatted = formatSessionStatusSnapshot({
      session: "scratch",
      workspace: "/tmp/workspace",
      activeModel: "(default for next prompt)",
      messages: [],
      messageCount: 0,
      pendingInputCount: 0,
      bashApprovalCount: 0,
      taskProgress: emptySessionTaskProgress(),
      modelSwitchCount: 0,
      undoCheckpoints: [{ restoredLabel: "note.txt" }],
      recoveryActions: [{ label: "resume", command: longCommand }],
    });

    // Then
    expect(formatted).toContain(
      `  resume: keel --resume long-${"a".repeat(260)}`,
    );
    expect(formatted).toContain("\\x1b\\u{202e}");
    expect(formatted).not.toContain("...");
  });

  test(`Given project memory is disabled, failed, or available without entries,
    When the status snapshot is formatted,
    Then each exact memory state is rendered without fallback data`, () => {
    // Given
    const base = {
      session: "scratch",
      workspace: "/tmp/workspace",
      activeModel: "(default for next prompt)",
      messages: [],
      messageCount: 0,
      pendingInputCount: 0,
      bashApprovalCount: 0,
      taskProgress: emptySessionTaskProgress(),
      modelSwitchCount: 0,
      undoCheckpoints: [],
      recoveryActions: [],
    };

    // When
    const disabled = formatSessionStatusSnapshot({
      ...base,
      memory: {
        status: "disabled",
        scope: null,
        loadedIds: [],
        loadedEntries: [],
        renderedBytes: 0,
        estimatedTokens: 0,
        operations: [],
      },
    });
    const failed = formatSessionStatusSnapshot({
      ...base,
      memory: {
        status: "error",
        scope: null,
        loadedIds: [],
        loadedEntries: [],
        renderedBytes: 0,
        estimatedTokens: 0,
        operations: [],
        error: "Error: invalid memory\nignored detail",
      },
    });
    const available = formatSessionStatusSnapshot({
      ...base,
      memory: {
        status: "available",
        scope: { kind: "project", id: "project_status" },
        loadedIds: [],
        loadedEntries: [],
        renderedBytes: 0,
        estimatedTokens: 0,
        operations: [],
      },
    });

    // Then
    expect(disabled).toContain("  memory: disabled (--no-memory)\n");
    expect(failed).toContain(
      "  memory: error - Error: invalid memory ignored detail\n",
    );
    expect(available).toContain(
      "  memory: 0 loaded for project project_status; IDs: none; lifecycle: none (0 bytes, ~0 tokens)\n",
    );
  });

  test(`Given no visible session tasks exist,
    When the task list is formatted,
    Then the user sees an explicit empty state`, () => {
    expect(formatSessionTasks(emptySessionTaskProgress())).toBe(
      "No session tasks.\n",
    );
  });
});
