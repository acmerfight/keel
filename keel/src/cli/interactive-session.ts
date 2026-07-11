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
import { modelMetadataMaxOutputTokens } from "../core/model-metadata.ts";
import {
  accountSessionGoalTurn,
  activeSessionGoalSystemPrompt,
  copySessionGoal,
  emptySessionGoalBudget,
  emptySessionGoalUsage,
  formatSessionGoalBudgetLimitReason,
  formatSessionGoalSummary,
  pauseActiveSessionGoal,
  type SessionGoal,
  type SessionGoalRuntimeOutcome,
  sessionGoalAccounting,
  sessionGoalCommandMatchesCriterion,
  sessionGoalCompletionContract,
  sessionGoalStatesEqual,
  withSessionGoalRuntimeOutcome,
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
  buildSessionCostBudgetLimitedReport,
  buildSessionCostReport,
  EMPTY_USAGE,
  shouldTrackInteractiveCost,
} from "./interactive-session/cost.ts";
import { readForkPointPickerSelection } from "./interactive-session/fork-picker.ts";
import {
  type GoalContinuationToolExecution,
  goalContinuationStagnationFingerprint,
  repeatedGoalContinuationPattern,
} from "./interactive-session/goal-stagnation.ts";
import { createInteractiveInputDispositionTracker } from "./interactive-session/input-disposition.ts";
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
  InteractiveComposerMode,
  InteractiveReportModelUsage,
  InteractiveResolvedProvider,
  InteractiveSessionOptions,
  InteractiveSessionResult,
  ProviderSelection,
} from "./interactive-session/types.ts";
import {
  formatLiveSessionGoalStatus,
  formatUndoCheckpointList,
  sanitizeStatusLineText,
} from "./output.ts";
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

function preserveLatestSessionGoalRuntimeOutcome<Target extends SessionGoal>(
  source: SessionGoal,
  target: Target,
): Target {
  return source.latestRuntimeOutcome === undefined
    ? target
    : withSessionGoalRuntimeOutcome(target, source.latestRuntimeOutcome);
}

const GOAL_CONTINUATION_MESSAGE = [
  '<keel_runtime_context source="goal_continuation">',
  "Keel runtime goal continuation.",
  "Continue working toward the active saved session goal.",
  "This is runtime-generated continuation context, not a new user request.",
  "Do not treat it as user approval, user evidence, or a user-owned lifecycle command.",
  "</keel_runtime_context>",
].join("\n");

const GOAL_ACTIVATION_MESSAGE = [
  '<keel_runtime_context source="goal_activation">',
  "Keel runtime goal activation.",
  "Begin working toward the active saved session goal now.",
  "This is runtime-generated activation context, not a new user request.",
  "Do not treat it as user approval, user evidence, or a user-owned lifecycle command.",
  "</keel_runtime_context>",
].join("\n");

const GOAL_RESUMPTION_MESSAGE = [
  '<keel_runtime_context source="goal_resumption">',
  "Keel runtime goal resumption.",
  "Resume working toward the active saved session goal now.",
  "This is runtime-generated resumption context, not a new user request.",
  "Do not treat it as user approval, user evidence, or a user-owned lifecycle command.",
  "</keel_runtime_context>",
].join("\n");

const GOAL_STAGNATION_RECOVERY_MATCH_LIMIT = 3;
const GOAL_STAGNATION_MAX_PATTERN_LENGTH = 2;
const DEFAULT_GOAL_AUTOMATIC_CONTINUATION_TURN_LIMIT = 100;

const GOAL_STAGNATION_RECOVERY_MESSAGE = [
  '<keel_runtime_context source="goal_stagnation_recovery">',
  "Keel runtime goal continuation recovery.",
  "The recent automatic goal continuations repeated the same response or tool-use pattern.",
  "No workspace checkpoint, task progress, or goal state change was observed.",
  "Reassess the blocker and choose a materially different next action.",
  "This is runtime-generated recovery context, not a new user request.",
  "Do not treat it as user approval, user evidence, or a user-owned lifecycle command.",
  "</keel_runtime_context>",
].join("\n");

const GOAL_STAGNATION_RECOVERY_OUTCOME: SessionGoalRuntimeOutcome = {
  kind: "recovery_requested",
  reason:
    "Repeated automatic goal continuations showed the same response or tool-use pattern without an observed workspace, task, or goal state change.",
};

