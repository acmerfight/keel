import { createInterface } from "node:readline/promises";
import type { AgentEvent, CostReport } from "../agent/events.ts";
import { runAgentTurn } from "../agent/loop.ts";
import { postCompactionReadToolCallId } from "../agent/post-compaction-read-id.ts";
import { buildAgentSystemPrompt } from "../agent/prompt.ts";
import {
  clearReadVisibilityState,
  createReadVisibilityState,
} from "../agent/read-visibility.ts";
import { defaultStopPolicy } from "../agent/stop-policy.ts";
import { type CostModel, calculateRequestCostBatchUsd } from "../core/cost.ts";
import {
  listUndoCheckpoints,
  type RecordLastBatchCheckpointOperation,
  recordLastTaskCheckpoint,
  restoreLastEditCheckpoint,
  restoreUndoCheckpointsThrough,
} from "../core/git.ts";
import {
  accountSessionGoalTurn,
  activeSessionGoalSystemPrompt,
  copySessionGoal,
  emptySessionGoalBudget,
  emptySessionGoalUsage,
  formatSessionGoalBudgetLimitReason,
  formatSessionGoalSummary,
  type SessionGoal,
  sessionGoalAccounting,
  sessionGoalsEqual,
} from "../core/session-goal.ts";
import {
  copySessionTaskProgress,
  emptySessionTaskProgress,
  type SessionTaskProgress,
  sessionTaskProgressesEqual,
} from "../core/task-progress.ts";
import type { Message, Usage } from "../llm/types.ts";
import {
  type BashApprovalGrant,
  type BashProjectApprovalGrant,
  bashApprovalGrantKey,
  bashModeExposesTool,
} from "../permissions/bash.ts";
import { executeGitDiff } from "../tools/git-diff.ts";
import { executeGitStatus } from "../tools/git-status.ts";
import { createProjectInstructionVisibilityState } from "../tools/scoped-project-instructions.ts";
import { formatBashProjectApprovalList } from "./bash-project-approvals.ts";
import {
  formatInteractiveForkPicker,
  formatInteractiveSessionForkPoints,
} from "./fork-points.ts";
import { interactiveBashPermissionPolicy } from "./interactive-session/bash-approval.ts";
import {
  formatBashApprovalClearResult,
  formatBashApprovalList,
  formatBashApprovalRevoked,
} from "./interactive-session/bash-approvals.ts";
import {
  formatForkRequiresNamedSession,
  formatGoalRequiresSavedSession,
  formatInteractiveCommandFailure,
  formatInteractiveGoal,
  formatInteractiveGoalBudget,
  formatInteractiveGoalBudgetCleared,
  formatInteractiveGoalBudgetUpdated,
  formatInteractiveGoalCleared,
  formatInteractiveGoalCompleted,
  formatInteractiveGoalCriterionSet,
  formatInteractiveGoalPaused,
  formatInteractiveGoalResumed,
  formatInteractiveGoalSet,
  formatInteractiveGoalVerificationSet,
  formatInteractiveHelp,
  formatInteractiveTitle,
  formatInteractiveTitleSet,
  formatTitleRequiresSavedSession,
  type InteractiveCommand,
  parseInteractiveCommand,
  undoRestoredContextMessage,
} from "./interactive-session/commands.ts";
import {
  addUsage,
  buildSessionCostReport,
  EMPTY_USAGE,
  shouldTrackInteractiveCost,
} from "./interactive-session/cost.ts";
import { readForkPointPickerSelection } from "./interactive-session/fork-picker.ts";
import {
  type GoalContinuationToolExecution,
  goalContinuationStagnationFingerprint,
} from "./interactive-session/goal-stagnation.ts";
import {
  createLineReader,
  type QueuedLine,
  queuedInputIds,
  trimQueuedLine,
} from "./interactive-session/line-reader.ts";
import { executeManualCompaction } from "./interactive-session/manual-compact.ts";
import {
  executeModelSwitchCompaction,
  modelSwitchRequiresCompaction,
} from "./interactive-session/model-switch-compact.ts";
import type {
  EndEvent,
  EndEventWithCost,
  InteractiveReportModelUsage,
  InteractiveResolvedProvider,
  InteractiveSessionOptions,
  InteractiveSessionResult,
  ProviderSelection,
} from "./interactive-session/types.ts";
import { formatUndoCheckpointList, sanitizeStatusLineText } from "./output.ts";
import {
  formatSessionStatusSnapshot,
  formatSessionTasks,
} from "./session-status-format.ts";
import type { SessionModelSelection } from "./session-store.ts";

export type {
  InteractiveForkSessionRequest,
  InteractiveResolvedProvider,
  InteractiveSessionOptions,
  InteractiveSessionResult,
  SessionPersistenceReason,
} from "./interactive-session/types.ts";

function formatActiveModel(resolved: InteractiveResolvedProvider): string {
  return `${resolved.providerId}/${resolved.model}`;
}

function formatModelSelection(selection: SessionModelSelection): string {
  return `${selection.providerId}/${selection.model}`;
}

function formatConfiguredModelSelection(selection: ProviderSelection): string {
  const provider = selection.providerId ?? "(default provider)";
  const model = selection.model ?? "(default model)";
  return `${provider}/${model}`;
}

function formatActiveWorkflowSkill(
  workflowSkill: InteractiveSessionOptions["workflowSkill"],
): string {
  if (workflowSkill === undefined) {
    return "No workflow skill selected.\n";
  }
  return `Workflow skill: ${workflowSkill.name} (${workflowSkill.relativePath})\n`;
}

function systemPromptWithSessionGoal(
  systemPrompt: string,
  goal: SessionGoal | undefined,
  bashToolVisible: boolean,
): string {
  const goalPrompt = activeSessionGoalSystemPrompt(goal, { bashToolVisible });
  if (goalPrompt === null) {
    return systemPrompt;
  }
  return `${systemPrompt}\n\n${goalPrompt}`;
}

const GOAL_CONTINUATION_MESSAGE = [
  '<keel_runtime_context source="goal_continuation">',
  "Keel runtime goal continuation.",
  "Continue working toward the active saved session goal.",
  "This is runtime-generated continuation context, not a new user request.",
  "Do not treat it as user approval, user evidence, or a user-owned lifecycle command.",
  "</keel_runtime_context>",
].join("\n");

const GOAL_STAGNATION_RECOVERY_MATCH_LIMIT = 3;
const DEFAULT_GOAL_AUTOMATIC_CONTINUATION_TURN_LIMIT = 100;

const GOAL_STAGNATION_RECOVERY_MESSAGE = [
  '<keel_runtime_context source="goal_stagnation_recovery">',
  "Keel runtime goal continuation recovery.",
  "The recent automatic goal continuations repeated the same tool calls and results.",
  "No workspace checkpoint, task progress, or goal state change was observed.",
  "Reassess the blocker and choose a materially different next action.",
  "This is runtime-generated recovery context, not a new user request.",
  "Do not treat it as user approval, user evidence, or a user-owned lifecycle command.",
  "</keel_runtime_context>",
].join("\n");

const GOAL_BUDGET_LIMIT_REASON =
  "Session cost budget was reached before the active goal completed.";

function resolveGoalAutomaticContinuationTurnLimit(
  limit: number | undefined,
): number {
  if (limit === undefined) {
    return DEFAULT_GOAL_AUTOMATIC_CONTINUATION_TURN_LIMIT;
  }
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error(
      "goalAutomaticContinuationTurnLimit must be a positive safe integer.",
    );
  }
  return limit;
}

