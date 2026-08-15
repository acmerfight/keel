import { randomUUID } from "node:crypto";
import type { AgentProviderRecoveryLifecycle } from "../../agent/loop.ts";
import type {
  PersistedSessionMessage,
  SessionMessage,
} from "../../agent/session-message.ts";
import {
  loadTaskCheckpointOperations,
  type RecordLastBatchCheckpointOperation,
  recordLastTaskCheckpoint,
} from "../../core/git.ts";
import type { RecordUndoCheckpointResult } from "../../core/undo-protection.ts";
import type {
  ProviderRequestAttemptFinish,
  ProviderRequestAttemptObserver,
  Usage,
} from "../../llm/types.ts";
import type { SkillLifecycleState } from "../../skills/model.ts";
import {
  type ActiveSessionTask,
  activeSessionTask,
  persistSessionProviderAttemptSettlement,
  persistSessionProviderIntent,
  persistSessionProviderResponse,
  persistSessionTaskAdmission,
  persistSessionTaskRecoveryState,
  persistSessionTaskStep,
  persistSessionTaskTerminal,
  persistSessionToolIntents,
  persistSessionToolSettlement,
  type SessionLastTaskOutcome,
  type SessionModelSelection,
  type SessionProviderAttemptSettlement,
  type SessionState,
  type SessionStoreRuntime,
  sessionStoredMessages,
} from "../session-store.ts";

type SessionTaskResumeDirective =
  | { readonly kind: "none" }
  | {
      readonly kind: "run";
      readonly task: Extract<
        ActiveSessionTask,
        { readonly phase: "provider_ready" }
      >;
      readonly userMessage: Extract<
        PersistedSessionMessage,
        { readonly role: "user" }
      >;
      readonly recoveredMessages: readonly SessionMessage[];
    }
  | {
      readonly kind: "delivered";
      readonly message: Extract<SessionMessage, { readonly role: "assistant" }>;
      readonly outcome: SessionLastTaskOutcome;
    }
  | {
      readonly kind: "blocked";
      readonly task: Extract<
        ActiveSessionTask,
        { readonly phase: "recovery_blocked" }
      >;
    };

export interface SessionTaskRecovery {
  readonly admit: (options: {
    readonly userMessage: Extract<SessionMessage, { readonly role: "user" }>;
    readonly provider: SessionModelSelection;
    readonly consumedInputIds: readonly string[];
    readonly userMessageId?: string;
  }) => Extract<ActiveSessionTask, { readonly phase: "provider_ready" }>;
  readonly resume: () => SessionTaskResumeDirective;
  readonly finalizeCheckpoint: () => RecordUndoCheckpointResult | null;
  readonly blockProviderBudget: (
    messages: readonly SessionMessage[],
  ) => Extract<ActiveSessionTask, { readonly phase: "recovery_blocked" }>;
  readonly providerLifecycle: (
    provider: SessionModelSelection,
    inputPersistence?: {
      readonly pendingInputIds: () => readonly string[];
      readonly committed: (inputIds: readonly string[]) => void;
    },
  ) => AgentProviderRecoveryLifecycle;
  readonly terminal: (options: {
    readonly messages: readonly SessionMessage[];
    readonly outcome: "completed" | "failed" | "aborted";
    readonly skillState?: SkillLifecycleState;
    readonly consumedInputIds?: readonly string[];
  }) => SessionLastTaskOutcome;
}

function settlementFromProviderFinish(
  finish: ProviderRequestAttemptFinish,
): SessionProviderAttemptSettlement {
  switch (finish.outcome) {
    case "completed":
      return { outcome: "completed", usage: { ...finish.usage } };
    case "retryable_error":
      return {
        outcome: "retryable_error",
        provider: finish.retryDecision.provider,
        reason: finish.retryDecision.reason,
        attempt: finish.retryDecision.attempt,
        maxRetries: finish.retryDecision.maxRetries,
        delayMs: finish.retryDecision.delayMs,
      };
    case "context_overflow":
    case "aborted":
      return { outcome: finish.outcome };
    case "terminal_error":
      return {
        outcome: "terminal_error",
        errorCode: finish.errorCode,
      };
  }
}

function completedSettlement(
  usage: Usage,
): Extract<
  SessionProviderAttemptSettlement,
  { readonly outcome: "completed" }
> {
  return { outcome: "completed", usage: { ...usage } };
}

