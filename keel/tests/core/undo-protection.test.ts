import { describe, expect, test } from "vitest";
import { createUndoProtectionTracker } from "../../src/core/undo-protection.ts";

describe("Undo Protection", () => {
  test(`Given a no-change checkpoint is followed by a successful checkpoint,
    When protection is summarized,
    Then only the effective checkpoint is counted and reported as latest`, () => {
    // Given
    const tracker = createUndoProtectionTracker();
    tracker.record({ written: false, reason: "no_changes" });

    // When
    tracker.record({ written: true });

    // Then
    expect(tracker.summary()).toEqual({
      status: "available",
      checkpointsWritten: 1,
      failures: [],
      latestCheckpoint: { written: true },
    });
  });

  test(`Given repeated checkpoint failures are followed by a successful checkpoint,
    When protection is summarized,
    Then the gap remains unavailable overall while the latest task is available`, () => {
    // Given
    const tracker = createUndoProtectionTracker();
    tracker.record({ written: false, reason: "checkpoint_write_failed" });
    tracker.record({ written: false, reason: "checkpoint_write_failed" });

    // When
    tracker.record({ written: true });

    // Then
    expect(tracker.summary()).toEqual({
      status: "unavailable",
      checkpointsWritten: 1,
      failures: [{ reason: "checkpoint_write_failed", count: 2 }],
      latestCheckpoint: { written: true },
    });
  });
});