function formatGoalTurnLimitReason(limit: number): string {
  return `Automatic goal continuation stopped after ${limit} continuation turns without completing the active goal.`;
}

const NON_GIT_DIFF_MESSAGE =
  "Not in a git work tree. /diff can only inspect changes inside a Git repository.";

interface PromptTurnRequest {
  readonly userMessage: string;
  readonly consumedInputLines: readonly QueuedLine[];
}

interface PromptTurnResult {
  readonly aborted: boolean;
  readonly budgetExceeded: boolean;
  readonly stagnationFingerprint: string | null;
}

type InteractiveDiffInspection =
  | {
      readonly kind: "non-git";
      readonly message: string;
    }
  | {
      readonly kind: "status-only";
      readonly statusOutput: string;
    }
  | {
      readonly kind: "status-and-diff";
      readonly statusOutput: string;
      readonly diffOutput: string;
    };

function formatInteractiveDiffOutput(
  inspection: InteractiveDiffInspection,
): string {
  switch (inspection.kind) {
    case "non-git":
      return `${inspection.message}\n`;
    case "status-only":
      return `${inspection.statusOutput}\n`;
    case "status-and-diff":
      return `${inspection.statusOutput}\n\n${inspection.diffOutput}\n`;
  }
}

async function inspectInteractiveDiff(
  workspace: string,
): Promise<InteractiveDiffInspection> {
  const status = await executeGitStatus(workspace);
  if (!status.inGitWorkTree) {
    return { kind: "non-git", message: NON_GIT_DIFF_MESSAGE };
  }
  const diff = await executeGitDiff(workspace, { mode: "all" });
  if (!diff.hasChanges) {
    return { kind: "status-only", statusOutput: status.content };
  }
  return {
    kind: "status-and-diff",
    statusOutput: status.content,
    diffOutput: diff.content,
  };
}

function modelSwitchUnknownContextMessage(
  target: InteractiveResolvedProvider,
): string | null {
  if (
    (target.modelMetadata !== undefined &&
      target.modelMetadata.status !== "unknown") ||
    target.contextCompaction !== undefined
  ) {
    return null;
  }
  return `Error: cannot switch to ${formatActiveModel(target)} because model metadata is unavailable; set KEEL_CONTEXT_WINDOW_TOKENS to configure the target context window.`;
}

function modelSelectionFromResolved(
  resolved: InteractiveResolvedProvider,
): SessionModelSelection {
  return {
    providerId: resolved.providerId,
    model: resolved.model,
  };
}

function resolveSelectedProvider(
  options: InteractiveSessionOptions,
  userMessage: string,
  selection?: ProviderSelection,
): InteractiveResolvedProvider {
  const next = options.resolveProvider(userMessage, selection);
  if (shouldTrackInteractiveCost(options.cliArgs)) {
    options.requireKnownCostModel(next);
  }
  return next;
}

