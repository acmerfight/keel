import type { AgentEvent } from "../agent/events.ts";
import type { AgentProviderRecoveryLifecycle } from "../agent/loop.ts";
import type { SessionLedger } from "../agent/session-ledger.ts";
import type { SessionMessage } from "../agent/session-message.ts";
import { isAbortThrow } from "../core/error.ts";
import {
  type RecordLastBatchCheckpointOperation,
  recordLastTaskCheckpoint,
} from "../core/git.ts";
import type { ProviderId } from "../core/provider-id.ts";
import { copySessionGoal, type SessionGoal } from "../core/session-goal.ts";
import {
  copySessionTaskProgress,
  type SessionTaskProgress,
  sessionTaskProgressesEqual,
} from "../core/task-progress.ts";
import {
  type UndoProtectionTracker,
  undoCheckpointUnavailable,
} from "../core/undo-protection.ts";
import { skillLifecycleStatesEqual } from "../skills/lifecycle.ts";
import type {
  SkillActivationCapability,
  SkillLifecycleState,
} from "../skills/model.ts";
import type { ProjectInstructionVisibilityState } from "../tools/scoped-project-instructions.ts";
import { runMainAgentInvocation } from "./agent-invocation.ts";

type EndEvent = Extract<AgentEvent, { readonly type: "end" }>;
type AgentLoopAccounting = Pick<EndEvent, "usage" | "turns" | "cost">;
type InteractiveMainAgentInvocation = Extract<
  Parameters<typeof runMainAgentInvocation>[0],
  { readonly kind: "interactive_turn" }
>;
type TransactionOwnedLifecycleKey =
  | "onAgentLoopAccountingUpdated"
  | "providerRecovery"
  | "recordCheckpointOperations";
type WithoutTransactionLifecycle<Lifecycle> = Lifecycle extends unknown
  ? Omit<Lifecycle, TransactionOwnedLifecycleKey>
  : never;

export type MainTurnPreparedInvocation = Omit<
  InteractiveMainAgentInvocation,
  "lifecycle"
> & {
  readonly lifecycle: WithoutTransactionLifecycle<
    InteractiveMainAgentInvocation["lifecycle"]
  >;
};

interface MainTurnProviderSelection {
  readonly providerId: ProviderId;
  readonly model: string;
}

interface MainTurnSavedPersistence {
  readonly persistMessages: (request: {
    readonly messages: readonly SessionMessage[];
    readonly reason: "turn";
    readonly consumedInputIds: readonly string[];
    readonly skillState: SkillLifecycleState | null;
    readonly reservedMessageIds: readonly MainTurnReservedMessageId[];
  }) => void;
  readonly persistTaskProgress: (update: {
    readonly taskProgress: SessionTaskProgress;
    readonly messageOrdinal: number;
  }) => void;
  readonly persistGoal: (update: {
    readonly goal: SessionGoal | null;
    readonly consumedInputIds: readonly string[];
  }) => SessionGoal | undefined;
}

interface MainTurnTaskRecovery {
  readonly admit: (request: {
    readonly userMessage: Extract<SessionMessage, { readonly role: "user" }>;
    readonly provider: MainTurnProviderSelection;
    readonly consumedInputIds: readonly string[];
    readonly userMessageId?: string;
  }) => { readonly runId: string };
  readonly blockProviderBudget: (
    messages: readonly SessionMessage[],
  ) => unknown;
  readonly providerLifecycle: (
    provider: MainTurnProviderSelection,
    inputPersistence: {
      readonly pendingInputIds: () => readonly string[];
      readonly committed: (inputIds: readonly string[]) => void;
    },
  ) => AgentProviderRecoveryLifecycle;
  readonly terminal: (request: {
    readonly messages: readonly SessionMessage[];
    readonly outcome: "completed";
    readonly skillState?: SkillLifecycleState;
    readonly consumedInputIds: readonly string[];
  }) => unknown;
  readonly finalizeCheckpoint: () => ReturnType<
    typeof recordLastTaskCheckpoint
  > | null;
}

type MainTurnDurability =
  | { readonly kind: "ephemeral" }
  | {
      readonly kind: "saved";
      readonly persistence: MainTurnSavedPersistence;
    }
  | {
      readonly kind: "durable";
      readonly persistence: MainTurnSavedPersistence;
      readonly recovery: MainTurnTaskRecovery;
      readonly provider: MainTurnProviderSelection;
      readonly recoveringRunId?: string;
    };

interface MainTurnReservedMessageId {
  readonly message: SessionMessage;
  readonly id: string;
}

export interface MainTurnQueuedInput {
  readonly inputId?: string;
}

