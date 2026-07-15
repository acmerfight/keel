import { createInterface } from "node:readline/promises";
import type { AgentEvent, CostReport } from "../agent/events.ts";
import { runAgentTurn } from "../agent/loop.ts";
import type {
  ModelOperationInstrumentation,
  ModelOperationOwner,
} from "../agent/model-operations.ts";
import { postCompactionReadToolCallId } from "../agent/post-compaction-read-id.ts";
import {
  appendWorkflowSkillsToSystemPrompt,
  buildAgentSystemPrompt,
} from "../agent/prompt.ts";
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
  formatSessionGoalResumeRejection,
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
import {
  createUndoProtectionTracker,
  undoCheckpointUnavailable,
} from "../core/undo-protection.ts";
import type { Message, Usage, UserMessageOrigin } from "../llm/types.ts";
import {
  type BashApprovalGrant,
  type BashProjectApprovalGrant,
  bashApprovalGrantKey,
  bashModeExposesTool,
} from "../permissions/bash.ts";
import {
  exposeSkillCatalog,
  formatSkillCatalogDegradation,
} from "../skills/catalog.ts";
import {
  type ExplicitSkillInvocation,
  parseExplicitSkillInvocation,
} from "../skills/explicit.ts";
import {
  skillLifecycleStatesEqual,
  workflowSkillFromActivation,
} from "../skills/lifecycle.ts";
import {
  type ActiveSkillStatus,
  type SkillActivationRecord,
  type SkillLifecycleState,
  type WorkflowSkill,
  WorkflowSkillError,
} from "../skills/model.ts";
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
  InteractiveResolvedProvider,
  InteractiveSessionOptions,
  InteractiveSessionResult,
  ProviderSelection,
} from "./interactive-session/types.ts";
import {
  formatLiveSessionGoalStatus,
  formatUndoCheckpointList,
  formatUndoCheckpointWarning,
  sanitizeStatusLineText,
} from "./output.ts";
import {
  accountModelOperations,
  createAgentEventReportRecorder,
  type RunReportAgentRunTrigger,
  type RunReportTaskTrigger,
  recordAgentEventStream,
} from "./report-events.ts";
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

function formatActiveWorkflowSkills(
  statuses: readonly ActiveSkillStatus[],
): string {
  if (statuses.length === 0) {
    return "No active workflow skills.\n";
  }
  return [
    "Active workflow skills:",
    ...statuses.map(
      ({ activation, diskStatus }) =>
        `- ${activation.qualifiedName} (${activation.relativePath}) [${activation.trigger}, ${diskStatus}]`,
    ),
    "",
  ].join("\n");
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

const USER_PROMPT_ORIGIN = {
  type: "user_prompt",
} satisfies UserMessageOrigin;
const STEER_ORIGIN = { type: "steer" } satisfies UserMessageOrigin;
const QUEUED_FOLLOWUP_ORIGIN = {
  type: "queued_followup",
} satisfies UserMessageOrigin;
const RUNTIME_GOAL_ACTIVATION_ORIGIN = {
  type: "runtime_goal_activation",
} satisfies UserMessageOrigin;
const RUNTIME_GOAL_CONTINUATION_ORIGIN = {
  type: "runtime_goal_continuation",
} satisfies UserMessageOrigin;
const RUNTIME_GOAL_RESUMPTION_ORIGIN = {
  type: "runtime_goal_resumption",
} satisfies UserMessageOrigin;
const RUNTIME_GOAL_STAGNATION_RECOVERY_ORIGIN = {
  type: "runtime_goal_stagnation_recovery",
} satisfies UserMessageOrigin;
const RUNTIME_UNDO_RESTORATION_ORIGIN = {
  type: "runtime_undo_restoration",
} satisfies UserMessageOrigin;

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
  readonly userMessageOrigin: UserMessageOrigin;
  readonly consumedInputLines: readonly QueuedLine[];
  readonly runTrigger: RunReportAgentRunTrigger;
  readonly runtimeOutcome?: SessionGoalRuntimeOutcome;
}