export async function runInteractiveSession(
  options: InteractiveSessionOptions,
): Promise<InteractiveSessionResult> {
  const now = options.now ?? Date.now;
  const systemPrompt = buildAgentSystemPrompt({
    workspace: options.workspace,
    platform: options.platform,
    ...(options.projectInstructions !== undefined
      ? { projectInstructions: options.projectInstructions }
      : {}),
    ...(options.workflowSkill !== undefined
      ? { workflowSkill: options.workflowSkill }
      : {}),
  });
  const messages: Message[] = [...(options.initialMessages ?? [])];
  let taskProgress = copySessionTaskProgress(
    options.initialTaskProgress ?? emptySessionTaskProgress(),
  );
  let sessionTitle = options.initialSessionTitle;
  let sessionGoal =
    options.initialSessionGoal === undefined
      ? undefined
      : copySessionGoal(options.initialSessionGoal);
  const currentSystemPrompt = (): string =>
    systemPromptWithSessionGoal(
      systemPrompt,
      sessionGoal,
      bashModeExposesTool(options.cliArgs.bashMode),
    );
  const updateTaskProgress = (next: SessionTaskProgress): void => {
    taskProgress = copySessionTaskProgress(next);
  };
  const updateSessionGoal = (next: SessionGoal): void => {
    sessionGoal = copySessionGoal(next);
  };
  const observeAgentStateEvents = async function* (
    stream: AsyncIterable<AgentEvent>,
    onToolEnd: (toolExecution: GoalContinuationToolExecution) => void,
    onTaskProgressUpdate: (
      next: SessionTaskProgress,
      messageOrdinal: number,
    ) => void,
    onSessionGoalUpdate: (next: SessionGoal) => void,
  ): AsyncGenerator<AgentEvent> {
    for await (const event of stream) {
      if (event.type === "tool_end") {
        onToolEnd({ toolCall: event.toolCall, ok: event.ok });
      } else if (event.type === "task_progress_updated") {
        onTaskProgressUpdate(event.taskProgress, event.messageOrdinal);
      } else if (event.type === "session_goal_updated") {
        onSessionGoalUpdate(event.goal);
      }
      yield event;
    }
  };
  let resolved: InteractiveResolvedProvider | null = null;
  let inactiveBashApprovalGrants: BashApprovalGrant[] = [
    ...(options.initialBashApprovalGrants ?? []),
  ];
  let activeProjectBashApprovalGrants: BashProjectApprovalGrant[] = [
    ...(options.initialProjectBashApprovalGrants ?? []),
  ];
  const appendProjectBashApprovalGrant = (
    grant: BashProjectApprovalGrant,
  ): void => {
    activeProjectBashApprovalGrants = [
      ...activeProjectBashApprovalGrants,
      {
        projectRoot: grant.projectRoot,
        cwd: grant.cwd,
        argvPrefix: [...grant.argvPrefix],
      },
    ];
  };
  const input = createInterface({
    input: options.input,
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  const lineReader = createLineReader(input, {
    ...(options.initialQueuedInputs !== undefined
      ? { initialQueuedInputs: options.initialQueuedInputs }
      : {}),
    ...(options.initialInputLines !== undefined
      ? { initialInputLines: options.initialInputLines }
      : {}),
    ...(options.persistQueuedInput !== undefined
      ? { persistQueuedInput: options.persistQueuedInput }
      : {}),
  });
  const bashPermission = interactiveBashPermissionPolicy(
    options.cliArgs.bashMode,
    lineReader,
    options.writeStderr,
    {
      ...(options.initialBashApprovalGrants !== undefined
        ? { initialGrants: options.initialBashApprovalGrants }
        : {}),
      onGrant: (grant) => {
        options.persistBashApprovalGrant?.(grant);
      },
      ...(options.projectRoot !== undefined
        ? { projectRoot: options.projectRoot }
        : {}),
      initialProjectGrants: activeProjectBashApprovalGrants,
      onProjectGrant: (grant) => {
        appendProjectBashApprovalGrant(grant);
        options.persistProjectBashApprovalGrant?.(grant);
      },
    },
  );
  const activeBashApprovalGrants = (): readonly BashApprovalGrant[] =>
    bashPermission?.grants() ?? inactiveBashApprovalGrants;
  const revokeBashApprovalGrant = (grant: BashApprovalGrant): void => {
    if (bashPermission !== undefined) {
      bashPermission.revokeGrant(grant);
      return;
    }
    const key = bashApprovalGrantKey(grant);
    inactiveBashApprovalGrants = inactiveBashApprovalGrants.filter(
      (approvalGrant) => bashApprovalGrantKey(approvalGrant) !== key,
    );
  };
  const clearBashApprovalGrants = (): readonly BashApprovalGrant[] => {
    if (bashPermission !== undefined) {
      return bashPermission.clearGrants();
    }
    const cleared = inactiveBashApprovalGrants;
    inactiveBashApprovalGrants = [];
    return cleared;
  };
  let activeAbortController: AbortController | null = null;
  let sessionUsage = EMPTY_USAGE;
  let sessionTurns = 0;
  let sessionCostUsd = 0;
  let sessionStopReason = "completed";
  let modelSwitchCount = options.initialModelSwitchCount ?? 0;
  const reportUsageByModel = new Map<string, InteractiveReportModelUsage>();
  const reportModelKey = (selection: SessionModelSelection): string =>
    `${selection.providerId}/${selection.model}`;
  const recordReportUsage = (
    selection: SessionModelSelection,
    usage: Usage,
    turns: number,
    costUsd: number,
  ) => {
    const key = reportModelKey(selection);
    const current = reportUsageByModel.get(key);
    if (current === undefined) {
      reportUsageByModel.set(key, {
        provider: selection.providerId,
        model: selection.model,
        turns,
        usage,
        costUsd,
      });
      return;
    }
    reportUsageByModel.set(key, {
      provider: current.provider,
      model: current.model,
      turns: current.turns + turns,
      usage: addUsage(current.usage, usage),
      costUsd: current.costUsd + costUsd,
    });
  };
  const resolveActiveProvider = (
    userMessage: string,
  ): InteractiveResolvedProvider => {
    resolved ??= options.resolveProvider(
      userMessage,
      options.initialModelSelection,
    );
    return resolved;
  };
  const resolvedForUsageAttribution = (): InteractiveResolvedProvider => {
    /* v8 ignore next 3: usage is only recorded during resolved provider turns or compactions. */
    if (resolved === null) {
      throw new Error(
        "internal: cannot attribute usage before model resolution",
      );
    }
    return resolved;
  };
  const restoreDrainedInput = (lines: readonly QueuedLine[]) => {
    if (lines.length === 0) {
      return;
    }
    lineReader.restoreLines(lines);
  };
  const consumeQueuedInputLines = (lines: readonly QueuedLine[]) => {
    const inputIds = queuedInputIds(lines);
    if (inputIds.length === 0) {
      return;
    }
    options.consumeQueuedInputs?.(inputIds);
  };
  const abortActiveTurn = () => {
    if (activeAbortController !== null) {
      if (activeAbortController.signal.aborted) {
        options.writeStdout("\n");
        options.forceExit(130);
      }
      activeAbortController.abort();
      return;
    }
    options.writeStdout("\n");
    options.setExitCode(130);
    input.close();
  };
  const currentSessionCostReport = (): CostReport =>
    buildSessionCostReport(sessionCostUsd, options.cliArgs.maxCostUsd);
  const currentReportEnd = (): EndEventWithCost | undefined => {
    if (sessionTurns === 0) {
      return undefined;
    }
    return {
      type: "end",
      usage: sessionUsage,
      turns: sessionTurns,
      stopReason:
        sessionStopReason === "cost_budget"
          ? "cost_budget"
          : sessionGoal?.status === "budget_limited"
            ? "goal_budget"
            : sessionStopReason,
      cost: currentSessionCostReport(),
    };
  };
  const remainingMaxCostUsd = (): number | undefined => {
    if (options.cliArgs.maxCostUsd === undefined) {
      return undefined;
    }
    return Math.max(0, options.cliArgs.maxCostUsd - sessionCostUsd);
  };
  const activeModelStatus = (): string =>
    resolved === null
      ? options.initialModelSelection === undefined
        ? options.configuredModelSelection === undefined
          ? "(default for next prompt)"
          : formatConfiguredModelSelection(options.configuredModelSelection)
        : formatModelSelection(options.initialModelSelection)
      : formatActiveModel(resolved);
  const statusRecoveryActions = () => [
    ...(options.sessionId === undefined ||
    options.sessionResumeAvailable?.() === false
      ? []
      : [
          {
            label: "resume",
            command: `keel --resume ${options.sessionId}`,
          },
        ]),
    ...(options.listForkPoints === undefined
      ? []
      : [
          {
            label: "fork-points",
            command: "/fork-points",
          },
        ]),
    {
      label: "undo-list",
      command: "/undo --list",
    },
  ];
  const recordCompactionCost = (
    usage: Usage,
    costModel: CostModel,
  ): CostReport => {
    const costUsd = calculateRequestCostBatchUsd(
      { requests: [{ usage }] },
      costModel,
    );
    sessionUsage = addUsage(sessionUsage, usage);
    sessionCostUsd += costUsd;
    recordReportUsage(
      modelSelectionFromResolved(resolvedForUsageAttribution()),
      usage,
      0,
      costUsd,
    );
    return currentSessionCostReport();
  };
  const recordTurnEnd = (end: EndEvent): CostReport | undefined => {
    sessionUsage = addUsage(sessionUsage, end.usage);
    sessionTurns += end.turns;
    sessionStopReason = end.stopReason;
    const turnCostUsd = end.cost?.spentUsd ?? 0;
    recordReportUsage(
      modelSelectionFromResolved(resolvedForUsageAttribution()),
      end.usage,
      end.turns,
      turnCostUsd,
    );
    if (end.cost === undefined) {
      return undefined;
    }
    sessionCostUsd += turnCostUsd;
    return currentSessionCostReport();
  };
  const readVisibility = createReadVisibilityState();
  const projectInstructionVisibility = createProjectInstructionVisibilityState(
    options.workspace,
  );
  let postCompactionReadSequence = 0;
  const limitActiveGoal = (
    status: "budget_limited" | "usage_limited",
    reason: string,
  ): void => {
    const activeGoal = sessionGoal;
    if (activeGoal?.status !== "active") {
      return;
    }
    const criterion =
      activeGoal.criterionKind !== undefined &&
      activeGoal.completionCriterion !== undefined
        ? {
            criterionKind: activeGoal.criterionKind,
            completionCriterion: activeGoal.completionCriterion,
          }
        : {};
    const limitedGoal: SessionGoal =
      status === "budget_limited"
        ? {
            objective: activeGoal.objective,
            status: "budget_limited",
            statusReason: reason,
            ...sessionGoalAccounting(activeGoal),
            ...criterion,
          }
        : {
            objective: activeGoal.objective,
            status: "usage_limited",
            statusReason: reason,
            ...sessionGoalAccounting(activeGoal),
            ...criterion,
          };
    updateSessionGoal(limitedGoal);
    const persistedGoal = options.persistSessionGoal?.({
      goal: limitedGoal,
      consumedInputIds: [],
    });
    let displayedGoal: SessionGoal = limitedGoal;
    if (persistedGoal !== undefined) {
      updateSessionGoal(persistedGoal);
      displayedGoal = persistedGoal;
    }
    options.writeStderr(
      `Session goal: ${sanitizeStatusLineText(formatSessionGoalSummary(displayedGoal))}\n`,
    );
  };
  const runPromptTurn = async (
    request: PromptTurnRequest,
  ): Promise<PromptTurnResult> => {
    const goalTurnStartedAt = sessionGoal?.status === "active" ? now() : null;
    resolved = resolveActiveProvider(request.userMessage);
    const messagesBeforeTurn = messages.slice();
    const taskProgressBeforeTurn = copySessionTaskProgress(taskProgress);
    const sessionGoalBeforeTurn =
      sessionGoal === undefined ? undefined : copySessionGoal(sessionGoal);
    const taskProgressUpdatesDuringTurn: {
      readonly taskProgress: SessionTaskProgress;
      readonly messageOrdinal: number;
    }[] = [];
    const sessionGoalUpdatesDuringTurn: SessionGoal[] = [];
    const projectInstructionPathsBeforeTurnOldestFirst = [
      ...projectInstructionVisibility.visibleInstructionsMostRecentFirst(),
    ]
      .reverse()
      .map((snapshot) => snapshot.instructionPath);
    const checkpointOperations: RecordLastBatchCheckpointOperation[] = [];
    const toolExecutionsDuringTurn: GoalContinuationToolExecution[] = [];
    const turnStartSequence = lineReader.sequence();
    const drainedInjectedLines: QueuedLine[] = [];
    const deferredInputLines: QueuedLine[] = [];
    const turnAbortController = new AbortController();
    activeAbortController = turnAbortController;
    messages.push({ role: "user", content: request.userMessage });
    let deferRemainingInjectedInput = false;
    let taskProgressChanged = false;
    let sessionGoalChanged = false;

    try {
      const remainingCostUsd = remainingMaxCostUsd();
      const stream = observeAgentStateEvents(
        runAgentTurn({
          workspace: options.workspace,
          provider: resolved.provider,
          messages,
          systemPrompt: currentSystemPrompt(),
          signal: turnAbortController.signal,
          allowBash: bashModeExposesTool(options.cliArgs.bashMode),
          stopPolicy: defaultStopPolicy(),
          taskProgress,
          ...(sessionGoal !== undefined ? { sessionGoal } : {}),
          ...(bashPermission !== undefined ? { bashPermission } : {}),
          ...(shouldTrackInteractiveCost(options.cliArgs)
            ? {
                costTracking: {
                  model: options.requireKnownCostModel(resolved),
                  ...(remainingCostUsd !== undefined
                    ? { maxCostUsd: remainingCostUsd }
                    : {}),
                },
              }
            : {}),
          ...(resolved.contextCompaction !== undefined
            ? { contextCompaction: resolved.contextCompaction }
            : {}),
          ...(options.toolOutputArtifacts !== undefined
            ? { toolOutputArtifacts: options.toolOutputArtifacts }
            : {}),
          readVisibility,
          projectInstructionVisibility,
          recordCheckpointOperations: (operations) => {
            checkpointOperations.push(...operations);
          },
          drainInjectedUserMessages: () => {
            const queuedLines = lineReader
              .drainLinesAfter(turnStartSequence)
              .map(trimQueuedLine)
              .filter((queuedLine) => queuedLine.line !== "");
            if (deferRemainingInjectedInput) {
              deferredInputLines.push(...queuedLines);
              return [];
            }
            const firstCommandIndex = queuedLines.findIndex(
              (queuedLine) => parseInteractiveCommand(queuedLine.line) !== null,
            );
            const injectableLines =
              firstCommandIndex < 0
                ? queuedLines
                : queuedLines.slice(0, firstCommandIndex);
            drainedInjectedLines.push(...injectableLines);
            if (firstCommandIndex >= 0) {
              deferRemainingInjectedInput = true;
              deferredInputLines.push(...queuedLines.slice(firstCommandIndex));
            }
            return injectableLines.map((content) => ({
              role: "user",
              content: content.line,
            }));
          },
        }),
        (toolExecution) => {
          toolExecutionsDuringTurn.push(toolExecution);
        },
        (next, messageOrdinal) => {
          if (!sessionTaskProgressesEqual(next, taskProgress)) {
            taskProgressChanged = true;
          }
          updateTaskProgress(next);
          taskProgressUpdatesDuringTurn.push({
            taskProgress: copySessionTaskProgress(next),
            messageOrdinal,
          });
        },
        (next) => {
          /* v8 ignore next -- session_goal_updated requires an existing active goal; keep the closure fail-safe if that event contract changes. */
          if (
            sessionGoal === undefined ||
            !sessionGoalsEqual(next, sessionGoal)
          ) {
            sessionGoalChanged = true;
          }
          updateSessionGoal(next);
          sessionGoalUpdatesDuringTurn.push(copySessionGoal(next));
        },
      );
      const finalEnd = await options.printAgentEvents(stream);
      if (turnAbortController.signal.aborted) {
        messages.splice(0, messages.length, ...messagesBeforeTurn);
        updateTaskProgress(taskProgressBeforeTurn);
        sessionGoal =
          sessionGoalBeforeTurn === undefined
            ? undefined
            : copySessionGoal(sessionGoalBeforeTurn);
        projectInstructionVisibility.clear();
        projectInstructionVisibility.markInstructionPathsVisible(
          projectInstructionPathsBeforeTurnOldestFirst,
        );
        const restoredLines = [...drainedInjectedLines, ...deferredInputLines];
        restoreDrainedInput(restoredLines);
        consumeQueuedInputLines(request.consumedInputLines);
        options.writeStdout("\n");
        return {
          aborted: true,
          budgetExceeded: false,
          stagnationFingerprint: null,
        };
      }
      restoreDrainedInput(deferredInputLines);
      options.persistSessionMessages?.(messages, "turn", [
        ...queuedInputIds(request.consumedInputLines),
        ...queuedInputIds(drainedInjectedLines),
      ]);
      if (options.persistTaskProgress !== undefined) {
        let lastPersistedTurnProgress = taskProgressBeforeTurn;
        for (const update of taskProgressUpdatesDuringTurn) {
          if (
            sessionTaskProgressesEqual(
              update.taskProgress,
              lastPersistedTurnProgress,
            )
          ) {
            continue;
          }
          options.persistTaskProgress(update);
          lastPersistedTurnProgress = copySessionTaskProgress(
            update.taskProgress,
          );
        }
      }
      if (options.persistSessionGoal !== undefined) {
        for (const goal of sessionGoalUpdatesDuringTurn) {
          sessionGoal = options.persistSessionGoal({
            goal,
            consumedInputIds: [],
          });
        }
      }
      options.writeStdout("\n");
      if (goalTurnStartedAt !== null && sessionGoal !== undefined) {
        const accountedGoal = accountSessionGoalTurn(sessionGoal, {
          tokens:
            (finalEnd?.usage.inputTokens ?? 0) +
            (finalEnd?.usage.outputTokens ?? 0),
          activeTimeMs: Math.max(0, Math.floor(now() - goalTurnStartedAt)),
        });
        updateSessionGoal(accountedGoal);
        const budgetLimitReason =
          accountedGoal.status === "active"
            ? formatSessionGoalBudgetLimitReason(accountedGoal)
            : null;
        if (budgetLimitReason !== null) {
          limitActiveGoal("budget_limited", budgetLimitReason);
        } else {
          const persistedAccountedGoal = options.persistSessionGoal?.({
            goal: accountedGoal,
            consumedInputIds: [],
          });
          if (persistedAccountedGoal !== undefined) {
            updateSessionGoal(persistedAccountedGoal);
          }
        }
      }
      const cumulativeCost =
        finalEnd === undefined ? undefined : recordTurnEnd(finalEnd);
      if (
        options.cliArgs.maxCostUsd !== undefined &&
        cumulativeCost !== undefined
      ) {
        options.writeStderr(
          options.formatCostReport(cumulativeCost, options.cliArgs.maxCostUsd),
        );
      }
      if (cumulativeCost?.budgetExceeded === true) {
        sessionStopReason = "cost_budget";
        limitActiveGoal("budget_limited", GOAL_BUDGET_LIMIT_REASON);
        return {
          aborted: false,
          budgetExceeded: true,
          stagnationFingerprint: null,
        };
      }
      return {
        aborted: false,
        budgetExceeded: false,
        stagnationFingerprint: goalContinuationStagnationFingerprint({
          messages,
          toolExecutions: toolExecutionsDuringTurn,
          stateChanged:
            taskProgressChanged ||
            sessionGoalChanged ||
            checkpointOperations.length > 0 ||
            drainedInjectedLines.length > 0,
        }),
      };
    } catch (error) {
      if (!turnAbortController.signal.aborted) {
        throw error;
      }
      messages.splice(0, messages.length, ...messagesBeforeTurn);
      updateTaskProgress(taskProgressBeforeTurn);
      sessionGoal =
        sessionGoalBeforeTurn === undefined
          ? undefined
          : copySessionGoal(sessionGoalBeforeTurn);
      projectInstructionVisibility.clear();
      projectInstructionVisibility.markInstructionPathsVisible(
        projectInstructionPathsBeforeTurnOldestFirst,
      );
      const restoredLines = [...drainedInjectedLines, ...deferredInputLines];
      restoreDrainedInput(restoredLines);
      consumeQueuedInputLines(request.consumedInputLines);
      options.writeStdout("\n");
      return {
        aborted: true,
        budgetExceeded: false,
        stagnationFingerprint: null,
      };
    } finally {
      if (checkpointOperations.length > 0) {
        recordLastTaskCheckpoint({
          workspace: options.workspace,
          operations: checkpointOperations,
        });
      }
      activeAbortController = null;
    }
  };
  const runAutomaticGoalContinuations = async (): Promise<boolean> => {
    const automaticContinuationTurnLimit =
      resolveGoalAutomaticContinuationTurnLimit(
        options.goalAutomaticContinuationTurnLimit,
      );
    let continuationTurns = 0;
    let previousStagnationFingerprint: string | null = null;
    let matchingStagnationFingerprints = 0;
    let nextContinuationMessage = GOAL_CONTINUATION_MESSAGE;
    const recoveryHintedFingerprints = new Set<string>();
    while (
      sessionGoal?.status === "active" &&
      lineReader.pendingInputCount() === 0
    ) {
      if (continuationTurns >= automaticContinuationTurnLimit) {
        limitActiveGoal(
          "usage_limited",
          formatGoalTurnLimitReason(automaticContinuationTurnLimit),
        );
        return false;
      }
      const userMessage = nextContinuationMessage;
      nextContinuationMessage = GOAL_CONTINUATION_MESSAGE;
      const result = await runPromptTurn({
        userMessage,
        consumedInputLines: [],
      });
      if (result.aborted) {
        return false;
      }
      if (result.budgetExceeded) {
        return true;
      }
      continuationTurns++;
      if (sessionGoal?.status !== "active") {
        return false;
      }
      if (result.stagnationFingerprint === null) {
        previousStagnationFingerprint = null;
        matchingStagnationFingerprints = 0;
      } else if (
        result.stagnationFingerprint === previousStagnationFingerprint
      ) {
        matchingStagnationFingerprints++;
      } else {
        previousStagnationFingerprint = result.stagnationFingerprint;
        matchingStagnationFingerprints = 1;
      }
      if (
        result.stagnationFingerprint !== null &&
        matchingStagnationFingerprints >=
          GOAL_STAGNATION_RECOVERY_MATCH_LIMIT &&
        !recoveryHintedFingerprints.has(result.stagnationFingerprint)
      ) {
        recoveryHintedFingerprints.add(result.stagnationFingerprint);
        nextContinuationMessage = GOAL_STAGNATION_RECOVERY_MESSAGE;
      }
    }
    return false;
  };

  options.onSigint(abortActiveTurn);
  try {
    for (;;) {
      if (lineReader.needsInput()) {
        options.renderPrompt?.();
      }
      const rawInput = await lineReader.readLine();
      if (rawInput === null) {
        options.closePrompt?.();
        break;
      }
      options.acceptInput?.();
      const rawLine = rawInput.line;
      const userMessage = rawLine.trim();
      if (userMessage === "") {
        consumeQueuedInputLines([rawInput]);
        continue;
      }
      const interactiveCommand = parseInteractiveCommand(rawLine);
      if (interactiveCommand?.kind === "help") {
        options.writeStdout(formatInteractiveHelp());
        consumeQueuedInputLines([rawInput]);
        continue;
      }
      if (interactiveCommand?.kind === "status") {
        options.writeStdout(
          formatSessionStatusSnapshot({
            session: options.sessionId ?? "(ephemeral, not persisted)",
            ...(sessionTitle !== undefined ? { title: sessionTitle } : {}),
            workspace: options.workspace,
            activeModel: activeModelStatus(),
            ...(sessionGoal !== undefined ? { goal: sessionGoal } : {}),
            ...(options.workflowSkill !== undefined
              ? { workflowSkill: options.workflowSkill }
              : {}),
            messages,
            messageCount: messages.length,
            pendingInputCount: lineReader.pendingInputCount(),
            bashApprovalCount:
              activeBashApprovalGrants().length +
              activeProjectBashApprovalGrants.length,
            taskProgress,
            modelSwitchCount,
            undoCheckpoints: listUndoCheckpoints(options.workspace),
            recoveryActions: statusRecoveryActions(),
          }),
        );
        consumeQueuedInputLines([rawInput]);
        continue;
      }
      if (interactiveCommand?.kind === "title") {
        if (interactiveCommand.title === undefined) {
          options.writeStdout(formatInteractiveTitle(sessionTitle));
          consumeQueuedInputLines([rawInput]);
          continue;
        }
        if (options.persistSessionTitle === undefined) {
          options.writeStderr(formatTitleRequiresSavedSession());
          consumeQueuedInputLines([rawInput]);
          continue;
        }
        try {
          sessionTitle = options.persistSessionTitle({
            title: interactiveCommand.title,
            consumedInputIds: queuedInputIds([rawInput]),
          });
          options.writeStdout(formatInteractiveTitleSet(sessionTitle));
        } catch (error) {
          options.writeStderr(formatInteractiveCommandFailure(error));
          consumeQueuedInputLines([rawInput]);
        }
        continue;
      }
      if (interactiveCommand?.kind === "goal") {
        const goalCommand: Extract<
          InteractiveCommand,
          { readonly kind: "goal" }
        > = interactiveCommand;
        switch (goalCommand.action) {
          case "show":
            options.writeStdout(formatInteractiveGoal(sessionGoal));
            consumeQueuedInputLines([rawInput]);
            break;
          case "show_budget":
            options.writeStdout(formatInteractiveGoalBudget(sessionGoal));
            consumeQueuedInputLines([rawInput]);
            break;
          case "set": {
            if (options.persistSessionGoal === undefined) {
              options.writeStderr(formatGoalRequiresSavedSession());
              consumeQueuedInputLines([rawInput]);
              break;
            }
            try {
              const nextGoal: SessionGoal = {
                objective: goalCommand.objective,
                status: "active",
                budget: emptySessionGoalBudget(),
                usage: emptySessionGoalUsage(),
              };
              sessionGoal = options.persistSessionGoal({
                goal: nextGoal,
                consumedInputIds: queuedInputIds([rawInput]),
              });
              options.writeStdout(formatInteractiveGoalSet(nextGoal));
            } catch (error) {
              options.writeStderr(formatInteractiveCommandFailure(error));
              consumeQueuedInputLines([rawInput]);
            }
            break;
          }
          case "pause": {
            if (options.persistSessionGoal === undefined) {
              options.writeStderr(formatGoalRequiresSavedSession());
              consumeQueuedInputLines([rawInput]);
              break;
            }
            if (sessionGoal === undefined) {
              options.writeStderr("Error: no session goal is set.\n");
              consumeQueuedInputLines([rawInput]);
              break;
            }
            if (sessionGoal.status !== "active") {
              options.writeStderr(
                "Error: only active session goals can be paused.\n",
              );
              consumeQueuedInputLines([rawInput]);
              break;
            }
            try {
              const pausedGoal: SessionGoal = {
                objective: sessionGoal.objective,
                status: "paused",
                ...sessionGoalAccounting(sessionGoal),
                ...(sessionGoal.criterionKind !== undefined &&
                sessionGoal.completionCriterion !== undefined
                  ? {
                      criterionKind: sessionGoal.criterionKind,
                      completionCriterion: sessionGoal.completionCriterion,
                    }
                  : {}),
              };
              sessionGoal = options.persistSessionGoal({
                goal: pausedGoal,
                consumedInputIds: queuedInputIds([rawInput]),
              });
              options.writeStdout(formatInteractiveGoalPaused(pausedGoal));
            } catch (error) {
              options.writeStderr(formatInteractiveCommandFailure(error));
              consumeQueuedInputLines([rawInput]);
            }
            break;
          }
          case "resume": {
            if (options.persistSessionGoal === undefined) {
              options.writeStderr(formatGoalRequiresSavedSession());
              consumeQueuedInputLines([rawInput]);
              break;
            }
            if (sessionGoal === undefined) {
              options.writeStderr("Error: no session goal is set.\n");
              consumeQueuedInputLines([rawInput]);
              break;
            }
            if (
              sessionGoal.status !== "paused" &&
              sessionGoal.status !== "blocked" &&
              sessionGoal.status !== "budget_limited" &&
              sessionGoal.status !== "usage_limited"
            ) {
              options.writeStderr(
                "Error: only paused, blocked, or limited session goals can be resumed.\n",
              );
              consumeQueuedInputLines([rawInput]);
              break;
            }
            const budgetLimitReason =
              formatSessionGoalBudgetLimitReason(sessionGoal);
            if (budgetLimitReason !== null) {
              options.writeStderr(
                `Error: ${budgetLimitReason} Raise or clear the goal budget before resuming.\n`,
              );
              consumeQueuedInputLines([rawInput]);
              break;
            }
            try {
              const resumedGoal: SessionGoal = {
                objective: sessionGoal.objective,
                status: "active",
                ...sessionGoalAccounting(sessionGoal),
                ...(sessionGoal.criterionKind !== undefined &&
                sessionGoal.completionCriterion !== undefined
                  ? {
                      criterionKind: sessionGoal.criterionKind,
                      completionCriterion: sessionGoal.completionCriterion,
                    }
                  : {}),
              };
              sessionGoal = options.persistSessionGoal({
                goal: resumedGoal,
                consumedInputIds: queuedInputIds([rawInput]),
              });
              options.writeStdout(formatInteractiveGoalResumed(resumedGoal));
            } catch (error) {
              options.writeStderr(formatInteractiveCommandFailure(error));
              consumeQueuedInputLines([rawInput]);
            }
            break;
          }
          case "budget": {
            if (options.persistSessionGoal === undefined) {
              options.writeStderr(formatGoalRequiresSavedSession());
              consumeQueuedInputLines([rawInput]);
              break;
            }
            if (sessionGoal === undefined) {
              options.writeStderr("Error: no session goal is set.\n");
              consumeQueuedInputLines([rawInput]);
              break;
            }
            if (sessionGoal.status === "completed") {
              options.writeStderr(
                "Error: completed session goals cannot change budgets. Set a new goal first.\n",
              );
              consumeQueuedInputLines([rawInput]);
              break;
            }
            try {
              let budgetedGoal: SessionGoal = {
                ...copySessionGoal(sessionGoal),
                budget: {
                  ...sessionGoal.budget,
                  ...goalCommand.budget,
                },
              };
              if (budgetedGoal.status === "active") {
                const reason = formatSessionGoalBudgetLimitReason(budgetedGoal);
                if (reason !== null) {
                  const criterion =
                    budgetedGoal.criterionKind !== undefined &&
                    budgetedGoal.completionCriterion !== undefined
                      ? {
                          criterionKind: budgetedGoal.criterionKind,
                          completionCriterion: budgetedGoal.completionCriterion,
                        }
                      : {};
                  budgetedGoal = {
                    objective: budgetedGoal.objective,
                    status: "budget_limited",
                    statusReason: reason,
                    ...sessionGoalAccounting(budgetedGoal),
                    ...criterion,
                  };
                }
              }
              sessionGoal = options.persistSessionGoal({
                goal: budgetedGoal,
                consumedInputIds: queuedInputIds([rawInput]),
              });
              options.writeStdout(
                formatInteractiveGoalBudgetUpdated(budgetedGoal),
              );
            } catch (error) {
              options.writeStderr(formatInteractiveCommandFailure(error));
              consumeQueuedInputLines([rawInput]);
            }
            break;
          }
          case "clear_budget": {
            if (options.persistSessionGoal === undefined) {
              options.writeStderr(formatGoalRequiresSavedSession());
              consumeQueuedInputLines([rawInput]);
              break;
            }
            if (sessionGoal === undefined) {
              options.writeStderr("Error: no session goal is set.\n");
              consumeQueuedInputLines([rawInput]);
              break;
            }
            if (sessionGoal.status === "completed") {
              options.writeStderr(
                "Error: completed session goals cannot change budgets. Set a new goal first.\n",
              );
              consumeQueuedInputLines([rawInput]);
              break;
            }
            try {
              const clearedGoal: SessionGoal = {
                ...copySessionGoal(sessionGoal),
                budget: emptySessionGoalBudget(),
              };
              sessionGoal = options.persistSessionGoal({
                goal: clearedGoal,
                consumedInputIds: queuedInputIds([rawInput]),
              });
              options.writeStdout(
                formatInteractiveGoalBudgetCleared(clearedGoal),
              );
            } catch (error) {
              options.writeStderr(formatInteractiveCommandFailure(error));
              consumeQueuedInputLines([rawInput]);
            }
            break;
          }
          case "complete": {
            if (options.persistSessionGoal === undefined) {
              options.writeStderr(formatGoalRequiresSavedSession());
              consumeQueuedInputLines([rawInput]);
              break;
            }
            if (sessionGoal === undefined) {
              options.writeStderr("Error: no session goal is set.\n");
              consumeQueuedInputLines([rawInput]);
              break;
            }
            try {
              const completedGoal: SessionGoal = {
                objective: sessionGoal.objective,
                status: "completed",
                completionEvidence: { kind: "user_override" },
                ...sessionGoalAccounting(sessionGoal),
                ...(sessionGoal.criterionKind !== undefined &&
                sessionGoal.completionCriterion !== undefined
                  ? {
                      criterionKind: sessionGoal.criterionKind,
                      completionCriterion: sessionGoal.completionCriterion,
                    }
                  : {}),
              };
              sessionGoal = options.persistSessionGoal({
                goal: completedGoal,
                consumedInputIds: queuedInputIds([rawInput]),
              });
              options.writeStdout(
                formatInteractiveGoalCompleted(completedGoal),
              );
            } catch (error) {
              options.writeStderr(formatInteractiveCommandFailure(error));
              consumeQueuedInputLines([rawInput]);
            }
            break;
          }
          case "verify": {
            if (options.persistSessionGoal === undefined) {
              options.writeStderr(formatGoalRequiresSavedSession());
              consumeQueuedInputLines([rawInput]);
              break;
            }
            if (sessionGoal === undefined) {
              options.writeStderr("Error: no session goal is set.\n");
              consumeQueuedInputLines([rawInput]);
              break;
            }
            if (sessionGoal.status !== "active") {
              options.writeStderr(
                "Error: only active session goals can change the completion criterion. Resume the goal or set a new goal first.\n",
              );
              consumeQueuedInputLines([rawInput]);
              break;
            }
            try {
              const verifiedGoal = {
                objective: sessionGoal.objective,
                status: "active",
                ...sessionGoalAccounting(sessionGoal),
                criterionKind: "command",
                completionCriterion: goalCommand.command,
              } satisfies SessionGoal & {
                readonly criterionKind: "command";
                readonly completionCriterion: string;
              };
              sessionGoal = options.persistSessionGoal({
                goal: verifiedGoal,
                consumedInputIds: queuedInputIds([rawInput]),
              });
              options.writeStdout(
                formatInteractiveGoalVerificationSet(verifiedGoal, {
                  bashToolVisible: bashModeExposesTool(
                    options.cliArgs.bashMode,
                  ),
                }),
              );
            } catch (error) {
              options.writeStderr(formatInteractiveCommandFailure(error));
              consumeQueuedInputLines([rawInput]);
            }
            break;
          }
          case "criterion": {
            if (options.persistSessionGoal === undefined) {
              options.writeStderr(formatGoalRequiresSavedSession());
              consumeQueuedInputLines([rawInput]);
              break;
            }
            if (sessionGoal === undefined) {
              options.writeStderr("Error: no session goal is set.\n");
              consumeQueuedInputLines([rawInput]);
              break;
            }
            if (sessionGoal.status !== "active") {
              options.writeStderr(
                "Error: only active session goals can change the completion criterion. Resume the goal or set a new goal first.\n",
              );
              consumeQueuedInputLines([rawInput]);
              break;
            }
            try {
              const goalWithCriterion = {
                objective: sessionGoal.objective,
                status: "active",
                ...sessionGoalAccounting(sessionGoal),
                criterionKind: goalCommand.criterionKind,
                completionCriterion: goalCommand.criterion,
              } satisfies SessionGoal;
              sessionGoal = options.persistSessionGoal({
                goal: goalWithCriterion,
                consumedInputIds: queuedInputIds([rawInput]),
              });
              options.writeStdout(
                formatInteractiveGoalCriterionSet(goalWithCriterion),
              );
            } catch (error) {
              options.writeStderr(formatInteractiveCommandFailure(error));
              consumeQueuedInputLines([rawInput]);
            }
            break;
          }
          case "clear":
            if (options.persistSessionGoal === undefined) {
              options.writeStderr(formatGoalRequiresSavedSession());
              consumeQueuedInputLines([rawInput]);
              break;
            }
            try {
              sessionGoal = options.persistSessionGoal({
                goal: null,
                consumedInputIds: queuedInputIds([rawInput]),
              });
              options.writeStdout(formatInteractiveGoalCleared());
            } catch (error) {
              options.writeStderr(formatInteractiveCommandFailure(error));
              consumeQueuedInputLines([rawInput]);
            }
            break;
        }
        continue;
      }
      if (interactiveCommand?.kind === "tasks") {
        options.writeStdout(formatSessionTasks(taskProgress));
        consumeQueuedInputLines([rawInput]);
        continue;
      }
      if (interactiveCommand?.kind === "diff") {
        try {
          options.writeStdout(
            formatInteractiveDiffOutput(
              await inspectInteractiveDiff(options.workspace),
            ),
          );
        } catch (error) {
          options.writeStderr(formatInteractiveCommandFailure(error));
        }
        consumeQueuedInputLines([rawInput]);
        continue;
      }
      if (interactiveCommand?.kind === "approvals") {
        const approvalsCommand: Extract<
          InteractiveCommand,
          { readonly kind: "approvals" }
        > = interactiveCommand;
        switch (approvalsCommand.action) {
          case "list":
            options.writeStdout(
              [
                formatBashApprovalList(activeBashApprovalGrants()),
                formatBashProjectApprovalList(activeProjectBashApprovalGrants),
              ].join(""),
            );
            consumeQueuedInputLines([rawInput]);
            break;
          case "clear": {
            const cleared = clearBashApprovalGrants();
            if (options.persistBashApprovalsCleared !== undefined) {
              options.persistBashApprovalsCleared({
                consumedInputIds: queuedInputIds([rawInput]),
              });
            } else {
              consumeQueuedInputLines([rawInput]);
            }
            options.writeStdout(formatBashApprovalClearResult(cleared.length));
            break;
          }
          case "revoke": {
            const grants = activeBashApprovalGrants();
            const grant = grants[approvalsCommand.index - 1];
            if (grant === undefined) {
              options.writeStderr(
                `Error: no bash approval at index ${approvalsCommand.index}.\n`,
              );
              consumeQueuedInputLines([rawInput]);
              break;
            }
            revokeBashApprovalGrant(grant);
            if (options.persistBashApprovalRevoked !== undefined) {
              options.persistBashApprovalRevoked({
                grant,
                consumedInputIds: queuedInputIds([rawInput]),
              });
            } else {
              consumeQueuedInputLines([rawInput]);
            }
            options.writeStdout(
              formatBashApprovalRevoked(approvalsCommand.index),
            );
            break;
          }
        }
        continue;
      }
      if (interactiveCommand?.kind === "invalid") {
        options.writeStderr(`${interactiveCommand.message}\n`);
        consumeQueuedInputLines([rawInput]);
        continue;
      }
      if (interactiveCommand?.kind === "undo") {
        if (interactiveCommand.mode === "list") {
          options.writeStdout(
            formatUndoCheckpointList(listUndoCheckpoints(options.workspace)),
          );
          consumeQueuedInputLines([rawInput]);
          continue;
        }
        const result =
          interactiveCommand.mode === "restore-through"
            ? restoreUndoCheckpointsThrough(
                options.workspace,
                interactiveCommand.checkpointIndex,
              )
            : restoreLastEditCheckpoint(options.workspace);
        switch (result.status) {
          case "restored":
            options.writeStdout(`Restored ${result.restoredLabel}\n`);
            clearReadVisibilityState(readVisibility);
            projectInstructionVisibility.clear();
            messages.push({
              role: "user",
              content: undoRestoredContextMessage(result.restoredLabel),
            });
            if (options.persistSessionMessages !== undefined) {
              options.persistSessionMessages(
                messages,
                "turn",
                queuedInputIds([rawInput]),
              );
            } else {
              consumeQueuedInputLines([rawInput]);
            }
            break;
          case "none":
            options.writeStderr(`${result.message}\n`);
            consumeQueuedInputLines([rawInput]);
            break;
          case "blocked":
            options.writeStderr(`${result.message}\n`);
            consumeQueuedInputLines([rawInput]);
            break;
        }
        continue;
      }
      if (interactiveCommand?.kind === "model") {
        try {
          if (interactiveCommand.selection === undefined) {
            resolved = resolveActiveProvider(userMessage);
            options.writeStdout(
              `Current model: ${formatActiveModel(resolved)}\nUsage: /model <provider>/<model>\n`,
            );
            consumeQueuedInputLines([rawInput]);
            continue;
          }

          let previousResolved: InteractiveResolvedProvider | null =
            resolved ??
            (options.initialModelSelection !== undefined
              ? resolveActiveProvider(userMessage)
              : null);
          if (
            previousResolved !== null &&
            previousResolved.providerId ===
              interactiveCommand.selection.providerId &&
            previousResolved.model === interactiveCommand.selection.model
          ) {
            options.writeStdout(
              `Model already set to ${formatActiveModel(previousResolved)}\n`,
            );
            consumeQueuedInputLines([rawInput]);
            continue;
          }

          const nextResolved = resolveSelectedProvider(
            options,
            userMessage,
            interactiveCommand.selection,
          );
          if (messages.length > 0) {
            const unknownContextMessage =
              modelSwitchUnknownContextMessage(nextResolved);
            if (unknownContextMessage !== null) {
              options.writeStderr(`${unknownContextMessage}\n`);
              consumeQueuedInputLines([rawInput]);
              continue;
            }
          }
          let consumedByPersistence = false;
          let modelSwitchCost: CostReport | undefined;
          if (
            modelSwitchRequiresCompaction({
              systemPrompt: currentSystemPrompt(),
              messages,
              target: nextResolved,
              cliArgs: options.cliArgs,
            })
          ) {
            const currentResolved: InteractiveResolvedProvider =
              previousResolved ?? resolveActiveProvider(userMessage);
            previousResolved = currentResolved;
            resolved = currentResolved;
            const compactAbortController = new AbortController();
            activeAbortController = compactAbortController;
            try {
              const compaction = await executeModelSwitchCompaction({
                current: currentResolved,
                target: nextResolved,
                workspace: options.workspace,
                messages,
                systemPrompt: currentSystemPrompt(),
                signal: compactAbortController.signal,
                readVisibility,
                projectInstructionVisibility,
                nextPostCompactionReadToolCallId: () =>
                  postCompactionReadToolCallId(postCompactionReadSequence++),
                taskProgress,
                options,
                recordCompactionCost,
              });
              if (compaction.status === "rejected") {
                consumeQueuedInputLines([rawInput]);
                continue;
              }
              modelSwitchCost = compaction.cost;
            } finally {
              activeAbortController = null;
            }
            options.persistSessionMessages?.(
              messages,
              "compaction",
              queuedInputIds([rawInput]),
            );
            consumedByPersistence =
              options.persistSessionMessages !== undefined;
          }
          resolved = nextResolved;
          if (options.persistModelSwitch !== undefined) {
            options.persistModelSwitch({
              from:
                previousResolved === null
                  ? null
                  : modelSelectionFromResolved(previousResolved),
              to: modelSelectionFromResolved(nextResolved),
              consumedInputIds: consumedByPersistence
                ? []
                : queuedInputIds([rawInput]),
            });
            consumedByPersistence = true;
          }
          modelSwitchCount++;
          options.writeStdout(
            `Model switched to ${formatActiveModel(resolved)}\n`,
          );
          if (modelSwitchCost?.budgetExceeded === true) {
            if (!consumedByPersistence) {
              consumeQueuedInputLines([rawInput]);
            }
            sessionStopReason = "cost_budget";
            break;
          }
          if (consumedByPersistence) {
            continue;
          }
        } catch (error) {
          options.writeStderr(formatInteractiveCommandFailure(error));
        }
        consumeQueuedInputLines([rawInput]);
        continue;
      }
      if (interactiveCommand?.kind === "skill") {
        options.writeStdout(formatActiveWorkflowSkill(options.workflowSkill));
        consumeQueuedInputLines([rawInput]);
        continue;
      }
      if (interactiveCommand?.kind === "fork-points") {
        if (options.listForkPoints === undefined) {
          options.writeStderr(formatForkRequiresNamedSession("/fork-points"));
          consumeQueuedInputLines([rawInput]);
          continue;
        }
        options.writeStdout(
          formatInteractiveSessionForkPoints(options.listForkPoints()),
        );
        consumeQueuedInputLines([rawInput]);
        continue;
      }
      if (interactiveCommand?.kind === "compact") {
        if (messages.length === 0) {
          options.writeStderr(
            "Context compaction skipped: no conversation history to compact.\n",
          );
          consumeQueuedInputLines([rawInput]);
          continue;
        }
        const compactResolved = resolveActiveProvider(userMessage);
        const compactAbortController = new AbortController();
        activeAbortController = compactAbortController;
        let compactCost: CostReport | undefined;
        try {
          compactCost = await executeManualCompaction({
            command: interactiveCommand,
            resolved: compactResolved,
            workspace: options.workspace,
            messages,
            systemPrompt: currentSystemPrompt(),
            signal: compactAbortController.signal,
            readVisibility,
            projectInstructionVisibility,
            nextPostCompactionReadToolCallId: () =>
              postCompactionReadToolCallId(postCompactionReadSequence++),
            taskProgress,
            options,
            recordCompactionCost,
          });
        } finally {
          activeAbortController = null;
        }
        if (compactAbortController.signal.aborted) {
          consumeQueuedInputLines([rawInput]);
        } else {
          options.persistSessionMessages?.(
            messages,
            "compaction",
            queuedInputIds([rawInput]),
          );
        }
        if (compactCost?.budgetExceeded === true) {
          sessionStopReason = "cost_budget";
          break;
        }
        continue;
      }
      if (interactiveCommand?.kind === "fork") {
        if (options.forkSession === undefined) {
          options.writeStderr(formatForkRequiresNamedSession("/fork"));
          consumeQueuedInputLines([rawInput]);
          continue;
        }
        if (interactiveCommand.pick === true) {
          if (options.listForkPoints === undefined) {
            options.writeStderr(formatForkRequiresNamedSession("/fork"));
            consumeQueuedInputLines([rawInput]);
            continue;
          }
          const forkPoints = options.listForkPoints();
          options.writeStdout(formatInteractiveForkPicker(forkPoints));
          const pickerResult = await readForkPointPickerSelection({
            maxChoice: forkPoints.points.length,
            lineReader,
            writeStdout: options.writeStdout,
            writeStderr: options.writeStderr,
          });
          const consumedLines = [rawInput, ...pickerResult.consumedLines];
          if (pickerResult.kind === "cancelled") {
            if (pickerResult.explicit) {
              options.writeStdout("Fork cancelled.\n");
            }
            consumeQueuedInputLines(consumedLines);
            continue;
          }
          try {
            const selectedPoint =
              pickerResult.selection.choice === 0
                ? undefined
                : forkPoints.points[pickerResult.selection.choice - 1];
            options.writeStdout(
              options.forkSession({
                targetSessionId: interactiveCommand.targetSessionId,
                ...(selectedPoint !== undefined
                  ? { beforeMessageId: selectedPoint.messageId }
                  : {}),
              }),
            );
          } catch (error) {
            options.writeStderr(formatInteractiveCommandFailure(error));
          }
          consumeQueuedInputLines(consumedLines);
          continue;
        }
        try {
          options.writeStdout(options.forkSession(interactiveCommand));
        } catch (error) {
          options.writeStderr(formatInteractiveCommandFailure(error));
        }
        consumeQueuedInputLines([rawInput]);
        continue;
      }
      const turnResult = await runPromptTurn({
        userMessage,
        consumedInputLines: [rawInput],
      });
      if (turnResult.aborted) {
        continue;
      }
      if (turnResult.budgetExceeded) {
        break;
      }
      if (await runAutomaticGoalContinuations()) {
        break;
      }
    }
  } finally {
    options.offSigint(abortActiveTurn);
    input.close();
  }
  const reportEnd = currentReportEnd();
  if (options.cliArgs.reportFile !== undefined && reportEnd !== undefined) {
    return {
      report: {
        modelsUsed: [...reportUsageByModel.values()].map((entry) => ({
          provider: entry.provider,
          model: entry.model,
        })),
        usageByModel: [...reportUsageByModel.values()],
        end: reportEnd,
      },
    };
  }
  return {};
}