export function createSessionTaskRecovery(options: {
  readonly session: () => SessionState;
  readonly runtime: SessionStoreRuntime;
  readonly currentMessages: () => readonly SessionMessage[];
  readonly onMessagesPersisted: (messages: readonly SessionMessage[]) => void;
}): SessionTaskRecovery {
  const { runtime } = options;
  let checkpointOwnerId: string | undefined;
  const checkpointOperations: RecordLastBatchCheckpointOperation[] = [];
  const restoreCheckpointOwner = (session: SessionState): void => {
    const task = activeSessionTask(session);
    if (task === undefined || checkpointOwnerId === task.taskId) return;
    checkpointOwnerId = task.taskId;
    checkpointOperations.splice(
      0,
      checkpointOperations.length,
      ...loadTaskCheckpointOperations({
        workspace: session.workspace,
        ownerId: task.taskId,
      }),
    );
  };
  const persistCheckpoint = (): RecordUndoCheckpointResult | null => {
    if (checkpointOwnerId === undefined || checkpointOperations.length === 0) {
      return null;
    }
    return recordLastTaskCheckpoint({
      workspace: options.session().workspace,
      ownerId: checkpointOwnerId,
      operations: checkpointOperations,
    });
  };
  return {
    admit: (request) => {
      checkpointOperations.splice(0, checkpointOperations.length);
      const session = options.session();
      const task = persistSessionTaskAdmission({
        session,
        userMessage: request.userMessage,
        provider: request.provider,
        consumedInputIds: request.consumedInputIds,
        ...(request.userMessageId === undefined
          ? {}
          : { userMessageId: request.userMessageId }),
        runtime,
      });
      checkpointOwnerId = task.taskId;
      options.onMessagesPersisted([
        ...options.currentMessages(),
        request.userMessage,
      ]);
      return task;
    },
    resume: () => {
      const session = options.session();
      const activeTask = activeSessionTask(session);
      if (activeTask === undefined) return { kind: "none" };
      restoreCheckpointOwner(session);
      if (activeTask.phase === "recovery_blocked") {
        return { kind: "blocked", task: activeTask };
      }
      if (activeTask.phase === "provider_settled") {
        /* v8 ignore next 5 -- the persisted provider-settled schema and replay validation require an assistant message. */
        if (activeTask.assistantMessage.message.role !== "assistant") {
          throw new Error(
            "durable provider response is not an assistant message",
          );
        }
        const message = activeTask.assistantMessage.message;
        const outcome = persistSessionTaskTerminal({
          session,
          currentMessages: [...options.currentMessages(), message],
          outcome: "completed",
          runtime,
        });
        options.onMessagesPersisted([...options.currentMessages(), message]);
        return { kind: "delivered", message, outcome };
      }
      if (activeTask.phase === "tool_execution") {
        for (const invocation of activeTask.toolInvocations) {
          if (invocation.phase === "settled") continue;
          const settlementKind =
            invocation.phase === "planned"
              ? "not_executed_after_restart"
              : invocation.recovery.kind === "no_effect"
                ? "interrupted_no_effect"
                : "interrupted_effect_unknown";
          const content = JSON.stringify({
            status: settlementKind,
            operationId: invocation.operationId,
            tool: invocation.toolName,
            message:
              settlementKind === "interrupted_effect_unknown"
                ? "The prior process ended after this invocation started. Its effect is unknown; the old invocation was not repeated."
                : settlementKind === "interrupted_no_effect"
                  ? "The prior process ended during this no-effect invocation. It was not repeated."
                  : "The prior process ended before this invocation started. It was not executed.",
          });
          persistSessionToolSettlement({
            session,
            toolCallId: invocation.toolCallId,
            settlementKind,
            toolMessage: {
              role: "tool",
              toolCallId: invocation.toolCallId,
              content,
              recovery: {
                kind: settlementKind,
                taskId: activeTask.taskId,
                runId: invocation.runId,
                operationId: invocation.operationId,
              },
            },
            effects: { checkpointOperations: [] },
            runtime,
          });
        }
        const settledTask = activeSessionTask(session);
        /* v8 ignore next 4 -- each unsettled invocation was synchronously settled above. */
        if (settledTask?.phase !== "tool_execution") {
          throw new Error(
            "durable tool recovery changed Task phase unexpectedly",
          );
        }
        const recoveredMessages: readonly SessionMessage[] = [
          settledTask.assistantMessage.message,
          ...[...settledTask.toolInvocations]
            .sort((left, right) => left.sourceIndex - right.sourceIndex)
            .map((invocation) => {
              /* v8 ignore next 3 -- the recovery loop settles every invocation before transcript promotion. */
              if (invocation.phase !== "settled") {
                throw new Error(
                  "durable tool recovery left an invocation unsettled",
                );
              }
              return invocation.toolMessage.message;
            }),
        ];
        const nextRunId = `run_${randomUUID()}`;
        persistSessionTaskStep({
          session,
          currentMessages: [...options.currentMessages(), ...recoveredMessages],
          recoveryRunId: nextRunId,
          runtime,
        });
        const recoveredTask = activeSessionTask(session);
        /* v8 ignore next 4 -- the atomic step commit chooses exactly one recovery outcome. */
        if (recoveredTask === undefined) {
          throw new Error("durable tool recovery lost its active Task");
        }
        options.onMessagesPersisted([
          ...options.currentMessages(),
          ...recoveredMessages,
        ]);
        if (recoveredTask.phase === "recovery_blocked") {
          return { kind: "blocked", task: recoveredTask };
        }
        /* v8 ignore next 3 -- a non-blocked recovered tool step is provider-ready. */
        if (recoveredTask.phase !== "provider_ready") {
          throw new Error("durable tool recovery did not create a fresh Run");
        }
        const userMessage = sessionStoredMessages(session).find(
          (storedMessage) => storedMessage.id === recoveredTask.userMessageId,
        )?.message;
        /* v8 ignore next 4 -- task admission requires this exact stored user message. */
        if (userMessage === undefined || userMessage.role !== "user") {
          throw new Error("durable tool recovery input is missing");
        }
        return {
          kind: "run",
          task: recoveredTask,
          userMessage,
          recoveredMessages,
        };
      }
      if (
        activeTask.phase === "provider_pending" &&
        (activeTask.providerAttempt.settlement?.outcome === "terminal_error" ||
          activeTask.providerAttempt.settlement?.outcome === "aborted")
      ) {
        persistSessionTaskTerminal({
          session,
          currentMessages: options.currentMessages(),
          outcome:
            activeTask.providerAttempt.settlement.outcome === "aborted"
              ? "aborted"
              : "failed",
          runtime,
        });
        return { kind: "none" };
      }

      const userMessage = sessionStoredMessages(session).find(
        (storedMessage) => storedMessage.id === activeTask.userMessageId,
      )?.message;
      /* v8 ignore next 5 -- admission, replay, and snapshot validation require exactly this stored user message. */
      if (userMessage === undefined || userMessage.role !== "user") {
        throw new Error(
          `durable Task ${activeTask.taskId} is missing its admitted user message`,
        );
      }

      const unknownAttempt =
        activeTask.phase === "provider_pending" &&
        (activeTask.providerAttempt.settlement === undefined ||
          activeTask.providerAttempt.settlement.outcome === "completed")
          ? activeTask.providerAttempt.attemptId
          : null;
      const replacesProviderAttempt = activeTask.phase === "provider_pending";
      const providerReplacementsUsed =
        activeTask.providerReplacementsUsed + (replacesProviderAttempt ? 1 : 0);
      /* v8 ignore start -- replay requires each active attempt id to be new; retain deduplication as a defensive guard. */
      const unknownProviderAttemptIds =
        unknownAttempt === null
          ? [...activeTask.unknownProviderAttemptIds]
          : [
              ...activeTask.unknownProviderAttemptIds,
              ...(activeTask.unknownProviderAttemptIds.includes(unknownAttempt)
                ? []
                : [unknownAttempt]),
            ];
      /* v8 ignore stop */
      if (
        replacesProviderAttempt &&
        providerReplacementsUsed > activeTask.maxProviderReplacements
      ) {
        const blocked: Extract<
          ActiveSessionTask,
          { readonly phase: "recovery_blocked" }
        > = {
          ...activeTask,
          phase: "recovery_blocked",
          providerReplacementsUsed: activeTask.providerReplacementsUsed,
          unknownProviderAttemptIds,
          recovered: true,
          reason: "provider_replacement_limit",
        };
        persistSessionTaskRecoveryState({ session, task: blocked, runtime });
        return { kind: "blocked", task: blocked };
      }
      const task: Extract<
        ActiveSessionTask,
        { readonly phase: "provider_ready" }
      > = {
        taskId: activeTask.taskId,
        runId: `run_${randomUUID()}`,
        trigger: activeTask.trigger,
        admittedAt: activeTask.admittedAt,
        userMessageId: activeTask.userMessageId,
        provider: activeTask.provider,
        maxProviderReplacements: activeTask.maxProviderReplacements,
        providerReplacementsUsed,
        recovered: true,
        providerRequestIds: activeTask.providerRequestIds,
        unknownProviderAttemptIds,
        phase: "provider_ready",
      };
      persistSessionTaskRecoveryState({ session, task, runtime });
      return { kind: "run", task, userMessage, recoveredMessages: [] };
    },
    finalizeCheckpoint: persistCheckpoint,
    blockProviderBudget: (messages) => {
      const session = options.session();
      let activeTask = activeSessionTask(session);
      if (activeTask === undefined || activeTask.phase === "recovery_blocked") {
        throw new Error("provider budget cannot block this durable Task phase");
      }
      if (activeTask.phase === "tool_execution") {
        persistSessionTaskStep({
          session,
          currentMessages: messages,
          runtime,
        });
        activeTask = activeSessionTask(session);
        /* v8 ignore next 4 -- a complete tool group commits to provider-ready before budget blocking. */
        if (activeTask?.phase !== "provider_ready") {
          throw new Error(
            "provider budget could not commit its durable tool group",
          );
        }
        options.onMessagesPersisted(messages);
      }
      const blocked: Extract<
        ActiveSessionTask,
        { readonly phase: "recovery_blocked" }
      > = {
        ...activeTask,
        phase: "recovery_blocked",
        reason: "provider_budget",
      };
      persistSessionTaskRecoveryState({ session, task: blocked, runtime });
      return blocked;
    },
    providerLifecycle: (provider, inputPersistence) => {
      const providerRequestAttempts = (
        terminalizeKnownFailure: boolean,
      ): ProviderRequestAttemptObserver => ({
        begin: () => {
          const session = options.session();
          const pending = persistSessionProviderIntent({
            session,
            provider,
            runtime,
          });
          let finished = false;
          return {
            finish: (finish) => {
              if (finished) return;
              finished = true;
              const settlement = settlementFromProviderFinish(finish);
              persistSessionProviderAttemptSettlement({
                session,
                attemptId: pending.providerAttempt.attemptId,
                settlement,
                runtime,
              });
              if (
                terminalizeKnownFailure &&
                (settlement.outcome === "terminal_error" ||
                  settlement.outcome === "aborted")
              ) {
                persistSessionTaskTerminal({
                  session,
                  currentMessages: options.currentMessages(),
                  outcome:
                    settlement.outcome === "aborted" ? "aborted" : "failed",
                  runtime,
                });
              }
            },
          };
        },
      });
      return {
        beforeRequest: (messages) => {
          const consumedInputIds = inputPersistence?.pendingInputIds() ?? [];
          const committed = persistSessionTaskStep({
            session: options.session(),
            currentMessages: messages,
            consumedInputIds,
            runtime,
          });
          if (committed) inputPersistence?.committed(consumedInputIds);
          options.onMessagesPersisted(messages);
        },
        providerRequestAttempts: providerRequestAttempts(true),
        auxiliaryProviderRequestAttempts: providerRequestAttempts(false),
        settled: (response) => {
          const session = options.session();
          persistSessionProviderResponse({
            session,
            assistantMessage: response.assistantMessage,
            usage: completedSettlement(response.usage),
            stopReason: response.stopReason,
            runtime,
          });
        },
        beforeToolCalls: (toolCalls) => {
          persistSessionToolIntents({
            session: options.session(),
            toolCallIds: toolCalls.map((toolCall) => toolCall.id),
            runtime,
          });
        },
        toolSettled: (settlement) => {
          const session = options.session();
          restoreCheckpointOwner(session);
          if (settlement.effects.checkpointOperations.length > 0) {
            checkpointOperations.push(
              ...settlement.effects.checkpointOperations,
            );
            persistCheckpoint();
          }
          persistSessionToolSettlement({
            session,
            toolCallId: settlement.toolMessage.toolCallId,
            settlementKind: "completed",
            toolMessage: settlement.toolMessage,
            effects: settlement.effects,
            runtime,
          });
        },
      };
    },
    terminal: (request) => {
      const session = options.session();
      const outcome = persistSessionTaskTerminal({
        session,
        currentMessages: request.messages,
        outcome: request.outcome,
        ...(request.skillState === undefined
          ? {}
          : { skillState: request.skillState }),
        ...(request.consumedInputIds === undefined
          ? {}
          : { consumedInputIds: request.consumedInputIds }),
        runtime,
      });
      options.onMessagesPersisted(request.messages);
      return outcome;
    },
  };
}