interface PendingGoalDrive {
  readonly message: string;
  readonly origin: UserMessageOrigin;
  readonly taskTrigger: Extract<
    RunReportTaskTrigger,
    "goal_activation" | "goal_resume"
  >;
  readonly runTrigger: Extract<
    RunReportAgentRunTrigger,
    "goal_activation" | "goal_resume"
  >;
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
  hiddenPaths: readonly string[],
): Promise<InteractiveDiffInspection> {
  const status = await executeGitStatus(workspace, { hiddenPaths });
  if (!status.inGitWorkTree) {
    return { kind: "non-git", message: NON_GIT_DIFF_MESSAGE };
  }
  const diff = await executeGitDiff(workspace, {
    mode: "all",
    hiddenPaths,
  });
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
  const hiddenWorkspacePaths = options.hiddenWorkspacePaths ?? [];
  const undoProtection = createUndoProtectionTracker();
  const activeWorkflowSkills: WorkflowSkill[] =
    options.skillActivation === undefined
      ? [...(options.workflowSkills ?? [])]
      : options.skillActivation.active().map(workflowSkillFromActivation);
  const explicitSkillActivations: SkillActivationRecord[] =
    options.skillActivation === undefined
      ? activeWorkflowSkills.map((skill) => ({
          name: skill.qualifiedName,
          relativePath: skill.relativePath,
          trigger: "user_explicit",
        }))
      : [...(options.initialSkillActivationRecords ?? [])];
  const syncActiveWorkflowSkills = (): void => {
    /* v8 ignore next -- every call site first establishes lifecycle state or an activation command. */
    if (options.skillActivation === undefined) return;
    activeWorkflowSkills.splice(
      0,
      activeWorkflowSkills.length,
      ...options.skillActivation.active().map(workflowSkillFromActivation),
    );
  };
  const inactiveImplicitSkills = () => {
    const activePackageIds = new Set(
      options.skillActivation
        ?.active()
        .map((activation) => activation.packageId) ??
        activeWorkflowSkills.map((skill) => skill.packageId),
    );
    return (options.skillCatalog ?? []).filter(
      (descriptor) => !activePackageIds.has(descriptor.packageId),
    );
  };
  let latestCatalogExposure = exposeSkillCatalog({
    skills: inactiveImplicitSkills(),
    request: "",
  });
  let visibleSkillCatalog = latestCatalogExposure.skills;
  const rebuildSystemPrompt = (): string =>
    buildAgentSystemPrompt({
      workspace: options.workspace,
      platform: options.platform,
      ...(options.projectInstructions !== undefined
        ? { projectInstructions: options.projectInstructions }
        : {}),
      ...(visibleSkillCatalog.length > 0
        ? { skillCatalog: visibleSkillCatalog }
        : {}),
    });
  let systemPrompt = rebuildSystemPrompt();
  let catalogDiagnosticSignature: string | null = null;
  const messages: Message[] = [...(options.initialMessages ?? [])];
  let taskProgress = copySessionTaskProgress(
    options.initialTaskProgress ?? emptySessionTaskProgress(),
  );
  let sessionTitle = options.initialSessionTitle;
  let sessionGoal =
    options.initialSessionGoal === undefined
      ? undefined
      : copySessionGoal(options.initialSessionGoal);
  let pendingGoalDrive: PendingGoalDrive | null = null;
  const reportRecorder =
    options.reportRecorder ?? createAgentEventReportRecorder();
  const inputDisposition = createInteractiveInputDispositionTracker();
  const setComposerMode = (mode: InteractiveComposerMode): void => {
    inputDisposition.setComposerMode(mode);
    options.setComposerMode?.(mode);
  };
  const baseSystemPromptWithGoal = (): string =>
    systemPromptWithSessionGoal(
      systemPrompt,
      sessionGoal,
      bashModeExposesTool(options.cliArgs.bashMode),
    );
  const currentSystemPrompt = (): string =>
    appendWorkflowSkillsToSystemPrompt(
      baseSystemPromptWithGoal(),
      options.skillActivation === undefined
        ? activeWorkflowSkills
        : options.skillActivation.active().map(workflowSkillFromActivation),
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
  let sessionAgentLoopTurns = 0;
  let sessionPromptTurnAttempted = false;
  let sessionEndObserved = false;
  let sessionCostUsd = 0;
  let sessionCostBudgetLimited = false;
  let sessionStopReason = "completed";
  let modelSwitchCount = options.initialModelSwitchCount ?? 0;
  const resolveActiveProvider = (
    userMessage: string,
  ): InteractiveResolvedProvider => {
    resolved ??= options.resolveProvider(
      userMessage,
      options.initialModelSelection,
    );
    return resolved;
  };
  const reportModelOperations = (
    operationResolved: InteractiveResolvedProvider,
    owner: ModelOperationOwner,
  ): ModelOperationInstrumentation | null =>
    options.cliArgs.reportFile === undefined
      ? null
      : {
          recorder: reportRecorder,
          owner,
          provider: operationResolved.providerId,
          model: operationResolved.model,
          costModel: options.requireKnownCostModel(operationResolved),
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
  const userMessageOriginForPromptInput = (
    lines: readonly QueuedLine[],
  ): UserMessageOrigin =>
    queuedInputIds(lines).length === 0
      ? USER_PROMPT_ORIGIN
      : QUEUED_FOLLOWUP_ORIGIN;
  const handleGoalPersistenceFailure = (
    error: unknown,
    lines: readonly QueuedLine[],
  ): void => {
    pendingGoalDrive = null;
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
      turns: sessionAgentLoopTurns,
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
    return currentSessionCostReport();
  };
  const recordTurnEnd = (end: EndEvent): CostReport | undefined => {
    sessionEndObserved = true;
    sessionUsage = addUsage(sessionUsage, end.usage);
    sessionAgentLoopTurns += end.turns;
    sessionStopReason = end.stopReason;
    if (end.cost?.budgetLimited === true) {
      sessionCostBudgetLimited = true;
    }
    const turnCostUsd = end.cost?.spentUsd ?? 0;
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
    reportRecorder.beginAgentRun(request.runTrigger);
    let latestAgentLoopAccounting:
      | Pick<EndEvent, "usage" | "turns" | "cost">
      | undefined;
    const abortReportedAgentRun = (
      end?: EndEvent,
      recordAccounting = true,
    ): void => {
      const accounting = end ?? latestAgentLoopAccounting;
      reportRecorder.abortAgentRun(accounting?.turns ?? 0);
      if (recordAccounting && accounting !== undefined) {
        recordTurnEnd({
          type: "end",
          usage: accounting.usage,
          turns: accounting.turns,
          stopReason: "aborted",
          ...(accounting.cost !== undefined ? { cost: accounting.cost } : {}),
        });
      }
    };
    const skillStateBeforeTurn = options.skillActivation?.state();
    options.skillActivation?.beginTurn();
    const goalTurnStartedAt = sessionGoal?.status === "active" ? now() : null;
    resolved = resolveActiveProvider(request.userMessage);
    const turnModelOperations = reportModelOperations(resolved, {
      type: "current_agent_run",
    });
    const exposure = exposeSkillCatalog({
      skills: inactiveImplicitSkills(),
      request: request.userMessage,
      ...(resolved.modelMetadata !== undefined
        ? { modelMetadata: resolved.modelMetadata }
        : {}),
    });
    latestCatalogExposure = exposure;
    options.skillActivation?.expose(exposure.skills);
    visibleSkillCatalog = exposure.skills;
    systemPrompt = rebuildSystemPrompt();
    const diagnostic = formatSkillCatalogDegradation(exposure);
    const diagnosticSignature = `${exposure.total}:${exposure.omitted}:${exposure.budgetChars}`;
    if (
      diagnostic !== "" &&
      diagnosticSignature !== catalogDiagnosticSignature
    ) {
      options.writeStderr(diagnostic);
      catalogDiagnosticSignature = diagnosticSignature;
    }
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
    messages.push({
      role: "user",
      content: request.userMessage,
      origin: request.userMessageOrigin,
    });
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
          systemPrompt: baseSystemPromptWithGoal(),
          ...(options.memoryPrompt !== undefined
            ? { memoryPrompt: options.memoryPrompt }
            : {}),
          signal: turnAbortController.signal,
          allowBash: bashModeExposesTool(options.cliArgs.bashMode),
          hiddenWorkspacePaths,
          ...(options.skillActivation !== undefined
            ? { skillActivation: options.skillActivation }
            : {}),
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
          ...(turnModelOperations !== null
            ? { modelOperations: turnModelOperations }
            : {}),
          ...(options.toolOutputArtifacts !== undefined
            ? { toolOutputArtifacts: options.toolOutputArtifacts }
            : {}),
          readVisibility,
          projectInstructionVisibility,
          recordCheckpointOperations: (operations) => {
            checkpointOperations.push(...operations);
          },
          onAgentLoopTurnCompleted: (accounting) => {
            latestAgentLoopAccounting = accounting;
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
            return injectableLines.map((content) => {
              reportRecorder.recordHumanIntervention();
              return {
                role: "user",
                content: content.line,
                origin: STEER_ORIGIN,
              };
            });
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
      const finalEnd = await options.printAgentEvents(
        recordAgentEventStream(stream, reportRecorder),
      );
      if (turnAbortController.signal.aborted) {
        abortReportedAgentRun(finalEnd);
        if (skillStateBeforeTurn !== undefined) {
          options.skillActivation?.restore(skillStateBeforeTurn);
          syncActiveWorkflowSkills();
          systemPrompt = rebuildSystemPrompt();
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
      }
      if (finalEnd === undefined) {
        abortReportedAgentRun(undefined, false);
      } else {
        reportRecorder.completeAgentRun(finalEnd.turns, finalEnd.stopReason);
      }
      restoreDrainedInput(deferredInputLines);
      const completedSkillState = options.skillActivation?.state();
      const skillStateChanged =
        skillStateBeforeTurn !== undefined &&
        completedSkillState !== undefined &&
        !skillLifecycleStatesEqual(skillStateBeforeTurn, completedSkillState);
      options.persistSessionMessages?.(
        messages,
        "turn",
        [
          ...queuedInputIds(request.consumedInputLines),
          ...queuedInputIds(drainedInjectedLines),
        ],
        skillStateChanged ? completedSkillState : undefined,
      );
      if (skillStateChanged) {
        syncActiveWorkflowSkills();
        systemPrompt = rebuildSystemPrompt();
      }
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
      abortReportedAgentRun();
      if (skillStateBeforeTurn !== undefined) {
        options.skillActivation?.restore(skillStateBeforeTurn);
        syncActiveWorkflowSkills();
        systemPrompt = rebuildSystemPrompt();
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
        const result = recordLastTaskCheckpoint({
          workspace: options.workspace,
          operations: checkpointOperations,
        });
        undoProtection.record(result);
        if (undoCheckpointUnavailable(result)) {
          options.writeStderr(`${formatUndoCheckpointWarning()}\n`);
        }
      }
      activeAbortController = null;
      setComposerMode("ready");
    }
  };
  const runAutomaticGoalContinuations = async (
    initialContinuationMessage = GOAL_CONTINUATION_MESSAGE,
    initialRunTrigger: RunReportAgentRunTrigger = "goal_continuation",
    initialContinuationOrigin: UserMessageOrigin = RUNTIME_GOAL_CONTINUATION_ORIGIN,
  ): Promise<boolean> => {
    const automaticContinuationTurnLimit =
      resolveGoalAutomaticContinuationTurnLimit(
        options.goalAutomaticContinuationTurnLimit,
      );
    let continuationTurns = 0;
    const recentStagnationFingerprints: string[] = [];
    let nextContinuationMessage = initialContinuationMessage;
    let nextRunTrigger = initialRunTrigger;
    let nextContinuationOrigin = initialContinuationOrigin;
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
      const userMessageOrigin = nextContinuationOrigin;
      nextContinuationMessage = GOAL_CONTINUATION_MESSAGE;
      nextContinuationOrigin = RUNTIME_GOAL_CONTINUATION_ORIGIN;
      nextContinuationRuntimeOutcome = undefined;
      const result = await runPromptTurn({
        userMessage,
        userMessageOrigin,
        consumedInputLines: [],
        runTrigger: nextRunTrigger,
        ...(runtimeOutcome !== undefined ? { runtimeOutcome } : {}),
      });
      nextRunTrigger = "goal_continuation";
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
        nextContinuationOrigin = RUNTIME_GOAL_STAGNATION_RECOVERY_ORIGIN;
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

  const taskOutcomeForGoal = (
    startedWithActiveGoal: boolean,
  ): string | undefined => {
    if (!startedWithActiveGoal) {
      return undefined;
    }
    switch (sessionGoal?.status) {
      case "blocked":
        return "goal_blocked";
      case "budget_limited":
        return "goal_budget";
      case "usage_limited":
        return "goal_usage_limit";
      case "completed":
        return "completed";
      case "active":
      case "paused":
      case undefined:
        return undefined;
    }
  };

  options.onSigint(abortActiveTurn);
  try {
    for (;;) {
      if (pendingGoalDrive !== null) {
        if (sessionGoal?.status !== "active") {
          pendingGoalDrive = null;
        } else if (lineReader.pendingInputCount() === 0) {
          const drive = pendingGoalDrive;
          pendingGoalDrive = null;
          reportRecorder.beginTask(drive.taskTrigger);
          const shouldStop = await runAutomaticGoalContinuations(
            drive.message,
            drive.runTrigger,
            drive.origin,
          );
          reportRecorder.endTask(taskOutcomeForGoal(true));
          if (shouldStop) {
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
      let userMessage = rawLine.trim();
      if (userMessage === "") {
        consumeQueuedInputLines([rawInput]);
        continue;
      }
      let explicitInvocation: ExplicitSkillInvocation | null;
      try {
        explicitInvocation = parseExplicitSkillInvocation(userMessage);
      } catch (error) {
        options.writeStderr(formatInteractiveCommandFailure(error));
        consumeQueuedInputLines([rawInput]);
        continue;
      }
      if (explicitInvocation !== null) {
        let stateBeforeActivation: SkillLifecycleState | undefined;
        try {
          if (options.skillUnavailableReason !== undefined) {
            throw new WorkflowSkillError(options.skillUnavailableReason);
          }
          const skill = options.activateExplicitSkill?.(
            explicitInvocation.lookup,
          );
          if (skill === undefined) {
            throw new Error("explicit skill activation is unavailable");
          }
          /* v8 ignore next 3 -- the CLI installs activation lookup and lifecycle ownership together. */
          if (options.skillActivation === undefined) {
            throw new WorkflowSkillError(
              options.skillUnavailableReason ??
                "explicit skill activation is unavailable",
            );
          }
          stateBeforeActivation = options.skillActivation.state();
          const activation = options.skillActivation.activateExplicit(
            skill,
            explicitInvocation.arguments,
          );
          if (
            !skillLifecycleStatesEqual(
              stateBeforeActivation,
              options.skillActivation.state(),
            )
          ) {
            options.persistSkillState?.(options.skillActivation.state());
          }
          if (activation.record !== undefined) {
            explicitSkillActivations.push(activation.record);
          }
          syncActiveWorkflowSkills();
          systemPrompt = rebuildSystemPrompt();
          userMessage =
            explicitInvocation.arguments === ""
              ? "Apply the explicitly selected workflow skill."
              : explicitInvocation.arguments;
        } catch (error) {
          if (
            stateBeforeActivation !== undefined &&
            options.skillActivation !== undefined
          ) {
            options.skillActivation.restore(stateBeforeActivation);
            syncActiveWorkflowSkills();
            systemPrompt = rebuildSystemPrompt();
          }
          options.writeStderr(formatInteractiveCommandFailure(error));
          consumeQueuedInputLines([rawInput]);
          continue;
        }
      }
      const interactiveCommand =
        explicitInvocation === null ? parseInteractiveCommand(rawLine) : null;
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
            workflowSkills: activeWorkflowSkills,
            skillCatalog: {
              exposed: latestCatalogExposure.skills.length,
              omitted: latestCatalogExposure.omitted,
              total: latestCatalogExposure.total,
              budgetChars: latestCatalogExposure.budgetChars,
            },
            messages,
            messageCount: messages.length,
            pendingInputCount: lineReader.pendingInputCount(),
            bashApprovalCount:
              activeBashApprovalGrants().length +
              activeProjectBashApprovalGrants.length,
            taskProgress,
            modelSwitchCount,
            undoCheckpoints: listUndoCheckpoints(options.workspace),
            undoProtection: undoProtection.summary(),
            ...(options.memoryStatus !== undefined
              ? { memory: options.memoryStatus() }
              : {}),
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
                  ? goalCommand.criterion.kind === "command"
                    ? {
                        objective: goalCommand.objective,
                        status: "active",
                        budget: goalCommand.budget,
                        usage: emptySessionGoalUsage(),
                        criterionKind: "command",
                        completionCriterion: goalCommand.criterion.command,
                        ...(goalCommand.criterion.verificationTimeoutMs !==
                        undefined
                          ? {
                              verificationTimeoutMs:
                                goalCommand.criterion.verificationTimeoutMs,
                            }
                          : {}),
                      }
                    : {
                        objective: goalCommand.objective,
                        status: "active",
                        budget: goalCommand.budget,
                        usage: emptySessionGoalUsage(),
                        criterionKind: "assertion",
                        completionCriterion: goalCommand.criterion.assertion,
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
              pendingGoalDrive = {
                message: GOAL_ACTIVATION_MESSAGE,
                origin: RUNTIME_GOAL_ACTIVATION_ORIGIN,
                taskTrigger: "goal_activation",
                runTrigger: "goal_activation",
              };
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
              options.writeStderr(
                `${formatSessionGoalResumeRejection(sessionGoal)}\n`,
              );
              consumeQueuedInputLines([rawInput]);
              break;
            }
            const resumeRejection =
              formatSessionGoalResumeRejection(sessionGoal);
            if (resumeRejection !== null) {
              options.writeStderr(`${resumeRejection}\n`);
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
              pendingGoalDrive = {
                message: GOAL_RESUMPTION_MESSAGE,
                origin: RUNTIME_GOAL_RESUMPTION_ORIGIN,
                taskTrigger: "goal_resume",
                runTrigger: "goal_resume",
              };
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
              await inspectInteractiveDiff(
                options.workspace,
                hiddenWorkspacePaths,
              ),
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
          pendingGoalDrive = null;
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
              origin: RUNTIME_UNDO_RESTORATION_ORIGIN,
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
              const modelOperations = reportModelOperations(currentResolved, {
                type: "session",
              });
              const compaction = await executeModelSwitchCompaction({
                current: currentResolved,
                target: nextResolved,
                workspace: options.workspace,
                messages,
                systemPrompt: currentSystemPrompt(),
                summarySystemPrompt: currentSystemPrompt(),
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
                modelOperations,
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
        if (interactiveCommand.action === "active") {
          /* v8 ignore next -- the CLI always installs lifecycle ownership before exposing Skill commands. */
          const statuses = options.skillActivation?.activeStatuses() ?? [];
          options.writeStdout(formatActiveWorkflowSkills(statuses));
          consumeQueuedInputLines([rawInput]);
          continue;
        }
        let skillTaskShouldRun = false;
        let stateBeforeCommand: SkillLifecycleState | undefined;
        try {
          if (options.skillActivation === undefined) {
            throw new WorkflowSkillError(
              options.skillUnavailableReason ??
                "explicit skill activation is unavailable",
            );
          }
          stateBeforeCommand = options.skillActivation.state();
          let successMessage: string;
          let activationRecord: SkillActivationRecord | undefined;
          if (interactiveCommand.action === "deactivate") {
            const deactivated = options.skillActivation.deactivate(
              interactiveCommand.lookup,
            );
            successMessage = `Deactivated workflow skill ${deactivated.qualifiedName}.\n`;
          } else if (interactiveCommand.action === "reload") {
            const reloaded = options.skillActivation.reload(
              interactiveCommand.lookup,
            );
            activationRecord = reloaded.record;
            successMessage = `Reloaded workflow skill ${reloaded.activation.qualifiedName}.\n`;
          } else {
            const skill = options.activateExplicitSkill?.(
              interactiveCommand.lookup,
            );
            /* v8 ignore next 3 -- the CLI installs activation lookup and lifecycle ownership together. */
            if (skill === undefined) {
              throw new Error("explicit skill activation is unavailable");
            }
            const activated = options.skillActivation.activateExplicit(
              skill,
              interactiveCommand.arguments ?? "",
            );
            activationRecord = activated.record;
            successMessage = `Activated workflow skill ${skill.qualifiedName}.\n`;
            if (interactiveCommand.arguments !== undefined) {
              userMessage = interactiveCommand.arguments;
              skillTaskShouldRun = true;
            }
          }
          if (
            !skillLifecycleStatesEqual(
              stateBeforeCommand,
              options.skillActivation.state(),
            )
          ) {
            options.persistSkillState?.(options.skillActivation.state());
          }
          if (activationRecord !== undefined) {
            explicitSkillActivations.push(activationRecord);
          }
          syncActiveWorkflowSkills();
          systemPrompt = rebuildSystemPrompt();
          options.writeStdout(successMessage);
        } catch (error) {
          if (
            stateBeforeCommand !== undefined &&
            options.skillActivation !== undefined
          ) {
            options.skillActivation.restore(stateBeforeCommand);
            syncActiveWorkflowSkills();
            systemPrompt = rebuildSystemPrompt();
          }
          options.writeStderr(formatInteractiveCommandFailure(error));
        }
        if (!skillTaskShouldRun) {
          consumeQueuedInputLines([rawInput]);
          continue;
        }
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
        let compactCommitted = false;
        try {
          const remainingCostUsd = remainingMaxCostUsd();
          const modelOperations = reportModelOperations(compactResolved, {
            type: "session",
          });
          const compaction = await executeManualCompaction({
            command: interactiveCommand,
            resolved: compactResolved,
            workspace: options.workspace,
            messages,
            systemPrompt: currentSystemPrompt(),
            summarySystemPrompt: currentSystemPrompt(),
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
            modelOperations,
          });
          compactCost = compaction.cost;
          compactCommitted = compaction.status === "committed";
        } finally {
          activeAbortController = null;
          setComposerMode("ready");
        }
        if (compactAbortController.signal.aborted || !compactCommitted) {
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
      pendingGoalDrive = null;
      const taskStartedWithActiveGoal = sessionGoal?.status === "active";
      reportRecorder.beginTask("user_prompt");
      const turnResult = await runPromptTurn({
        userMessage,
        userMessageOrigin: userMessageOriginForPromptInput([rawInput]),
        consumedInputLines: [rawInput],
        runTrigger: "user_prompt",
      });
      if (turnResult.aborted) {
        reportRecorder.endTask("aborted");
        continue;
      }
      if (turnResult.budgetExceeded) {
        reportRecorder.endTask(taskOutcomeForGoal(taskStartedWithActiveGoal));
        break;
      }
      const shouldStop = await runAutomaticGoalContinuations();
      reportRecorder.endTask(taskOutcomeForGoal(taskStartedWithActiveGoal));
      if (shouldStop) {
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
    const operationAccounting = accountModelOperations(
      reportRecorder.modelOperations(),
    );
    return {
      ...finalGoal,
      report: {
        tasks: reportRecorder.tasks(),
        modelsUsed: operationAccounting.modelsUsed,
        usageByModel: operationAccounting.usageByModel,
        modelOperations: operationAccounting.modelOperations,
        modelOperationCount: operationAccounting.modelOperationCount,
        providerRequestAttemptCount:
          operationAccounting.providerRequestAttemptCount,
        end: reportEnd,
        skillCatalog: {
          exposed: latestCatalogExposure.skills.length,
          omitted: latestCatalogExposure.omitted,
          total: latestCatalogExposure.total,
          budgetChars: latestCatalogExposure.budgetChars,
          usedChars: latestCatalogExposure.usedChars,
        },
        explicitSkillActivations,
        undoProtection: undoProtection.summary(),
      },
    };
  }
  return finalGoal;
}
