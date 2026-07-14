import { describe, expect, test } from "vitest";
import { createAgentEventReportRecorder } from "../../../src/cli/report-events.ts";

describe("CLI Run Report Recorder", () => {
  test(`Given no Task owns an Agent Run,
    When the recorder starts or completes that Run,
    Then it rejects the invalid lifecycle transition`, () => {
    // Given
    const recorder = createAgentEventReportRecorder();

    // When / Then
    expect(() => recorder.beginAgentRun("user_prompt")).toThrow(
      "internal: report Agent Run requires an active Task",
    );
    expect(() => recorder.completeAgentRun(1, "completed")).toThrow(
      "internal: report Agent Run requires an active Task",
    );
  });

  test(`Given a Task has no active Agent Run,
    When the recorder completes a Run or the empty Task,
    Then it rejects the incomplete lifecycle`, () => {
    // Given
    const recorder = createAgentEventReportRecorder();
    recorder.beginTask("user_prompt");

    // When / Then
    expect(() => recorder.completeAgentRun(1, "completed")).toThrow(
      "internal: no report Agent Run is active",
    );
    expect(() => recorder.endTask()).toThrow(
      "internal: report Task requires an Agent Run",
    );
  });

  test(`Given a Task and Agent Run are active,
    When the recorder overlaps or prematurely ends their owners,
    Then it rejects the conflicting lifecycle`, () => {
    // Given
    const recorder = createAgentEventReportRecorder();
    recorder.beginTask("user_prompt");
    recorder.beginAgentRun("user_prompt");

    // When / Then
    expect(() => recorder.beginTask("user_prompt")).toThrow(
      "internal: report Task already active",
    );
    expect(() => recorder.beginAgentRun("goal_continuation")).toThrow(
      "internal: report Agent Run already active",
    );
    expect(() => recorder.endTask()).toThrow(
      "internal: cannot end Task with an active Agent Run",
    );
  });

  test(`Given no Task is active,
    When the recorder receives a Task end,
    Then it rejects the orphan terminal event`, () => {
    // Given
    const recorder = createAgentEventReportRecorder();

    // When / Then
    expect(() => recorder.endTask()).toThrow(
      "internal: no report Task is active",
    );
  });
});