interface MainTurnInputState<Input extends MainTurnQueuedInput> {
  readonly consumed: readonly Input[];
  readonly drained: readonly Input[];
  readonly deferred: readonly Input[];
  readonly persistedInputIds: Set<string>;
  readonly persistedDrainedCount: () => number;
  readonly restore: (inputs: readonly Input[]) => void;
  readonly consume: (inputs: readonly Input[]) => void;
}

interface MainTurnState {
  readonly ledger: SessionLedger;
  readonly taskProgress: {
    readonly current: () => SessionTaskProgress;
    readonly restore: (progress: SessionTaskProgress) => void;
  };
  readonly goal: {
    readonly current: () => SessionGoal | undefined;
    readonly restore: (goal: SessionGoal | undefined) => void;
  };
  readonly projectInstructions: Pick<
    ProjectInstructionVisibilityState,
    "restoreSnapshot" | "snapshot"
  >;
  readonly skill?: {
    readonly activation: SkillActivationCapability;
    readonly before: SkillLifecycleState;
    readonly stateChanged: () => void;
  };
}

interface MainTurnReport {
  readonly abort: (turns: number) => void;
  readonly complete: (turns: number, stopReason: string) => void;
  readonly fail: () => void;
  readonly recordAbortedEnd: (end: EndEvent) => void;
}

interface MainTurnUpdates {
  readonly taskProgress: readonly {
    readonly taskProgress: SessionTaskProgress;
    readonly messageOrdinal: number;
  }[];
  readonly goals: readonly SessionGoal[];
}

interface MainTurnTransactionContext {
  readonly durableRunId?: string;
}

interface MainTurnCommitFacts {
  readonly workspaceChanged: boolean;
  readonly goalBeforeTurn?: SessionGoal;
}

export interface RunMainTurnTransactionOptions<
  Input extends MainTurnQueuedInput,
  Result,
> {
  readonly workspace: string;
  readonly currentUserMessage: Extract<
    SessionMessage,
    { readonly role: "user" }
  >;
  readonly signal: AbortSignal;
  readonly durability: MainTurnDurability;
  readonly state: MainTurnState;
  readonly input: MainTurnInputState<Input>;
  readonly updates: MainTurnUpdates;
  readonly reservedMessageIds: MainTurnReservedMessageId[];
  readonly persistedMemorySourceMessages: () =>
    | readonly SessionMessage[]
    | null;
  readonly report: MainTurnReport;
  readonly undoProtection: UndoProtectionTracker;
  readonly prepareInvocation: (
    context: MainTurnTransactionContext,
  ) => MainTurnPreparedInvocation | Promise<MainTurnPreparedInvocation>;
  readonly observeEvents: (
    stream: AsyncIterable<AgentEvent>,
  ) => AsyncIterable<AgentEvent>;
  readonly consumeEvents: (
    stream: AsyncIterable<AgentEvent>,
  ) => Promise<EndEvent | undefined>;
  readonly afterCommit: (
    end: EndEvent | undefined,
    facts: MainTurnCommitFacts,
  ) => Result | Promise<Result>;
  readonly afterAbort: () => Result | Promise<Result>;
  readonly checkpointUnavailable: () => void;
}

function inputIds<Input extends MainTurnQueuedInput>(
  inputs: readonly Input[],
): readonly string[] {
  return inputs.flatMap((input) =>
    input.inputId === undefined ? [] : [input.inputId],
  );
}

function clearReservedMessageIds(
  reservedMessageIds: MainTurnReservedMessageId[],
): void {
  reservedMessageIds.splice(0, reservedMessageIds.length);
}

function restoreTurnState<Input extends MainTurnQueuedInput, Result>(options: {
  readonly transaction: RunMainTurnTransactionOptions<Input, Result>;
  readonly messagesBeforeTurn: readonly SessionMessage[];
  readonly taskProgressBeforeTurn: SessionTaskProgress;
  readonly sessionGoalBeforeTurn?: SessionGoal;
  readonly projectInstructionsBeforeTurn: ReturnType<
    ProjectInstructionVisibilityState["snapshot"]
  >;
}): void {
  const { transaction } = options;
  const skill = transaction.state.skill;
  if (skill !== undefined) {
    skill.activation.restore(skill.before);
    skill.stateChanged();
  }
  transaction.state.ledger.replace(
    transaction.persistedMemorySourceMessages() ?? options.messagesBeforeTurn,
  );
  clearReservedMessageIds(transaction.reservedMessageIds);
  transaction.state.taskProgress.restore(options.taskProgressBeforeTurn);
  transaction.state.goal.restore(options.sessionGoalBeforeTurn);
  transaction.state.projectInstructions.restoreSnapshot(
    options.projectInstructionsBeforeTurn,
  );
  transaction.input.restore([
    ...transaction.input.drained.slice(
      transaction.input.persistedDrainedCount(),
    ),
    ...transaction.input.deferred,
  ]);
  transaction.input.consume(
    transaction.input.consumed.filter(
      (input) =>
        input.inputId === undefined ||
        !transaction.input.persistedInputIds.has(input.inputId),
    ),
  );
}

