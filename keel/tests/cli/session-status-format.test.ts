import { describe, expect, test } from "vitest";
import { formatSessionStatusSnapshot } from "../../src/cli/session-status-format.ts";

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
      modelSwitchCount: 0,
      undoCheckpoints: [],
      recoveryActions: [],
    });

    // Then
    expect(formatted).toContain("status:\n");
    expect(formatted).not.toContain("recovery:\n");
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
});
