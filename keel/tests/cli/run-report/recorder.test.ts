import { describe, expect, test } from "vitest";
import type {
  ModelOperationHandle,
  ModelOperationPurpose,
  ModelOperationRecoveryTarget,
} from "../../../src/agent/model-operations.ts";
import { createAgentEventReportRecorder } from "../../../src/cli/report-events.ts";
import {
  createModelOperationReportLedger,
  type ModelOperationReportLedger,
} from "../../../src/cli/report-model-operations.ts";
import { ZERO_COST_MODEL } from "../../../src/core/cost.ts";

function beginSessionModelOperation(
  ledger: ModelOperationReportLedger,
  options:
    | {
        readonly purpose?: Extract<ModelOperationPurpose, "agent_turn">;
        readonly recoveryFor?: null;
      }
    | {
        readonly purpose: Extract<ModelOperationPurpose, "context_compaction">;
        readonly recoveryFor: ModelOperationRecoveryTarget | null;
      } = {},
): ModelOperationHandle {
  if (options.purpose === "context_compaction") {
    return ledger.beginModelOperation({
      recorder: ledger,
      owner: { type: "session" },
      provider: "fake",
      model: "fake",
      costModel: ZERO_COST_MODEL,
      purpose: "context_compaction",
      recoveryFor: options.recoveryFor,
    });
  }
  return ledger.beginModelOperation({
    recorder: ledger,
    owner: { type: "session" },
    provider: "fake",
    model: "fake",
    costModel: ZERO_COST_MODEL,
    purpose: "agent_turn",
    recoveryFor: null,
  });
}

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

  test(`Given no Agent Run owns a current-run model operation,
    When the report recorder begins that operation,
    Then it rejects the missing owner at the recorder boundary`, () => {
    // Given
    const recorder = createAgentEventReportRecorder();

    // When / Then
    expect(() =>
      recorder.beginModelOperation({
        recorder,
        owner: { type: "current_agent_run" },
        provider: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
        purpose: "agent_turn",
        recoveryFor: null,
      }),
    ).toThrow("requires an active Agent Run owner");
  });

  test(`Given a model operation or physical attempt is still pending,
    When a caller projects the report or finishes the logical operation,
    Then the ledger rejects the incomplete lifecycle`, () => {
    // Given
    const ledger = createModelOperationReportLedger(() => null);
    const operation = beginSessionModelOperation(ledger);
    operation.providerRequestAttempts.begin();

    // When / Then
    expect(() => ledger.modelOperations()).toThrow(
      "model operation never finished",
    );
    expect(() => operation.finish({ outcome: "terminal_error" })).toThrow(
      "unfinished provider request attempt",
    );
  });

  test(`Given model operation and physical-attempt handles already finished,
    When a caller finishes them again or starts a late attempt,
    Then the ledger rejects every duplicate terminal transition`, () => {
    // Given
    const ledger = createModelOperationReportLedger(() => null);
    const operation = beginSessionModelOperation(ledger);
    const attempt = operation.providerRequestAttempts.begin();
    attempt.finish({
      outcome: "terminal_error",
      errorCode: "provider_unexpected_error",
    });
    operation.finish({ outcome: "terminal_error" });

    // When / Then
    expect(() => attempt.finish({ outcome: "aborted" })).toThrow(
      "provider request attempt finished twice",
    );
    expect(() => operation.finish({ outcome: "terminal_error" })).toThrow(
      "model operation finished twice",
    );
    expect(() => operation.providerRequestAttempts.begin()).toThrow(
      "provider request attempt started after model operation finished",
    );
  });

  test(`Given a logical outcome conflicts with its physical attempts,
    When the caller projects or finishes the model operation,
    Then the ledger rejects completed-without-usage and late admission rejection`, () => {
    // Given
    const ledger = createModelOperationReportLedger(() => null);
    const completedWithoutAttempt = beginSessionModelOperation(ledger);
    const admittedOperation = beginSessionModelOperation(ledger);
    admittedOperation.providerRequestAttempts.begin().finish({
      outcome: "terminal_error",
      errorCode: "provider_unexpected_error",
    });

    // When / Then
    completedWithoutAttempt.finish({ outcome: "completed" });
    expect(() => ledger.modelOperations()).toThrow(
      "requires a completed provider request attempt",
    );
    expect(() =>
      admittedOperation.finish({ outcome: "admission_rejected" }),
    ).toThrow("cannot have provider request attempts");
  });

  test(`Given one context-overflow attempt already owns a recovery operation,
    When another compaction reuses the same recovery target,
    Then the ledger rejects the duplicate causal link`, () => {
    // Given
    const ledger = createModelOperationReportLedger(() => null);
    const operation = beginSessionModelOperation(ledger);
    operation.providerRequestAttempts
      .begin()
      .finish({ outcome: "context_overflow" });
    const recoveryFor = operation.latestContextOverflowRecoveryTarget();
    if (recoveryFor === null) {
      throw new Error("expected context-overflow recovery target");
    }
    operation.finish({ outcome: "context_overflow" });
    const recovery = beginSessionModelOperation(ledger, {
      purpose: "context_compaction",
      recoveryFor,
    });
    recovery.finish({ outcome: "admission_rejected" });

    // When / Then
    expect(() =>
      beginSessionModelOperation(ledger, {
        purpose: "context_compaction",
        recoveryFor,
      }),
    ).toThrow("already has a recovery operation");
  });

  test(`Given a context-overflow recovery target belongs to another report ledger,
    When a compaction tries to attach that foreign target,
    Then the receiving ledger rejects the cross-ledger causal link`, () => {
    // Given
    const sourceLedger = createModelOperationReportLedger(() => null);
    const sourceOperation = beginSessionModelOperation(sourceLedger);
    sourceOperation.providerRequestAttempts
      .begin()
      .finish({ outcome: "context_overflow" });
    const foreignRecoveryFor =
      sourceOperation.latestContextOverflowRecoveryTarget();
    if (foreignRecoveryFor === null) {
      throw new Error("expected context-overflow recovery target");
    }
    const receivingLedger = createModelOperationReportLedger(() => null);

    // When / Then
    expect(() =>
      beginSessionModelOperation(receivingLedger, {
        purpose: "context_compaction",
        recoveryFor: foreignRecoveryFor,
      }),
    ).toThrow("recovery target belongs to another report ledger");
  });
});
