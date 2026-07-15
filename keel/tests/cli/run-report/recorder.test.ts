import { describe, expect, test } from "vitest";
import { createAgentEventReportRecorder } from "../../../src/cli/report-events.ts";

describe("CLI Run Report Recorder", () => {
  test(`Given one Task contains multiple Agent Runs and user corrections,
    When the report recorder completes their lifecycle,
    Then each Run owns its interventions and the Task derives their total`, () => {
    // Given
    const recorder = createAgentEventReportRecorder();
    recorder.beginTask("goal_activation");
    recorder.beginAgentRun("goal_activation");
    recorder.recordHumanIntervention();
    recorder.completeAgentRun(1, "completed");
    recorder.beginAgentRun("goal_continuation");
    recorder.recordHumanIntervention();
    recorder.recordHumanIntervention();
    recorder.completeAgentRun(2, "completed");

    // When
    recorder.endTask();

    // Then
    expect(recorder.tasks()).toMatchObject([
      {
        humanInterventionCount: 3,
        agentRuns: [
          { ordinal: 1, humanInterventionCount: 1 },
          { ordinal: 2, humanInterventionCount: 2 },
        ],
      },
    ]);
  });

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
    expect(() => recorder.recordHumanIntervention()).toThrow(
      "internal: report human intervention requires an active Agent Run",
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