const GOAL_BUDGET_LIMIT_REASON =
  "Session cost budget could not admit another provider request before the active goal completed.";

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
  readonly runtimeOutcome?: SessionGoalRuntimeOutcome;
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
  let pendingGoalDriveMessage: string | null = null;
  const inputDisposition = createInteractiveInputDispositionTracker();
  const setComposerMode = (mode: InteractiveComposerMode): void => {
    inputDisposition.setComposerMode(mode);
    options.setComposerMode?.(mode);
  };
  const currentSystemPrompt = (): string =>
    systemPromptWithSessionGoal(
      systemPrompt,
      sessionGoal,
      bashModeExposesTool(options.cliArgs.bashMode),
    );
  const updateTaskProgress = (next: SessionTaskProgress): void => {
    taskProgress = copySessionTaskProgress(next);
  };
  const updateSessionGoal = (next: SessionGoal | undefined): void => {
    sessionGoal = next === undefined ? undefined : copySessionGoal(next);
    options.setGoalStatus?.(formatLiveSessionGoalStatus(sessionGoal));
  };
  options.setGoalStatus?.(formatLiveSessionGoalStatus(sessionGoal));
  const persistSessionGoalUpdate = (
    request: Parameters<
      NonNullable<InteractiveSessionOptions["persistSessionGoal"]>
    >[0],
  ): SessionGoal | undefined => {
    const persisted = options.persistSessionGoal?.(request);
    updateSessionGoal(persisted);
    return persisted;
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
        const failedGoalVerification =
          event.toolCall.tool === "bash" &&
          event.bashExitCode !== undefined &&
          event.bashExitCode !== null &&
          event.bashExitCode !== 0 &&
          sessionGoalCommandMatchesCriterion(
            sessionGoal,
            event.toolCall.command,
          );
        onToolEnd({
          toolCall: event.toolCall,
          ok: event.ok,
          ...(event.bashExitCode !== undefined
            ? { bashExitCode: event.bashExitCode }
            : {}),
          failedGoalVerification,
        });
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
  const input =
    options.lineInput ??
    createInterface({
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
    ...(options.renderSubmittedInput !== undefined
      ? {
          onLineSubmitted: (line: string) => {
            options.renderSubmittedInput?.(
              line,
              inputDisposition.dispositionFor(line),
            );
          },
        }
      : {}),
  });
  const bashPermission =
    options.bashPermission ??
    interactiveBashPermissionPolicy(
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
        onPromptStart: () => {
          setComposerMode("approval");
        },
        onPromptEnd: () => {
          setComposerMode("steer");
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
  let sessionPromptTurnAttempted = false;
  let sessionEndObserved = false;
  let sessionCostUsd = 0;
  let sessionCostBudgetLimited = false;
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
  const handleGoalPersistenceFailure = (
    error: unknown,
    lines: readonly QueuedLine[],
  ): void => {
    pendingGoalDriveMessage = null;
    options.writeStderr(formatInteractiveCommandFailure(error));
    consumeQueuedInputLines(lines);
  };
  const abortActiveTurn = () => {
    if (activeAbortController !== null) {
      if (activeAbortController.signal.aborted) {
        options.writeStdout("\n");
        options.forceExit(130);
      }
      if (options.exitOnTurnAbort === true) {
        options.setExitCode(130);
        input.close();
      }
      activeAbortController.abort();
      return;
    }
    options.writeStdout("\n");
    options.setExitCode(130);
    input.close();
  };
  const currentSessionCostReport = (): CostReport => {
    const cost = buildSessionCostReport(
      sessionCostUsd,
      options.cliArgs.maxCostUsd,
    );
    return sessionCostBudgetLimited && options.cliArgs.maxCostUsd !== undefined
      ? buildSessionCostBudgetLimitedReport(
          sessionCostUsd,
          options.cliArgs.maxCostUsd,
        )
      : cost;
  };
  const currentSessionCostBudgetLimitedReport = (): CostReport => {
    /* v8 ignore next 3 -- admission can call this only when --max-cost created the budget wrapper. */
    if (options.cliArgs.maxCostUsd === undefined) {
      return currentSessionCostReport();
    }
    sessionCostBudgetLimited = true;
    return buildSessionCostBudgetLimitedReport(
      sessionCostUsd,
      options.cliArgs.maxCostUsd,
    );
  };
  const currentReportEnd = (): EndEventWithCost | undefined => {
    if (sessionPromptTurnAttempted && !sessionEndObserved) {
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
    sessionEndObserved = true;
    sessionUsage = addUsage(sessionUsage, end.usage);
    sessionTurns += end.turns;
    sessionStopReason = end.stopReason;
    if (end.cost?.budgetLimited === true) {
      sessionCostBudgetLimited = true;
    }
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
    const criterion = sessionGoalCompletionContract(activeGoal);
    const limitedGoalWithoutOutcome: SessionGoal =
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
    const limitedGoal = withSessionGoalRuntimeOutcome(
      limitedGoalWithoutOutcome,
      { kind: "limit_reached", reason },
    );
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
    sessionPromptTurnAttempted = true;
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
    let sessionGoalStateChanged = false;
    let sessionGoalUpdateReportedDuringTurn = false;
    setComposerMode("steer");

    try {
      const remainingCostUsd = remainingMaxCostUsd();
      const modelMaxOutputTokens = modelMetadataMaxOutputTokens(
        resolved.modelMetadata,
      );
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
                  ...(modelMaxOutputTokens !== undefined
                    ? { modelMaxOutputTokens }
                    : {}),
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
          const goalStateChanged =
            sessionGoal === undefined ||
            !sessionGoalStatesEqual(next, sessionGoal);
          if (goalStateChanged) {
            sessionGoalStateChanged = true;
          }
          sessionGoalUpdateReportedDuringTurn = true;
          updateSessionGoal(next);
          sessionGoalUpdatesDuringTurn.push(copySessionGoal(next));
        },
      );
      const finalEnd = await options.printAgentEvents(stream);
      if (turnAbortController.signal.aborted) {
        messages.splice(0, messages.length, ...messagesBeforeTurn);
        updateTaskProgress(taskProgressBeforeTurn);
        updateSessionGoal(sessionGoalBeforeTurn);
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
          sessionGoal = persistSessionGoalUpdate({
            goal,
            consumedInputIds: [],
          });
        }
      }
      options.writeStdout("\n");
      const observedEvidenceFingerprint = goalContinuationStagnationFingerprint(
        {
          messages,
          toolExecutions: toolExecutionsDuringTurn,
          stateChanged:
            taskProgressChanged ||
            sessionGoalStateChanged ||
            checkpointOperations.length > 0,
        },
      );
      const stagnationFingerprint =
        drainedInjectedLines.length > 0 ? null : observedEvidenceFingerprint;
      const runtimeOutcomeChangedDuringTurn =
        JSON.stringify(sessionGoal?.latestRuntimeOutcome) !==
        JSON.stringify(sessionGoalBeforeTurn?.latestRuntimeOutcome);
      if (
        sessionGoal !== undefined &&
        !runtimeOutcomeChangedDuringTurn &&
        !sessionGoalUpdateReportedDuringTurn
      ) {
        const observedChanges = [
          ...(checkpointOperations.length > 0 ? ["the workspace"] : []),
          ...(taskProgressChanged ? ["task progress"] : []),
        ];
        const successfulVerification = toolExecutionsDuringTurn.find(
          (execution) =>
            execution.toolCall.tool === "bash" &&
            execution.bashExitCode === 0 &&
            sessionGoalCommandMatchesCriterion(
              sessionGoalBeforeTurn,
              execution.toolCall.command,
            ),
        );
        const priorEvidenceFingerprints = new Set([
          ...(sessionGoal.latestRuntimeOutcome?.observedEvidenceFingerprints ??
            []),
          ...(request.runtimeOutcome?.observedEvidenceFingerprints ?? []),
        ]);
        const freshToolEvidenceFingerprint =
          observedEvidenceFingerprint?.startsWith("tools:") === true &&
          !priorEvidenceFingerprints.has(observedEvidenceFingerprint)
            ? observedEvidenceFingerprint
            : undefined;
        const observedOutcome: SessionGoalRuntimeOutcome | undefined =
          observedChanges.length > 0
            ? {
                kind: "progress_observed",
                reason: `The latest goal turn changed ${observedChanges.join(
                  ", ",
                )}.`,
              }
            : successfulVerification?.toolCall.tool === "bash"
              ? {
                  kind: "progress_observed",
                  reason: `Completion command ${JSON.stringify(successfulVerification.toolCall.command)} exited 0 after the latest workspace mutation.`,
                }
              : freshToolEvidenceFingerprint !== undefined
                ? {
                    kind: "progress_observed",
                    reason:
                      "The latest goal turn produced new tool-result evidence.",
                    observedEvidenceFingerprints: [
                      freshToolEvidenceFingerprint,
                    ],
                  }
                : request.runtimeOutcome;
        if (observedOutcome !== undefined) {
          updateSessionGoal(
            withSessionGoalRuntimeOutcome(sessionGoal, observedOutcome),
          );
        }
      }
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
      if (
        finalEnd?.stopReason === "cost_budget" ||
        cumulativeCost?.budgetLimited === true
      ) {
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
        stagnationFingerprint,
      };
    } catch (error) {
      if (!turnAbortController.signal.aborted) {
        throw error;
      }
      messages.splice(0, messages.length, ...messagesBeforeTurn);
      updateTaskProgress(taskProgressBeforeTurn);
      updateSessionGoal(sessionGoalBeforeTurn);
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
      setComposerMode("ready");
    }
  };
  const runAutomaticGoalContinuations = async (
    initialContinuationMessage = GOAL_CONTINUATION_MESSAGE,
  ): Promise<boolean> => {
    const automaticContinuationTurnLimit =
      resolveGoalAutomaticContinuationTurnLimit(
        options.goalAutomaticContinuationTurnLimit,
      );
    let continuationTurns = 0;
    const recentStagnationFingerprints: string[] = [];
    let nextContinuationMessage = initialContinuationMessage;
    let nextContinuationRuntimeOutcome: SessionGoalRuntimeOutcome | undefined;
    const recoveryHintedPatterns = new Set<string>();
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
      const runtimeOutcome = nextContinuationRuntimeOutcome;
      nextContinuationMessage = GOAL_CONTINUATION_MESSAGE;
      nextContinuationRuntimeOutcome = undefined;
      const result = await runPromptTurn({
        userMessage,
        consumedInputLines: [],
        ...(runtimeOutcome !== undefined ? { runtimeOutcome } : {}),
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
        recentStagnationFingerprints.length = 0;
      } else {
        recentStagnationFingerprints.push(result.stagnationFingerprint);
        recentStagnationFingerprints.splice(
          0,
          Math.max(
            0,
            recentStagnationFingerprints.length -
              GOAL_STAGNATION_RECOVERY_MATCH_LIMIT *
                GOAL_STAGNATION_MAX_PATTERN_LENGTH,
          ),
        );
      }
      const repeatedPattern = repeatedGoalContinuationPattern({
        fingerprints: recentStagnationFingerprints,
        repetitionLimit: GOAL_STAGNATION_RECOVERY_MATCH_LIMIT,
        maxPatternLength: GOAL_STAGNATION_MAX_PATTERN_LENGTH,
      });
      if (
        repeatedPattern !== null &&
        !recoveryHintedPatterns.has(repeatedPattern.key)
      ) {
        recoveryHintedPatterns.add(repeatedPattern.key);
        nextContinuationMessage = GOAL_STAGNATION_RECOVERY_MESSAGE;
        const evidenceFingerprints = repeatedPattern.fingerprints.filter(
          (fingerprint) => fingerprint.startsWith("tools:"),
        );
        nextContinuationRuntimeOutcome = {
          ...GOAL_STAGNATION_RECOVERY_OUTCOME,
          ...(evidenceFingerprints.length > 0
            ? { observedEvidenceFingerprints: evidenceFingerprints }
            : {}),
        };
      }
    }
    return false;
  };

  options.onSigint(abortActiveTurn);
  try {
    for (;;) {
      if (pendingGoalDriveMessage !== null) {
        if (sessionGoal?.status !== "active") {
          pendingGoalDriveMessage = null;
        } else if (lineReader.pendingInputCount() === 0) {
          const driveMessage = pendingGoalDriveMessage;
          pendingGoalDriveMessage = null;
          if (await runAutomaticGoalContinuations(driveMessage)) {
            break;
          }
        }
      }
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
          case "set":
          case "launch": {
            if (options.persistSessionGoal === undefined) {
              options.writeStderr(formatGoalRequiresSavedSession());
              consumeQueuedInputLines([rawInput]);
              break;
            }
            try {
              const nextGoal: SessionGoal =
                goalCommand.action === "launch"
                  ? {
                      objective: goalCommand.objective,
                      status: "active",
                      budget: goalCommand.budget,
                      usage: emptySessionGoalUsage(),
                      criterionKind: "command",
                      completionCriterion: goalCommand.command,
                      ...(goalCommand.verificationTimeoutMs !== undefined
                        ? {
                            verificationTimeoutMs:
                              goalCommand.verificationTimeoutMs,
                          }
                        : {}),
                    }
                  : {
                      objective: goalCommand.objective,
                      status: "active",
                      budget: emptySessionGoalBudget(),
                      usage: emptySessionGoalUsage(),
                      criterionKind: "assertion",
                      completionCriterion: goalCommand.objective,
                    };
              sessionGoal = persistSessionGoalUpdate({
                goal: nextGoal,
                consumedInputIds: queuedInputIds([rawInput]),
              });
              options.writeStdout(formatInteractiveGoalSet(nextGoal));
              if (goalCommand.action === "launch") {
                options.writeStdout(formatInteractiveGoalBudget(nextGoal));
              }
              pendingGoalDriveMessage = GOAL_ACTIVATION_MESSAGE;
            } catch (error) {
              handleGoalPersistenceFailure(error, [rawInput]);
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
              const pausedGoal = pauseActiveSessionGoal(sessionGoal);
              sessionGoal = persistSessionGoalUpdate({
                goal: pausedGoal,
                consumedInputIds: queuedInputIds([rawInput]),
              });
              options.writeStdout(formatInteractiveGoalPaused(pausedGoal));
            } catch (error) {
              handleGoalPersistenceFailure(error, [rawInput]);
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
            if (
              sessionGoal.criterionKind === undefined ||
              sessionGoal.completionCriterion === undefined
            ) {
              options.writeStderr(
                "Error: the session goal has no completion criterion. Set a new goal before resuming.\n",
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
              const resumedGoal = preserveLatestSessionGoalRuntimeOutcome(
                sessionGoal,
                {
                  objective: sessionGoal.objective,
                  status: "active",
                  ...sessionGoalAccounting(sessionGoal),
                  ...sessionGoalCompletionContract(sessionGoal),
                },
              );
              sessionGoal = persistSessionGoalUpdate({
                goal: resumedGoal,
                consumedInputIds: queuedInputIds([rawInput]),
              });
              options.writeStdout(formatInteractiveGoalResumed(resumedGoal));
              pendingGoalDriveMessage = GOAL_RESUMPTION_MESSAGE;
            } catch (error) {
              handleGoalPersistenceFailure(error, [rawInput]);
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
                  budgetedGoal = withSessionGoalRuntimeOutcome(
                    {
                      objective: budgetedGoal.objective,
                      status: "budget_limited",
                      statusReason: reason,
                      ...sessionGoalAccounting(budgetedGoal),
                      ...sessionGoalCompletionContract(budgetedGoal),
                    },
                    { kind: "limit_reached", reason },
                  );
                }
              }
              sessionGoal = persistSessionGoalUpdate({
                goal: budgetedGoal,
                consumedInputIds: queuedInputIds([rawInput]),
              });
              options.writeStdout(
                formatInteractiveGoalBudgetUpdated(budgetedGoal),
              );
            } catch (error) {
              handleGoalPersistenceFailure(error, [rawInput]);
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
              sessionGoal = persistSessionGoalUpdate({
                goal: clearedGoal,
                consumedInputIds: queuedInputIds([rawInput]),
              });
              options.writeStdout(
                formatInteractiveGoalBudgetCleared(clearedGoal),
              );
            } catch (error) {
              handleGoalPersistenceFailure(error, [rawInput]);
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
              const completedGoalWithoutOutcome: SessionGoal = {
                objective: sessionGoal.objective,
                status: "completed",
                completionEvidence: { kind: "user_override" },
                ...sessionGoalAccounting(sessionGoal),
                ...sessionGoalCompletionContract(sessionGoal),
              };
              const completedGoal = withSessionGoalRuntimeOutcome(
                completedGoalWithoutOutcome,
                {
                  kind: "completed",
                  reason:
                    "The user explicitly completed the goal with /goal complete.",
                },
              );
              sessionGoal = persistSessionGoalUpdate({
                goal: completedGoal,
                consumedInputIds: queuedInputIds([rawInput]),
              });
              options.writeStdout(
                formatInteractiveGoalCompleted(completedGoal),
              );
            } catch (error) {
              handleGoalPersistenceFailure(error, [rawInput]);
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
              const verifiedGoalWithoutOutcome = {
                objective: sessionGoal.objective,
                status: "active",
                ...sessionGoalAccounting(sessionGoal),
                criterionKind: "command",
                completionCriterion: goalCommand.command,
                ...(goalCommand.verificationTimeoutMs !== undefined
                  ? {
                      verificationTimeoutMs: goalCommand.verificationTimeoutMs,
                    }
                  : {}),
              } satisfies SessionGoal & {
                readonly criterionKind: "command";
                readonly completionCriterion: string;
              };
              const verifiedGoal = preserveLatestSessionGoalRuntimeOutcome(
                sessionGoal,
                verifiedGoalWithoutOutcome,
              );
              sessionGoal = persistSessionGoalUpdate({
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
              handleGoalPersistenceFailure(error, [rawInput]);
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
              const goalWithCriterionWithoutOutcome = {
                objective: sessionGoal.objective,
                status: "active",
                ...sessionGoalAccounting(sessionGoal),
                criterionKind: goalCommand.criterionKind,
                completionCriterion: goalCommand.criterion,
              } satisfies SessionGoal;
              const goalWithCriterion = preserveLatestSessionGoalRuntimeOutcome(
                sessionGoal,
                goalWithCriterionWithoutOutcome,
              );
              sessionGoal = persistSessionGoalUpdate({
                goal: goalWithCriterion,
                consumedInputIds: queuedInputIds([rawInput]),
              });
              options.writeStdout(
                formatInteractiveGoalCriterionSet(goalWithCriterion),
              );
            } catch (error) {
              handleGoalPersistenceFailure(error, [rawInput]);
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
              sessionGoal = persistSessionGoalUpdate({
                goal: null,
                consumedInputIds: queuedInputIds([rawInput]),
              });
              options.writeStdout(formatInteractiveGoalCleared());
            } catch (error) {
              handleGoalPersistenceFailure(error, [rawInput]);
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
        if (interactiveCommand.scope === "goal") {
          pendingGoalDriveMessage = null;
        }
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
            setComposerMode("queue");
            try {
              const remainingCostUsd = remainingMaxCostUsd();
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
                ...(remainingCostUsd !== undefined ? { remainingCostUsd } : {}),
                costBudgetLimitedReport: currentSessionCostBudgetLimitedReport,
              });
              if (compaction.status === "rejected") {
                if (compaction.cost?.budgetLimited === true) {
                  sessionStopReason = "cost_budget";
                  break;
                }
                consumeQueuedInputLines([rawInput]);
                continue;
              }
              modelSwitchCost = compaction.cost;
            } finally {
              activeAbortController = null;
              setComposerMode("ready");
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
          if (modelSwitchCost?.budgetLimited === true) {
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
        setComposerMode("queue");
        let compactCost: CostReport | undefined;
        try {
          const remainingCostUsd = remainingMaxCostUsd();
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
            ...(remainingCostUsd !== undefined ? { remainingCostUsd } : {}),
            costBudgetLimitedReport: currentSessionCostBudgetLimitedReport,
          });
        } finally {
          activeAbortController = null;
          setComposerMode("ready");
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
        if (compactCost?.budgetLimited === true) {
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
      pendingGoalDriveMessage = null;
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
  const finalGoal =
    sessionGoal === undefined ? {} : { goal: copySessionGoal(sessionGoal) };
  if (options.cliArgs.reportFile !== undefined) {
    const reportEnd = currentReportEnd();
    if (reportEnd === undefined) {
      return finalGoal;
    }
    return {
      ...finalGoal,
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
  return finalGoal;
}