function changedSkillState(
  skill: MainTurnState["skill"],
): SkillLifecycleState | null {
  if (skill === undefined) return null;
  const completed = skill.activation.state();
  return skillLifecycleStatesEqual(skill.before, completed) ? null : completed;
}

function persistCommittedTurn<
  Input extends MainTurnQueuedInput,
  Result,
>(options: {
  readonly transaction: RunMainTurnTransactionOptions<Input, Result>;
  readonly finalEnd?: EndEvent;
  readonly taskProgressBeforeTurn: SessionTaskProgress;
}): void {
  const { transaction } = options;
  const skillState = changedSkillState(transaction.state.skill);
  const messages = transaction.state.ledger.messages();
  const consumedInputIds = [
    ...inputIds(transaction.input.consumed),
    ...inputIds(transaction.input.drained),
  ].filter((inputId) => !transaction.input.persistedInputIds.has(inputId));

  switch (transaction.durability.kind) {
    case "ephemeral":
      break;
    case "saved":
      transaction.durability.persistence.persistMessages({
        messages,
        reason: "turn",
        consumedInputIds,
        skillState,
        reservedMessageIds: transaction.reservedMessageIds,
      });
      break;
    case "durable":
      if (options.finalEnd?.stopReason === "cost_budget") {
        transaction.durability.recovery.blockProviderBudget(messages);
      } else {
        transaction.durability.recovery.terminal({
          messages,
          outcome: "completed",
          ...(skillState === null ? {} : { skillState }),
          consumedInputIds: inputIds(transaction.input.drained).filter(
            (inputId) => !transaction.input.persistedInputIds.has(inputId),
          ),
        });
      }
      break;
  }

  clearReservedMessageIds(transaction.reservedMessageIds);
  if (skillState !== null) {
    transaction.state.skill?.stateChanged();
  }
  if (transaction.durability.kind !== "ephemeral") {
    let lastPersistedProgress = options.taskProgressBeforeTurn;
    for (const update of transaction.updates.taskProgress) {
      if (
        sessionTaskProgressesEqual(update.taskProgress, lastPersistedProgress)
      ) {
        continue;
      }
      transaction.durability.persistence.persistTaskProgress(update);
      lastPersistedProgress = copySessionTaskProgress(update.taskProgress);
    }
    for (const goal of transaction.updates.goals) {
      const persisted = transaction.durability.persistence.persistGoal({
        goal,
        consumedInputIds: [],
      });
      transaction.state.goal.restore(persisted);
    }
  }
  transaction.input.restore(transaction.input.deferred);
}

function reportAbortedTurn(options: {
  readonly report: MainTurnReport;
  readonly finalEnd?: EndEvent;
  readonly latestAccounting?: AgentLoopAccounting;
  readonly recordAccounting?: boolean;
}): void {
  const accounting = options.finalEnd ?? options.latestAccounting;
  options.report.abort(accounting?.turns ?? 0);
  if (options.recordAccounting === false || accounting === undefined) return;
  options.report.recordAbortedEnd({
    type: "end",
    usage: accounting.usage,
    turns: accounting.turns,
    stopReason: "aborted",
    ...(accounting.cost === undefined ? {} : { cost: accounting.cost }),
  });
}

function settleCheckpoint<Input extends MainTurnQueuedInput, Result>(options: {
  readonly transaction: RunMainTurnTransactionOptions<Input, Result>;
  readonly operations: readonly RecordLastBatchCheckpointOperation[];
}): void {
  if (options.operations.length === 0) return;
  const durableResult =
    options.transaction.durability.kind === "durable"
      ? options.transaction.durability.recovery.finalizeCheckpoint()
      : null;
  const result =
    durableResult ??
    recordLastTaskCheckpoint({
      workspace: options.transaction.workspace,
      operations: options.operations,
    });
  options.transaction.undoProtection.record(result);
  if (undoCheckpointUnavailable(result)) {
    options.transaction.checkpointUnavailable();
  }
}

export async function runMainTurnTransaction<
  Input extends MainTurnQueuedInput,
  Result,
