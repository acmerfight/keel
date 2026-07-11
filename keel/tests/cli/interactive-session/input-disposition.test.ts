import { describe, expect, test } from "vitest";
import { createInteractiveInputDispositionTracker } from "../../../src/cli/interactive-session/input-disposition.ts";

describe("Interactive input disposition", () => {
  test(`Given a turn moves through ready, steering, approval, and queued work,
    When messages cross a real command barrier and the turn resets,
    Then every admission receives the same disposition as the session runtime`, () => {
    // Given
    const tracker = createInteractiveInputDispositionTracker();

    // Then: ready input
    expect(tracker.dispositionFor("start")).toBe("keel");

    // When / Then: active-turn steering and authoritative command parsing
    tracker.setComposerMode("steer");
    expect(tracker.dispositionFor("/tmp/output is relevant")).toBe(
      "steer/next",
    );
    expect(tracker.dispositionFor("guide this turn")).toBe("steer/next");
    expect(tracker.dispositionFor("/status")).toBe("queue");
    expect(tracker.dispositionFor("after the command barrier")).toBe("queue");

    // When / Then: approval temporarily overrides, then preserves the barrier
    tracker.setComposerMode("approval");
    expect(tracker.dispositionFor("")).toBe("approve");
    tracker.setComposerMode("steer");
    expect(tracker.dispositionFor("after approval")).toBe("queue");

    // When / Then: a completed turn resets the barrier; operations still queue
    tracker.setComposerMode("ready");
    tracker.setComposerMode("steer");
    expect(tracker.dispositionFor("next turn guidance")).toBe("steer/next");
    tracker.setComposerMode("queue");
    expect(tracker.dispositionFor("after compaction")).toBe("queue");
  });
});
