import { randomUUID } from "node:crypto";
import type { AgentProviderRecoveryLifecycle } from "../../agent/loop.ts";
import type {
  PersistedSessionMessage,
  SessionMessage,
} from "../../agent/session-message.ts";
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
  readonly blockProviderBudget: () => Extract<
    ActiveSessionTask,
    { readonly phase: "recovery_blocked" }
  >;
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
  return {
    admit: (request) => {
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
        if (activeTask.assistantMessage.message.toolCalls.length > 0) {
          const blocked: Extract<
            ActiveSessionTask,
            { readonly phase: "recovery_blocked" }
          > = {
            ...activeTask,
            phase: "recovery_blocked",
            recovered: true,
            reason: "tool_plan",
          };
          persistSessionTaskRecoveryState({ session, task: blocked, runtime });
          return { kind: "blocked", task: blocked };
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
      return { kind: "run", task, userMessage };
    },
    blockProviderBudget: () => {
      const session = options.session();
      const activeTask = activeSessionTask(session);
      if (activeTask === undefined || activeTask.phase === "recovery_blocked") {
        throw new Error("provider budget cannot block this durable Task phase");
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