>(options: RunMainTurnTransactionOptions<Input, Result>): Promise<Result> {
  const messagesBeforeTurn = [...options.state.ledger.messages()];
  const taskProgressBeforeTurn = copySessionTaskProgress(
    options.state.taskProgress.current(),
  );
  const currentGoal = options.state.goal.current();
  const sessionGoalBeforeTurn =
    currentGoal === undefined ? undefined : copySessionGoal(currentGoal);
  const projectInstructionsBeforeTurn =
    options.state.projectInstructions.snapshot();
  const checkpointOperations: RecordLastBatchCheckpointOperation[] = [];
  let latestAccounting: AgentLoopAccounting | undefined;
  let committed = false;

  let durableRunId =
    options.durability.kind === "durable"
      ? options.durability.recoveringRunId
      : undefined;
  if (
    options.durability.kind === "durable" &&
    options.durability.recoveringRunId === undefined
  ) {
    const userMessageId = options.reservedMessageIds.find(
      (reservation) => reservation.message === options.currentUserMessage,
    )?.id;
    durableRunId = options.durability.recovery.admit({
      userMessage: options.currentUserMessage,
      provider: options.durability.provider,
      consumedInputIds: inputIds(options.input.consumed),
      ...(userMessageId === undefined ? {} : { userMessageId }),
    }).runId;
  }
  if (
    options.durability.kind !== "durable" ||
    options.durability.recoveringRunId === undefined
  ) {
    options.state.ledger.append(options.currentUserMessage);
  }

  try {
    const prepared = await options.prepareInvocation({
      ...(durableRunId === undefined ? {} : { durableRunId }),
    });
    const providerRecovery =
      options.durability.kind === "durable"
        ? options.durability.recovery.providerLifecycle(
            options.durability.provider,
            {
              pendingInputIds: () =>
                inputIds(options.input.drained).filter(
                  (inputId) => !options.input.persistedInputIds.has(inputId),
                ),
              committed: (inputIds) => {
                for (const inputId of inputIds) {
                  options.input.persistedInputIds.add(inputId);
                }
              },
            },
          )
        : undefined;
    const invocation: InteractiveMainAgentInvocation = {
      ...prepared,
      lifecycle: {
        ...prepared.lifecycle,
        ...(providerRecovery === undefined ? {} : { providerRecovery }),
        recordCheckpointOperations: (operations) => {
          checkpointOperations.push(...operations);
        },
        onAgentLoopAccountingUpdated: (accounting) => {
          latestAccounting = accounting;
        },
      },
    };
    const finalEnd = await options.consumeEvents(
      options.observeEvents(runMainAgentInvocation(invocation)),
    );
    if (options.signal.aborted) {
      reportAbortedTurn({
        report: options.report,
        ...(finalEnd === undefined ? {} : { finalEnd }),
        ...(latestAccounting === undefined ? {} : { latestAccounting }),
      });
      restoreTurnState({
        transaction: options,
        messagesBeforeTurn,
        taskProgressBeforeTurn,
        ...(sessionGoalBeforeTurn === undefined
          ? {}
          : { sessionGoalBeforeTurn }),
        projectInstructionsBeforeTurn,
      });
      return await options.afterAbort();
    }
    persistCommittedTurn({
      transaction: options,
      ...(finalEnd === undefined ? {} : { finalEnd }),
      taskProgressBeforeTurn,
    });
    committed = true;
    if (finalEnd === undefined) {
      reportAbortedTurn({
        report: options.report,
        recordAccounting: false,
      });
    } else {
      options.report.complete(finalEnd.turns, finalEnd.stopReason);
    }
    return await options.afterCommit(finalEnd, {
      workspaceChanged: checkpointOperations.length > 0,
      ...(sessionGoalBeforeTurn === undefined
        ? {}
        : { goalBeforeTurn: sessionGoalBeforeTurn }),
    });
  } catch (error) {
    if (committed) throw error;
    if (!isAbortThrow(error, options.signal) && !options.signal.aborted) {
      options.report.fail();
      restoreTurnState({
        transaction: options,
        messagesBeforeTurn,
        taskProgressBeforeTurn,
        ...(sessionGoalBeforeTurn === undefined
          ? {}
          : { sessionGoalBeforeTurn }),
        projectInstructionsBeforeTurn,
      });
      throw error;
    }
    reportAbortedTurn({
      report: options.report,
      ...(latestAccounting === undefined ? {} : { latestAccounting }),
    });
    restoreTurnState({
      transaction: options,
      messagesBeforeTurn,
      taskProgressBeforeTurn,
      ...(sessionGoalBeforeTurn === undefined ? {} : { sessionGoalBeforeTurn }),
      projectInstructionsBeforeTurn,
    });
    return await options.afterAbort();
  } finally {
    settleCheckpoint({
      transaction: options,
      operations: checkpointOperations,
    });
  }
}
