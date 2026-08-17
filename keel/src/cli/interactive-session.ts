import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import type { AgentEvent, CostReport } from "../agent/events.ts";
import { runAgentTurn } from "../agent/loop.ts";
import type {
  MainModelOperationInstrumentation,
  ModelOperationOwner,
} from "../agent/model-operations.ts";
import { postCompactionReadToolCallId } from "../agent/post-compaction-read-id.ts";
import {
  appendDelegationToSystemPrompt,
  appendWorkflowSkillsToSystemPrompt,
  buildAgentSystemPrompt,
} from "../agent/prompt.ts";
import {
  clearReadVisibilityState,
  createReadVisibilityState,
} from "../agent/read-visibility.ts";
import {
  replaceSessionLedgerMessages,
  sessionLedgerFromMessages,
  sessionLedgerMessages,
} from "../agent/session-ledger.ts";
import type {
  OrdinaryUserMessageOrigin,
  SessionMessage,
  UserMessageOrigin,
} from "../agent/session-message.ts";
import { defaultStopPolicy } from "../agent/stop-policy.ts";
import { MAX_SUBAGENT_RESULT_CHARS } from "../agent/subagent-tree-budget.ts";
import { type CostModel, calculateRequestCostBatchUsd } from "../core/cost.ts";
import { isAbortThrow } from "../core/error.ts";
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
  formatSessionGoalBudgetLimitReason,
  formatSessionGoalSummary,
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
  type SessionTaskProgress,
  sessionTaskProgressesEqual,
} from "../core/task-progress.ts";
import {
  createUndoProtectionTracker,
  type RecordUndoCheckpointResult,
  undoCheckpointUnavailable,
} from "../core/undo-protection.ts";
import type { Usage } from "../llm/types.ts";
import type { McpAuthorizationIdentity } from "../mcp/oauth.ts";
import {
  type McpProviderSchemaTarget,
  mcpProviderSchemaTarget,
} from "../mcp/provider-schema.ts";
import { createMcpRuntime } from "../mcp/runtime.ts";
import type { McpRuntime, McpRuntimeServer } from "../mcp/runtime-types.ts";
import {
  type BashApprovalGrant,
  type BashProjectApprovalGrant,
  type BashRuntime,
  bashApprovalGrantKey,
  bashRuntimeExposesTool,
  type SessionBashPermissionPolicy,
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
import type { AgentControlResult } from "../tools/agent-control.ts";
import type { AgentMemoryProposalSource } from "../tools/memory.ts";
import { createProjectInstructionVisibilityState } from "../tools/scoped-project-instructions.ts";
import { isMcpToolInvocation } from "../tools/tool-call.ts";
import {
  formatAgentHistoryDetail,
  formatAgentHistoryList,
  formatAgentTranscript,
  resolveAgentHistoryEntry,
} from "./agent-history-format.ts";
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
  formatInteractiveCommandFailure,
  formatInteractiveGoalCommandOutput,
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
  type InteractiveCompactionCost,
  shouldTrackInteractiveCost,
} from "./interactive-session/cost.ts";
import {
  failedInteractiveDiff,
  formatInteractiveDiffOutput,
  type InteractiveDiffInspection,
  inspectInteractiveDiff,
} from "./interactive-session/diff-inspection.ts";
import { readForkPointPickerSelection } from "./interactive-session/fork-picker.ts";
import { executeInteractiveGoalCommand } from "./interactive-session/goal-command.ts";
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
import { createInteractiveMemoryProposalReview } from "./interactive-session/memory-proposal-approval.ts";
import {
  executeModelSwitchCompaction,
  modelSwitchRequiresCompaction,
} from "./interactive-session/model-switch-compact.ts";
import { readNumberedPickerSelection } from "./interactive-session/numbered-picker.ts";
import type {
  EndEvent,
  EndEventWithCost,
  InteractiveActiveSession,
  InteractiveComposerMode,
  InteractiveInvocationAccounting,
  InteractiveResolvedProvider,
  InteractiveSessionOptions,
  InteractiveSessionResult,
  InteractiveSkillRuntime,
  ProviderSelection,
  ReviewedInteractiveActiveSession,
  SavedInteractiveSession,
} from "./interactive-session/types.ts";
import { createInteractiveSubagentSession } from "./interactive-subagent-session.ts";
import { createMcpPermissionPolicy } from "./mcp-approval.ts";
import {
  createCliMcpAuthProvider,
  createCliMcpConnectionFactory,
} from "./mcp-connection.ts";
import {
  formatLiveSessionGoalStatus,
  formatSubagentProgress,
  formatUndoCheckpointList,
  formatUndoCheckpointWarning,
  sanitizeStatusLineText,
} from "./output.ts";
import { projectRoot } from "./project-root.ts";
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
import { createCliSubagentRuntime } from "./subagent-runtime.ts";

export type {
  InteractiveActiveSession,
  InteractiveActiveSessionState,
  InteractiveForkSessionRequest,
  InteractiveInvocationState,
  InteractiveResolvedProvider,
  InteractiveSessionOptions,
  InteractiveSessionResult,
  InteractiveSkillRuntime,
  SavedInteractiveSession,
} from "./interactive-session/types.ts";

type ManagedInteractiveSkillRuntime = Extract<
  InteractiveSkillRuntime,
  { readonly kind: "managed" }
>;

interface InteractiveSkillCheckpoint {
  readonly runtime: ManagedInteractiveSkillRuntime;
  readonly state: SkillLifecycleState;
}

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
const RUNTIME_SUBAGENT_NOTIFICATION_ORIGIN = {
  type: "runtime_subagent_notification",
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

interface PromptTurnRequest {
  readonly userMessage: string;
  readonly userMessageOrigin: OrdinaryUserMessageOrigin;
  readonly consumedInputLines: readonly QueuedLine[];
  readonly runTrigger: RunReportAgentRunTrigger;
  readonly runtimeOutcome?: SessionGoalRuntimeOutcome;
  readonly recoveringTask?: {
    readonly provider: SessionModelSelection;
    readonly runId: string;
  };
}

interface PendingGoalDrive {
  readonly message: string;
  readonly origin: OrdinaryUserMessageOrigin;
  readonly taskTrigger: Extract<
    RunReportTaskTrigger,
    "goal_activation" | "goal_resume"
  >;
  readonly runTrigger: Extract<
    RunReportAgentRunTrigger,
    "goal_activation" | "goal_resume"
  >;
}

type PromptTurnResult =
  | { readonly kind: "aborted" }
  | { readonly kind: "cost_budget" }
  | {
      readonly kind: "completed";
      readonly stagnationFingerprint: string | null;
    };

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

function isReviewedInteractiveActiveSession(
  activeSession: InteractiveActiveSession,
): activeSession is ReviewedInteractiveActiveSession {
  return activeSession.memory.kind === "reviewed";
}

export async function runInteractiveSession(
  options: InteractiveSessionOptions,
): Promise<InteractiveSessionResult> {
  const now = options.now ?? Date.now;
  const activeSession = options.activeSession;
  const initialState = activeSession.state;
  const savedSession =
    activeSession.kind === "saved" ? activeSession.persistence : null;
  const backgroundAgentsEnabled =
    savedSession !== null &&
    options.delegation !== undefined &&
    options.agentHistory !== undefined;
  const hiddenWorkspacePaths = options.hiddenWorkspacePaths ?? [];
  const undoProtection =
    options.undoProtection ?? createUndoProtectionTracker();
  const skillRuntime = options.skills;
  const managedSkills: ManagedInteractiveSkillRuntime | null =
    skillRuntime.kind === "managed" ? skillRuntime : null;
  const activeWorkflowSkills = (): readonly WorkflowSkill[] =>
    managedSkills === null
      ? []
      : managedSkills.activation.active().map(workflowSkillFromActivation);
  const explicitSkillActivations: SkillActivationRecord[] =
    managedSkills === null
      ? [...(options.priorExplicitSkillActivations ?? [])]
      : [
          ...(options.priorExplicitSkillActivations ?? []),
          ...managedSkills.initialActivationRecords,
        ];
  const inactiveImplicitSkills = () => {
    if (managedSkills === null) return [];
    const activePackageIds = new Set(
      managedSkills.activation
        .active()
        .map((activation) => activation.packageId),
    );
    return managedSkills.implicitSkills.filter(
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
  const ledger = sessionLedgerFromMessages(initialState.messages);
  let taskProgress = copySessionTaskProgress(initialState.taskProgress);
  let sessionTitle = initialState.title;
  let sessionGoal =
    initialState.goal === undefined
      ? undefined
      : copySessionGoal(initialState.goal);
  let pendingGoalDrive: PendingGoalDrive | null = null;
  const reportRecorder =
    options.reportRecorder ?? createAgentEventReportRecorder();
  reportRecorder.recordSkillCatalog({
    exposed: latestCatalogExposure.skills.length,
    omitted: latestCatalogExposure.omitted,
    total: latestCatalogExposure.total,
    budgetChars: latestCatalogExposure.budgetChars,
    usedChars: latestCatalogExposure.usedChars,
  });
  const inputDisposition = createInteractiveInputDispositionTracker();
  const setComposerMode = (mode: InteractiveComposerMode): void => {
    inputDisposition.setComposerMode(mode);
    options.setComposerMode?.(mode);
  };
  const baseSystemPromptWithGoal = (): string =>
    systemPromptWithSessionGoal(
      options.delegation !== undefined
        ? appendDelegationToSystemPrompt(
            systemPrompt,
            options.delegation.policy,
            {
              background: backgroundAgentsEnabled,
              nestedReadOnly: options.delegation.policy === "explicit",
              writer: options.delegation.policy === "explicit",
            },
          )
        : systemPrompt,
      sessionGoal,
      bashRuntimeExposesTool(bash),
    );
  const currentSystemPrompt = (): string =>
    appendWorkflowSkillsToSystemPrompt(
      baseSystemPromptWithGoal(),
      activeWorkflowSkills(),
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
    request: Parameters<SavedInteractiveSession["persistGoal"]>[0],
  ): SessionGoal | undefined => {
    const persisted = savedSession?.persistGoal(request);
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
          !isMcpToolInvocation(event.toolCall) &&
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
    ...initialState.bashApprovalGrants,
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
    initialQueuedInputs: initialState.queuedInputs,
    ...(options.initialInputLines !== undefined
      ? { initialInputLines: options.initialInputLines }
      : {}),
    ...(savedSession !== null
      ? { persistQueuedInput: savedSession.persistQueuedInput }
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
  let mcpRuntime: McpRuntime | undefined;
  const ensureMcpRuntime = (
    schemaTarget: McpProviderSchemaTarget,
  ): McpRuntime | undefined => {
    if (options.mcp === undefined) return undefined;
    mcpRuntime ??= createMcpRuntime({
      servers: options.mcp.servers,
      connectionFactory: options.mcp.connectionFactory,
      lifecycle: options.mcp.lifecycle,
      permission: createMcpPermissionPolicy({
        runtime: options.mcp.approvalRuntime,
        projectRoot: projectRoot(options.workspace),
        prompt: options.mcp.canPrompt
          ? {
              kind: "interactive",
              lineReader,
              writeStderr: options.writeStderr,
              onPromptStart: () => {
                setComposerMode("approval");
              },
              onPromptEnd: () => {
                setComposerMode("steer");
              },
            }
          : {
              kind: "headless",
              deniedMessage:
                "MCP calls require an exact saved project approval and this session cannot prompt.",
            },
      }),
      now,
      schemaTarget,
    });
    return mcpRuntime;
  };
  const subagentMcpOptions = options.mcp;
  const subagentMcp =
    subagentMcpOptions === undefined
      ? undefined
      : {
          servers: subagentMcpOptions.servers,
          connectionFactory: (
            authorizationIdentity: McpAuthorizationIdentity,
          ) =>
            createCliMcpConnectionFactory(
              subagentMcpOptions.approvalRuntime,
              authorizationIdentity,
            ),
          lifecycle: subagentMcpOptions.lifecycle,
          permission: createMcpPermissionPolicy({
            runtime: subagentMcpOptions.approvalRuntime,
            projectRoot: projectRoot(options.workspace),
            prompt: {
              kind: "headless" as const,
              deniedMessage:
                "Child MCP calls require an exact saved project approval and cannot prompt.",
            },
          }),
          authorizationIdentity: async (server: McpRuntimeServer) =>
            await createCliMcpAuthProvider(
              subagentMcpOptions.approvalRuntime,
              server,
            ).authorizationIdentity(),
        };
  const reviewedMemory = isReviewedInteractiveActiveSession(activeSession)
    ? {
        ...activeSession,
        review: createInteractiveMemoryProposalReview(
          lineReader,
          options.writeStderr,
          {
            onPromptStart: () => {
              setComposerMode("approval");
            },
            onPromptEnd: () => {
              setComposerMode("steer");
            },
          },
        ),
      }
    : null;
  const memoryProposalSources = new WeakMap<
    Extract<SessionMessage, { readonly role: "user" }>,
    AgentMemoryProposalSource
  >();
  const reservedSessionMessageIds: {
    readonly message: SessionMessage;
    readonly id: string;
  }[] = [];
  const reserveMemoryProposalSource = (
    message: Extract<SessionMessage, { readonly role: "user" }>,
    provider: InteractiveResolvedProvider,
  ): void => {
    if (reviewedMemory === null) {
      return;
    }
    const messageId = reviewedMemory.persistence.reserveMessageId();
    reservedSessionMessageIds.push({ message, id: messageId });
    memoryProposalSources.set(message, {
      sessionId: reviewedMemory.persistence.id,
      messageId,
      providerId: provider.providerId,
      model: provider.model,
    });
  };
  const bash: BashRuntime<SessionBashPermissionPolicy> =
    options.cliArgs.bashMode === "disabled"
      ? { kind: "disabled" }
      : options.cliArgs.bashMode === "trusted"
        ? { kind: "trusted" }
        : {
            kind: "reviewed",
            permission:
              options.bashPermission ??
              interactiveBashPermissionPolicy(lineReader, options.writeStderr, {
                initialGrants: initialState.bashApprovalGrants,
                onGrant: (grant) => {
                  savedSession?.persistBashApprovalGrant(grant);
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
              }),
          };
  const bashPermission = bash.kind === "reviewed" ? bash.permission : undefined;
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
  const initialInvocationAccounting = options.initialInvocationAccounting;
  let sessionUsage = initialInvocationAccounting?.usage ?? EMPTY_USAGE;
  let sessionAgentLoopTurns = initialInvocationAccounting?.agentLoopTurns ?? 0;
  let sessionPromptTurnAttempted =
    initialInvocationAccounting?.promptTurnAttempted ?? false;
  let sessionEndObserved = initialInvocationAccounting?.endObserved ?? false;
  let sessionCostUsd = initialInvocationAccounting?.costUsd ?? 0;
  let sessionCostBudgetLimited =
    initialInvocationAccounting?.costBudgetLimited ?? false;
  let sessionStopReason =
    initialInvocationAccounting?.stopReason ?? "completed";
  let modelSwitchCount = initialState.modelSwitchCount;
  const resolveActiveProvider = (
    userMessage: string,
  ): InteractiveResolvedProvider => {
    resolved ??= options.resolveProvider(
      userMessage,
      initialState.modelSelection,
    );
    return resolved;
  };
  const reportModelOperations = (
    operationResolved: InteractiveResolvedProvider,
    owner: ModelOperationOwner,
  ): MainModelOperationInstrumentation | null =>
    options.cliArgs.reportFile === undefined
      ? null
      : {
          recorder: reportRecorder,
          owner,
          provider: operationResolved.providerId,
          model: operationResolved.model,
          costModel: options.requireKnownCostModel(operationResolved),
        };
  const resolveSubagentExecution = (
    userMessage: string,
    selection: ProviderSelection,
  ) => {
    const child = options.resolveProvider(userMessage, selection);
    const childModelMaxOutputTokens = modelMetadataMaxOutputTokens(
      child.modelMetadata,
    );
    return {
      provider: child.provider,
      providerId: child.providerId,
      model: child.model,
      costModel: options.requireKnownCostModel(child),
      modelMetadata: child.modelMetadata ?? { status: "unknown" as const },
      ...(child.contextCompaction !== undefined
        ? { contextCompaction: child.contextCompaction }
        : {}),
      ...(childModelMaxOutputTokens !== undefined
        ? { modelMaxOutputTokens: childModelMaxOutputTokens }
        : {}),
    };
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
    savedSession?.consumeQueuedInputs(inputIds);
  };
  const userMessageOriginForPromptInput = (
    lines: readonly QueuedLine[],
  ): OrdinaryUserMessageOrigin =>
    queuedInputIds(lines).length === 0
      ? USER_PROMPT_ORIGIN
      : QUEUED_FOLLOWUP_ORIGIN;
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
  const currentCompactionCost = (
    operationResolved: InteractiveResolvedProvider,
  ): InteractiveCompactionCost => {
    if (!shouldTrackInteractiveCost(options.cliArgs)) {
      return { kind: "untracked" };
    }
    const model = options.requireKnownCostModel(operationResolved);
    const maxCostUsd = options.cliArgs.maxCostUsd;
    if (maxCostUsd === undefined) {
      return { kind: "tracked", model };
    }
    return {
      kind: "budgeted",
      model,
      maxCostUsd,
      admission:
        subagentSession === null
          ? {
              kind: "isolated",
              remainingCostUsd: Math.max(0, maxCostUsd - sessionCostUsd),
            }
          : {
              kind: "shared",
              account: subagentSession.sharedCostBudget,
              providerCoordination: subagentSession.providerCoordination,
            },
      budgetLimitedReport: () => {
        sessionCostBudgetLimited = true;
        return buildSessionCostBudgetLimitedReport(sessionCostUsd, maxCostUsd);
      },
    };
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
      ? initialState.modelSelection === undefined
        ? options.configuredModelSelection === undefined
          ? "(default for next prompt)"
          : formatConfiguredModelSelection(options.configuredModelSelection)
        : formatModelSelection(initialState.modelSelection)
      : formatActiveModel(resolved);
  const statusRecoveryActions = () => [
    ...(savedSession === null || savedSession.resumeAvailable() === false
      ? []
      : [
          {
            label: "resume",
            command: `keel --resume ${savedSession.id}`,
          },
        ]),
    ...(savedSession === null
      ? []
      : [
          {
            label: "sessions",
            command: "/sessions",
          },
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
    if (end.cost?.budget.kind === "budget_limited") {
      sessionCostBudgetLimited = true;
    }
    const turnCostUsd = end.cost?.spentUsd ?? 0;
    if (end.cost === undefined) {
      return undefined;
    }
    sessionCostUsd += turnCostUsd;
    return currentSessionCostReport();
  };
  const subagentOwner =
    backgroundAgentsEnabled &&
    options.delegation !== undefined &&
    options.agentHistory !== undefined
      ? {
          delegation: options.delegation,
          session: createInteractiveSubagentSession({
            maxCostUsd: options.delegation.maxCostUsd,
            initialCostUsd: sessionCostUsd,
            history: options.agentHistory,
            now,
            writeStderr: options.writeStderr,
            onBackgroundSettled: (result) => {
              sessionUsage = addUsage(sessionUsage, result.usage);
              sessionCostUsd += result.costUsd;
              if (
                options.cliArgs.maxCostUsd !== undefined &&
                sessionCostUsd >= options.cliArgs.maxCostUsd
              ) {
                sessionCostBudgetLimited = true;
              }
            },
          }),
        }
      : null;
  const subagentSession = subagentOwner?.session ?? null;
  const invocationAccounting = (): InteractiveInvocationAccounting => ({
    usage: sessionUsage,
    agentLoopTurns: sessionAgentLoopTurns,
    promptTurnAttempted: sessionPromptTurnAttempted,
    endObserved: sessionEndObserved,
    costUsd: sessionCostUsd,
    costBudgetLimited: sessionCostBudgetLimited,
    stopReason: sessionStopReason,
  });
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
    const limitedGoalWithoutOutcome: SessionGoal =
      status === "budget_limited"
        ? {
            objective: activeGoal.objective,
            status: "budget_limited",
            statusReason: reason,
            ...sessionGoalAccounting(activeGoal),
            ...sessionGoalCompletionContract(activeGoal),
          }
        : {
            objective: activeGoal.objective,
            status: "usage_limited",
            statusReason: reason,
            ...sessionGoalAccounting(activeGoal),
            ...sessionGoalCompletionContract(activeGoal),
          };
    const limitedGoal = withSessionGoalRuntimeOutcome(
      limitedGoalWithoutOutcome,
      { kind: "limit_reached", reason },
    );
    updateSessionGoal(limitedGoal);
    const persistedGoal = savedSession?.persistGoal({
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
    const skillStateBeforeTurn =
      managedSkills === null
        ? null
        : {
            runtime: managedSkills,
            state: managedSkills.activation.state(),
          };
    managedSkills?.activation.beginTurn();
    const goalTurnStartedAt = sessionGoal?.status === "active" ? now() : null;
    const turnProvider =
      request.recoveringTask === undefined
        ? resolveActiveProvider(request.userMessage)
        : resolveSelectedProvider(
            options,
            request.userMessage,
            request.recoveringTask.provider,
          );
    resolved = turnProvider;
    const currentUserMessage = {
      role: "user",
      content: request.userMessage,
      origin: request.userMessageOrigin,
    } as const;
    const durableTaskTurn =
      savedSession?.taskRecovery !== undefined &&
      (request.runTrigger === "user_prompt" ||
        request.recoveringTask !== undefined);
    let durableTaskRunId = request.recoveringTask?.runId;
    if (request.recoveringTask === undefined) {
      reserveMemoryProposalSource(currentUserMessage, turnProvider);
    }
    const schemaTarget = mcpProviderSchemaTarget(
      turnProvider.providerId,
      turnProvider.model,
    );
    const turnMcpRuntime = ensureMcpRuntime(schemaTarget);
    const turnModelOperations = reportModelOperations(resolved, {
      type: "current_agent_run",
    });
    const backgroundModelOperations =
      subagentSession === null
        ? undefined
        : (reportModelOperations(resolved, { type: "session" }) ?? undefined);
    const exposure = exposeSkillCatalog({
      skills: inactiveImplicitSkills(),
      request: request.userMessage,
      ...(resolved.modelMetadata !== undefined
        ? { modelMetadata: resolved.modelMetadata }
        : {}),
    });
    latestCatalogExposure = exposure;
    reportRecorder.recordSkillCatalog({
      exposed: exposure.skills.length,
      omitted: exposure.omitted,
      total: exposure.total,
      budgetChars: exposure.budgetChars,
      usedChars: exposure.usedChars,
    });
    managedSkills?.activation.expose(exposure.skills);
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
    subagentSession?.assertHealthy();
    const agentHistory = options.agentHistory;
    if (savedSession !== null && agentHistory !== undefined) {
      for (const delivery of agentHistory.pendingResultDeliveries(
        sessionLedgerMessages(ledger),
      )) {
        const notification: SessionMessage = {
          role: "user",
          content: delivery.projection,
          origin: RUNTIME_SUBAGENT_NOTIFICATION_ORIGIN,
          subagentResultDelivery: {
            sessionId: delivery.sessionId,
            delegationId: delivery.delegationId,
            childAgentId: delivery.childAgentId,
            childRunId: delivery.childRunId,
            canonicalResultSha256: delivery.canonicalResultSha256,
          },
        };
        ledger.append(notification);
        savedSession.persistMessages({
          messages: sessionLedgerMessages(ledger),
          reason: "turn",
          consumedInputIds: [],
          skillState: null,
          reservedMessageIds: [],
        });
        agentHistory.deliveredResult(delivery);
      }
    }
    if (durableTaskTurn && request.recoveringTask === undefined) {
      const userMessageId = reservedSessionMessageIds.find(
        (reservation) => reservation.message === currentUserMessage,
      )?.id;
      durableTaskRunId = savedSession.taskRecovery.admit({
        userMessage: currentUserMessage,
        provider: modelSelectionFromResolved(turnProvider),
        consumedInputIds: queuedInputIds(request.consumedInputLines),
        ...(userMessageId === undefined ? {} : { userMessageId }),
      }).runId;
    }
    const messagesBeforeTurn = [...sessionLedgerMessages(ledger)];
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
    if (request.recoveringTask === undefined) {
      ledger.append(currentUserMessage);
    }
    let persistedMemorySourceMessages: readonly SessionMessage[] | null = null;
    let persistedDrainedInputCount = 0;
    const persistedInputIds = new Set<string>();
    const memoryProposal =
      reviewedMemory === null
        ? null
        : {
            capability: reviewedMemory.memory.proposal,
            sourceFor: (
              message: Extract<SessionMessage, { readonly role: "user" }>,
            ) => memoryProposalSources.get(message),
            persistSource: (
              sourceMessage: Extract<SessionMessage, { readonly role: "user" }>,
            ): void => {
              const currentMessages = sessionLedgerMessages(ledger);
              const sourceIndex = currentMessages.indexOf(sourceMessage);
              assert(
                sourceIndex >= 0,
                "reviewed project-memory source is no longer present in the interactive session",
              );
              const sourceMessages = currentMessages.slice(0, sourceIndex + 1);
              const sourceReservations = reservedSessionMessageIds.filter(
                (reservation) => sourceMessages.includes(reservation.message),
              );
              const sourceInputIds = queuedInputIds([
                ...request.consumedInputLines,
                ...drainedInjectedLines,
              ]);
              if (!(durableTaskTurn && sourceMessage === currentUserMessage)) {
                reviewedMemory.persistence.persistMessages({
                  messages: sourceMessages,
                  reason: "turn",
                  consumedInputIds: sourceInputIds,
                  skillState: null,
                  reservedMessageIds: sourceReservations,
                });
              }
              persistedMemorySourceMessages = sourceMessages;
              persistedDrainedInputCount = drainedInjectedLines.length;
              for (const inputId of sourceInputIds) {
                persistedInputIds.add(inputId);
              }
              reservedSessionMessageIds.splice(
                0,
                reservedSessionMessageIds.length,
              );
            },
            review: reviewedMemory.review,
          };
    const agentMemory =
      activeSession.memory.kind === "disabled"
        ? undefined
        : memoryProposal === null
          ? {
              kind: "direct" as const,
              prompt: activeSession.memory.prompt,
              mutation: activeSession.memory.mutation,
            }
          : {
              kind: "reviewed" as const,
              prompt: activeSession.memory.prompt,
              mutation: activeSession.memory.mutation,
              proposal: memoryProposal,
            };
    let deferRemainingInjectedInput = false;
    let taskProgressChanged = false;
    let sessionGoalStateChanged = false;
    let sessionGoalUpdateReportedDuringTurn = false;
    const restoreInterruptedTurnState = (): void => {
      if (skillStateBeforeTurn !== null) {
        skillStateBeforeTurn.runtime.activation.restore(
          skillStateBeforeTurn.state,
        );
        systemPrompt = rebuildSystemPrompt();
      }
      replaceSessionLedgerMessages(
        ledger,
        persistedMemorySourceMessages ?? messagesBeforeTurn,
      );
      reservedSessionMessageIds.splice(0, reservedSessionMessageIds.length);
      updateTaskProgress(taskProgressBeforeTurn);
      updateSessionGoal(sessionGoalBeforeTurn);
      projectInstructionVisibility.clear();
      projectInstructionVisibility.markInstructionPathsVisible(
        projectInstructionPathsBeforeTurnOldestFirst,
      );
      restoreDrainedInput([
        ...drainedInjectedLines.slice(persistedDrainedInputCount),
        ...deferredInputLines,
      ]);
      consumeQueuedInputLines(
        request.consumedInputLines.filter(
          (line) =>
            line.inputId === undefined || !persistedInputIds.has(line.inputId),
        ),
      );
    };
    setComposerMode("steer");

    try {
      const remainingCostUsd =
        subagentSession === null
          ? options.delegation === undefined
            ? remainingMaxCostUsd()
            : Math.max(0, options.delegation.maxCostUsd - sessionCostUsd)
          : subagentSession.sharedCostBudget.remainingUsd();
      const modelMaxOutputTokens = modelMetadataMaxOutputTokens(
        resolved.modelMetadata,
      );
      const turnCostModel =
        shouldTrackInteractiveCost(options.cliArgs) ||
        options.delegation !== undefined
          ? options.requireKnownCostModel(resolved)
          : undefined;
      const subagentRuntime =
        options.delegation !== undefined &&
        remainingCostUsd !== undefined &&
        turnCostModel !== undefined
          ? await createCliSubagentRuntime({
              workspace: options.workspace,
              workspaceLeasesRoot: options.workspaceLeasesRoot,
              platform: options.platform,
              /* v8 ignore next -- the fallback is the pre-existing ephemeral parent identity; C2 changes only durable Task correlation. */
              parentRunId: durableTaskRunId ?? `interactive-${randomUUID()}`,
              provider: resolved.provider,
              providerId: resolved.providerId,
              model: resolved.model,
              policy: options.delegation.policy,
              costModel: turnCostModel,
              modelMetadata: resolved.modelMetadata ?? {
                status: "unknown" as const,
              },
              maxCostUsd: remainingCostUsd,
              projectInstructions: options.projectInstructions,
              hiddenWorkspacePaths,
              ...(managedSkills !== null
                ? { skillCatalog: managedSkills.catalog }
                : {}),
              ...(subagentMcp !== undefined ? { mcp: subagentMcp } : {}),
              contextCompaction: resolved.contextCompaction,
              modelMaxOutputTokens,
              modelOperations: turnModelOperations ?? undefined,
              transcriptStore: options.delegation.transcriptStore,
              ...(subagentSession !== null
                ? {
                    attachedSession: {
                      lifecyclePersistence:
                        subagentSession.lifecyclePersistence,
                      costBudget: subagentSession.sharedCostBudget,
                      admission: subagentSession.sharedAdmission,
                      providerCoordination:
                        subagentSession.providerCoordination,
                      background: subagentSession.background,
                      modelOperations: backgroundModelOperations,
                    },
                  }
                : {}),
              now,
              onProgress: (event) => {
                options.writeStderr(formatSubagentProgress(event));
              },
              resolveProvider: (selection) =>
                resolveSubagentExecution(request.userMessage, selection),
            })
          : undefined;
      const stream = observeAgentStateEvents(
        runAgentTurn({
          workspace: options.workspace,
          provider: resolved.provider,
          ledger,
          systemPrompt: baseSystemPromptWithGoal(),
          ...(agentMemory !== undefined ? { memory: agentMemory } : {}),
          signal: turnAbortController.signal,
          bash,
          ...(subagentRuntime !== undefined
            ? { delegation: subagentRuntime.supervisor.capability }
            : {}),
          ...(subagentSession !== null && subagentRuntime !== undefined
            ? {
                agentControl: subagentSession.control,
                agentControlResultBudget:
                  subagentRuntime.supervisor.resultContinuationBudget,
              }
            : {}),
          ...(subagentRuntime !== undefined
            ? { costBudgetProvider: subagentRuntime.costBudgetProvider }
            : {}),
          ...(turnMcpRuntime !== undefined
            ? {
                mcp: {
                  runtime: turnMcpRuntime,
                  schemaTarget,
                },
              }
            : {}),
          hiddenWorkspacePaths,
          ...(managedSkills !== null
            ? { skillActivation: managedSkills.activation }
            : {}),
          stopPolicy: defaultStopPolicy(),
          taskProgress,
          ...(sessionGoal !== undefined ? { sessionGoal } : {}),
          ...(turnCostModel !== undefined
            ? {
                costTracking: {
                  model: turnCostModel,
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
          ...(durableTaskTurn
            ? {
                providerRecovery: savedSession.taskRecovery.providerLifecycle(
                  modelSelectionFromResolved(turnProvider),
                  {
                    /* v8 ignore next 3 -- the named-session steering subprocess test exercises this child-runtime callback before the second provider request. */
                    pendingInputIds: () =>
                      queuedInputIds(drainedInjectedLines).filter(
                        (inputId) => !persistedInputIds.has(inputId),
                      ),
                    /* v8 ignore next 5 -- the same subprocess test proves the selected ids are committed exactly once. */
                    committed: (inputIds) => {
                      for (const inputId of inputIds) {
                        persistedInputIds.add(inputId);
                      }
                    },
                  },
                ),
              }
            : {}),
          ...(options.toolOutputArtifacts !== undefined
            ? { toolOutputArtifacts: options.toolOutputArtifacts }
            : {}),
          readVisibility,
          projectInstructionVisibility,
          recordCheckpointOperations: (operations) => {
            checkpointOperations.push(...operations);
          },
          onAgentLoopAccountingUpdated: (accounting) => {
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
              const injectedMessage = {
                role: "user",
                content: content.line,
                origin: STEER_ORIGIN,
              } as const;
              reserveMemoryProposalSource(injectedMessage, turnProvider);
              return injectedMessage;
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
      let finalEnd: EndEvent | undefined;
      const detachContinuation =
        subagentSession !== null && subagentRuntime !== undefined
          ? subagentSession.continuation.attach(
              subagentRuntime.supervisor.continuation,
            )
          : null;
      try {
        try {
          finalEnd = await options.printAgentEvents(
            recordAgentEventStream(stream, reportRecorder),
          );
        } catch (error) {
          if (!isAbortThrow(error, turnAbortController.signal)) {
            reportRecorder.failAgentRun();
            restoreInterruptedTurnState();
          }
          throw error;
        }
      } finally {
        detachContinuation?.();
      }
      if (turnAbortController.signal.aborted) {
        abortReportedAgentRun(finalEnd);
        restoreInterruptedTurnState();
        options.writeStdout("\n");
        return { kind: "aborted" };
      }
      if (finalEnd === undefined) {
        abortReportedAgentRun(undefined, false);
      } else {
        reportRecorder.completeAgentRun(finalEnd.turns, finalEnd.stopReason);
      }
      restoreDrainedInput(deferredInputLines);
      const completedSkillState =
        skillStateBeforeTurn === null
          ? null
          : skillStateBeforeTurn.runtime.activation.state();
      const changedSkillState =
        skillStateBeforeTurn !== null &&
        completedSkillState !== null &&
        !skillLifecycleStatesEqual(
          skillStateBeforeTurn.state,
          completedSkillState,
        )
          ? completedSkillState
          : null;
      /* v8 ignore else -- durable Task completion and budget paths run in the named-session subprocess suite and are verified at the recovery-owner boundary. */
      if (!durableTaskTurn) {
        savedSession?.persistMessages({
          messages: sessionLedgerMessages(ledger),
          reason: "turn",
          consumedInputIds: [
            ...queuedInputIds(request.consumedInputLines),
            ...queuedInputIds(drainedInjectedLines),
          ].filter((inputId) => !persistedInputIds.has(inputId)),
          skillState: changedSkillState,
          reservedMessageIds: reservedSessionMessageIds,
        });
      } else if (finalEnd?.stopReason === "cost_budget") {
        savedSession.taskRecovery.blockProviderBudget(
          sessionLedgerMessages(ledger),
        );
      } else {
        savedSession.taskRecovery.terminal({
          messages: sessionLedgerMessages(ledger),
          outcome: "completed",
          ...(changedSkillState === null
            ? {}
            : { skillState: changedSkillState }),
          consumedInputIds: queuedInputIds(drainedInjectedLines).filter(
            (inputId) => !persistedInputIds.has(inputId),
          ),
        });
      }
      reservedSessionMessageIds.splice(0, reservedSessionMessageIds.length);
      if (changedSkillState !== null) {
        systemPrompt = rebuildSystemPrompt();
      }
      if (savedSession !== null) {
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
          savedSession.persistTaskProgress(update);
          lastPersistedTurnProgress = copySessionTaskProgress(
            update.taskProgress,
          );
        }
      }
      if (savedSession !== null) {
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
          messages: sessionLedgerMessages(ledger),
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
            !isMcpToolInvocation(execution.toolCall) &&
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
            : successfulVerification !== undefined &&
                !isMcpToolInvocation(successfulVerification.toolCall) &&
                successfulVerification.toolCall.tool === "bash"
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
          const persistedAccountedGoal = savedSession?.persistGoal({
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
        options.writeStderr(options.formatCostReport(cumulativeCost));
      }
      if (
        finalEnd?.stopReason === "cost_budget" ||
        cumulativeCost?.budget.kind === "budget_limited"
      ) {
        sessionStopReason = "cost_budget";
        limitActiveGoal("budget_limited", GOAL_BUDGET_LIMIT_REASON);
        return { kind: "cost_budget" };
      }
      return {
        kind: "completed",
        stagnationFingerprint,
      };
    } catch (error) {
      if (!turnAbortController.signal.aborted) {
        throw error;
      }
      abortReportedAgentRun();
      restoreInterruptedTurnState();
      options.writeStdout("\n");
      return { kind: "aborted" };
    } finally {
      if (checkpointOperations.length > 0) {
        let result: RecordUndoCheckpointResult;
        if (durableTaskTurn) {
          assert(
            savedSession !== null,
            "durable Task turn lost its saved session",
          );
          const durableResult = savedSession.taskRecovery.finalizeCheckpoint();
          /* v8 ignore next 5 -- every durable mutation is checkpointed before settlement; retain the ordinary recorder only as a last-resort undo safeguard. */
          result =
            durableResult ??
            recordLastTaskCheckpoint({
              workspace: options.workspace,
              operations: checkpointOperations,
            });
        } else {
          result = recordLastTaskCheckpoint({
            workspace: options.workspace,
            operations: checkpointOperations,
          });
        }
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
    initialContinuationOrigin: OrdinaryUserMessageOrigin = RUNTIME_GOAL_CONTINUATION_ORIGIN,
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
      if (result.kind === "aborted") {
        return false;
      }
      if (result.kind === "cost_budget") {
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
  const failCurrentReportTask = (): void => {
    if (reportRecorder.hasActiveAgentRun()) {
      reportRecorder.failAgentRun();
    }
    reportRecorder.endTask("failed");
  };
  /* v8 ignore next 8 -- observable coverage runs in the named-session SIGKILL subprocess, outside this instrumented process. */
  const discloseAcceptedUnknownEffects = (
    taskId: string,
    operationIds: readonly string[],
  ): void => {
    options.writeStderr(
      `Warning: durable Task ${taskId} completed_with_unknown_effects; interrupted tool effect count ${operationIds.length} remains unknown under its persisted recovery policy.\n`,
    );
  };

  options.onSigint(abortActiveTurn);
  let preserveInputForSessionSwitch = false;
  try {
    options.onInitialInputLinesAdmitted?.();
    let recoveryPreventsInput = false;
    let recoveryBlockedTaskId: string | null = null;
    if (
      savedSession?.taskRecovery !== undefined &&
      initialState.activeTask !== undefined
    ) {
      const recovery = savedSession.taskRecovery.resume();
      /* v8 ignore start -- directives are covered by recovery-owner tests and named-session subprocess tests; child execution is outside the unit coverage process. */
      switch (recovery.kind) {
        case "none":
          break;
        case "delivered":
          ledger.append(recovery.message);
          if (recovery.message.content !== "") {
            options.writeStdout(recovery.message.content);
          }
          options.writeStdout("\n");
          if (recovery.outcome.outcome === "completed_with_unknown_effects") {
            discloseAcceptedUnknownEffects(
              recovery.outcome.taskId,
              recovery.outcome.unknownToolEffectOperationIds,
            );
          }
          break;
        case "blocked":
          options.writeStderr(
            `Error: recovery_blocked for durable Task ${recovery.task.taskId}: ${recovery.task.reason}.\n`,
          );
          recoveryBlockedTaskId = recovery.task.taskId;
          break;
        case "run": {
          for (const message of recovery.recoveredMessages) {
            ledger.append(message);
          }
          const userMessage = recovery.userMessage;
          if (userMessage.role !== "user") {
            throw new Error(
              "durable Task recovery input is not a user message",
            );
          }
          if (userMessage.subagentResultDelivery !== undefined) {
            throw new Error(
              "durable Task recovery input cannot be a subagent notification",
            );
          }
          reportRecorder.beginTask("user_prompt");
          try {
            const turnResult = await runPromptTurn({
              userMessage: userMessage.content,
              userMessageOrigin: userMessage.origin,
              consumedInputLines: [],
              runTrigger: "user_prompt",
              recoveringTask: {
                provider: recovery.task.provider,
                runId: recovery.task.runId,
              },
            });
            reportRecorder.endTask(
              turnResult.kind === "aborted"
                ? "aborted"
                : turnResult.kind === "completed" &&
                    recovery.task.acceptedUnknownEffectOperationIds.length > 0
                  ? "completed_with_unknown_effects"
                  : undefined,
            );
            if (
              turnResult.kind === "completed" &&
              recovery.task.acceptedUnknownEffectOperationIds.length > 0
            ) {
              discloseAcceptedUnknownEffects(
                recovery.task.taskId,
                recovery.task.acceptedUnknownEffectOperationIds,
              );
            }
            if (turnResult.kind === "cost_budget") {
              recoveryPreventsInput = true;
            }
          } catch (error) {
            failCurrentReportTask();
            throw error;
          } finally {
            resolved = null;
          }
          break;
        }
      }
      /* v8 ignore stop */
    }
    for (;;) {
      /* v8 ignore next -- the named-session recovery budget subprocess proves the child exits before accepting more input. */
      if (recoveryPreventsInput) break;
      if (pendingGoalDrive !== null) {
        if (sessionGoal?.status !== "active") {
          pendingGoalDrive = null;
        } else if (lineReader.pendingInputCount() === 0) {
          const drive = pendingGoalDrive;
          pendingGoalDrive = null;
          reportRecorder.beginTask(drive.taskTrigger);
          try {
            const shouldStop = await runAutomaticGoalContinuations(
              drive.message,
              drive.runTrigger,
              drive.origin,
            );
            reportRecorder.endTask(taskOutcomeForGoal(true));
            if (shouldStop) {
              break;
            }
          } catch (error) {
            failCurrentReportTask();
            throw error;
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
        let activationRollback: InteractiveSkillCheckpoint | null = null;
        try {
          if (skillRuntime.kind === "unavailable") {
            throw new WorkflowSkillError(skillRuntime.reason);
          }
          if (skillRuntime.kind === "empty") {
            throw new Error("explicit skill activation is unavailable");
          }
          const skill = skillRuntime.loadExplicit(explicitInvocation.lookup);
          activationRollback = {
            runtime: skillRuntime,
            state: skillRuntime.activation.state(),
          };
          const activation = skillRuntime.activation.activateExplicit(
            skill,
            explicitInvocation.arguments,
          );
          if (
            !skillLifecycleStatesEqual(
              activationRollback.state,
              skillRuntime.activation.state(),
            )
          ) {
            savedSession?.persistSkillState(skillRuntime.activation.state());
          }
          if (activation.record !== undefined) {
            explicitSkillActivations.push(activation.record);
          }
          systemPrompt = rebuildSystemPrompt();
          userMessage =
            explicitInvocation.arguments === ""
              ? "Apply the explicitly selected workflow skill."
              : explicitInvocation.arguments;
        } catch (error) {
          if (activationRollback !== null) {
            activationRollback.runtime.activation.restore(
              activationRollback.state,
            );
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
            session:
              savedSession === null
                ? "(ephemeral, not persisted)"
                : savedSession.id,
            ...(sessionTitle !== undefined ? { title: sessionTitle } : {}),
            workspace: options.workspace,
            activeModel: activeModelStatus(),
            ...(sessionGoal !== undefined ? { goal: sessionGoal } : {}),
            workflowSkills: activeWorkflowSkills(),
            skillCatalog: {
              exposed: latestCatalogExposure.skills.length,
              omitted: latestCatalogExposure.omitted,
              total: latestCatalogExposure.total,
              budgetChars: latestCatalogExposure.budgetChars,
            },
            messages: sessionLedgerMessages(ledger),
            messageCount: sessionLedgerMessages(ledger).length,
            pendingInputCount: lineReader.pendingInputCount(),
            bashApprovalCount:
              activeBashApprovalGrants().length +
              activeProjectBashApprovalGrants.length,
            taskProgress,
            modelSwitchCount,
            undoCheckpoints: listUndoCheckpoints(options.workspace),
            undoProtection: undoProtection.summary(),
            memory: activeSession.memory.status(),
            recoveryActions: statusRecoveryActions(),
          }),
        );
        consumeQueuedInputLines([rawInput]);
        continue;
      }
      if (interactiveCommand?.kind === "agents") {
        if (options.agentHistory === undefined) {
          options.writeStderr(
            "Error: /agents requires a saved interactive session.\n",
          );
          consumeQueuedInputLines([rawInput]);
          continue;
        }
        if (interactiveCommand.action === "list") {
          options.writeStdout(formatAgentHistoryList(options.agentHistory));
          consumeQueuedInputLines([rawInput]);
          continue;
        }
        const entry = resolveAgentHistoryEntry(
          options.agentHistory,
          interactiveCommand.selector,
        );
        if (entry === null) {
          options.writeStderr(
            `Error: no subagent matches "${interactiveCommand.selector}".\n`,
          );
          consumeQueuedInputLines([rawInput]);
          continue;
        }
        try {
          if (interactiveCommand.action === "show") {
            options.writeStdout(formatAgentHistoryDetail(entry));
          } else if (interactiveCommand.action === "transcript") {
            options.writeStdout(
              formatAgentTranscript(options.agentHistory, entry),
            );
          } else if (subagentOwner === null) {
            options.writeStderr(
              "Error: live agent control requires an attached saved-session owner.\n",
            );
          } else {
            const { delegation, session: subagentSession } = subagentOwner;
            const commandAbortController = new AbortController();
            activeAbortController = commandAbortController;
            setComposerMode("queue");
            try {
              let result: AgentControlResult;
              if (interactiveCommand.action === "wait") {
                result = await subagentSession.control.wait({
                  id: entry.childAgentId,
                  signal: commandAbortController.signal,
                  maxResultChars: MAX_SUBAGENT_RESULT_CHARS,
                });
              } else if (interactiveCommand.action === "cancel") {
                result = await subagentSession.control.cancel({
                  id: entry.childAgentId,
                  signal: commandAbortController.signal,
                  maxResultChars: MAX_SUBAGENT_RESULT_CHARS,
                });
              } else if (interactiveCommand.action === "input") {
                result = subagentSession.control.input({
                  id: entry.childAgentId,
                  message: interactiveCommand.message,
                  signal: commandAbortController.signal,
                  maxResultChars: MAX_SUBAGENT_RESULT_CHARS,
                });
              } else {
                const commandResolved = resolveActiveProvider(
                  interactiveCommand.message,
                );
                const commandCostModel =
                  options.requireKnownCostModel(commandResolved);
                const commandRuntime = await createCliSubagentRuntime({
                  workspace: options.workspace,
                  workspaceLeasesRoot: options.workspaceLeasesRoot,
                  platform: options.platform,
                  parentRunId: `interactive-${randomUUID()}`,
                  provider: commandResolved.provider,
                  providerId: commandResolved.providerId,
                  model: commandResolved.model,
                  policy: delegation.policy,
                  costModel: commandCostModel,
                  modelMetadata: commandResolved.modelMetadata ?? {
                    status: "unknown" as const,
                  },
                  maxCostUsd: subagentSession.sharedCostBudget.remainingUsd(),
                  projectInstructions: options.projectInstructions,
                  hiddenWorkspacePaths,
                  ...(managedSkills !== null
                    ? { skillCatalog: managedSkills.catalog }
                    : {}),
                  ...(subagentMcp !== undefined ? { mcp: subagentMcp } : {}),
                  contextCompaction: commandResolved.contextCompaction,
                  modelMaxOutputTokens: modelMetadataMaxOutputTokens(
                    commandResolved.modelMetadata,
                  ),
                  modelOperations:
                    reportModelOperations(commandResolved, {
                      type: "session",
                    }) ?? undefined,
                  transcriptStore: delegation.transcriptStore,
                  attachedSession: {
                    lifecyclePersistence: subagentSession.lifecyclePersistence,
                    costBudget: subagentSession.sharedCostBudget,
                    admission: subagentSession.sharedAdmission,
                    providerCoordination: subagentSession.providerCoordination,
                    background: subagentSession.background,
                    modelOperations:
                      reportModelOperations(commandResolved, {
                        type: "session",
                      }) ?? undefined,
                  },
                  now,
                  onProgress: (event) => {
                    options.writeStderr(formatSubagentProgress(event));
                  },
                  resolveProvider: (selection) =>
                    resolveSubagentExecution(
                      interactiveCommand.message,
                      selection,
                    ),
                });
                const detach = subagentSession.continuation.attach(
                  commandRuntime.supervisor.continuation,
                );
                try {
                  result = await subagentSession.control.resume({
                    id: entry.childAgentId,
                    requestId: `agents-resume-${randomUUID()}`,
                    message: interactiveCommand.message,
                    skills: interactiveCommand.skills,
                    mcp: interactiveCommand.mcp,
                    signal: commandAbortController.signal,
                    maxResultChars: MAX_SUBAGENT_RESULT_CHARS,
                  });
                } finally {
                  detach();
                }
              }
              (result.ok ? options.writeStdout : options.writeStderr)(
                `${result.content.trimEnd()}\n`,
              );
            } finally {
              activeAbortController = null;
              setComposerMode("ready");
            }
          }
        } catch (error) {
          options.writeStderr(formatInteractiveCommandFailure(error));
        }
        consumeQueuedInputLines([rawInput]);
        continue;
      }
      if (interactiveCommand?.kind === "sessions") {
        if (savedSession === null || options.sessionPicker === undefined) {
          options.writeStderr(
            "Error: /sessions requires a saved interactive session.\n",
          );
          consumeQueuedInputLines([rawInput]);
          continue;
        }
        const pickerView = options.sessionPicker();
        options.writeStdout(pickerView.prompt);
        const pickerResult = await readNumberedPickerSelection({
          minChoice: 1,
          maxChoice: pickerView.sessions.length,
          prompt: pickerView.prompt,
          invalidSelectionMessage: `Enter a session number from 1 to ${pickerView.sessions.length}, or q to cancel.`,
          lineReader,
          writeStdout: options.writeStdout,
          writeStderr: options.writeStderr,
        });
        const consumedLines = [rawInput, ...pickerResult.consumedLines];
        if (pickerResult.kind === "cancelled") {
          if (pickerResult.explicit) {
            options.writeStdout("Session switch cancelled.\n");
          }
          consumeQueuedInputLines(consumedLines);
          continue;
        }
        const selectedSession =
          pickerView.sessions[pickerResult.selection.choice - 1];
        /* v8 ignore next 3: the picker validates the choice against this view. */
        if (selectedSession === undefined) {
          throw new Error("Error: selected session is not available.");
        }
        if (selectedSession.id === savedSession.id) {
          options.writeStdout(`Session already active: ${savedSession.id}\n`);
          consumeQueuedInputLines(consumedLines);
          continue;
        }
        const selectionLine = pickerResult.consumedLines.at(-1);
        /* v8 ignore next 3: a selected picker result always includes the line that supplied its validated choice. */
        if (selectionLine === undefined) {
          throw new Error("Error: selected session input is not available.");
        }
        const selectionSequence = selectionLine.sequence;
        const carriedLines = lineReader.drainLinesAfter(selectionSequence);
        consumeQueuedInputLines(consumedLines);
        preserveInputForSessionSwitch = true;
        return {
          invocationState: {
            accounting: invocationAccounting(),
            undoProtection,
            explicitSkillActivations,
          },
          switchSession: {
            targetSessionId: selectedSession.id,
            lineInput: input,
            initialInputLines: carriedLines.map((line) => line.line),
            sourceInputIds: queuedInputIds(carriedLines),
          },
        };
      }
      if (interactiveCommand?.kind === "title") {
        if (interactiveCommand.title === undefined) {
          options.writeStdout(formatInteractiveTitle(sessionTitle));
          consumeQueuedInputLines([rawInput]);
          continue;
        }
        if (savedSession === null) {
          options.writeStderr(formatTitleRequiresSavedSession());
          consumeQueuedInputLines([rawInput]);
          continue;
        }
        try {
          sessionTitle = savedSession.persistTitle({
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
        const result = executeInteractiveGoalCommand({
          command: interactiveCommand,
          goal: sessionGoal,
          ...(savedSession !== null
            ? {
                persistGoal: (goal: SessionGoal | null) =>
                  persistSessionGoalUpdate({
                    goal,
                    consumedInputIds: queuedInputIds([rawInput]),
                  }),
              }
            : {}),
        });
        for (const output of result.output) {
          const rendered = formatInteractiveGoalCommandOutput(output, {
            bashToolVisible: bashRuntimeExposesTool(bash),
          });
          if (rendered.stream === "stdout") {
            options.writeStdout(rendered.text);
          } else {
            options.writeStderr(rendered.text);
          }
        }
        if (result.consumeInput) {
          consumeQueuedInputLines([rawInput]);
        }
        switch (result.drive) {
          case "retain":
            break;
          case "clear":
            pendingGoalDrive = null;
            break;
          case "activation":
            pendingGoalDrive = {
              message: GOAL_ACTIVATION_MESSAGE,
              origin: RUNTIME_GOAL_ACTIVATION_ORIGIN,
              taskTrigger: "goal_activation",
              runTrigger: "goal_activation",
            };
            break;
          case "resumption":
            pendingGoalDrive = {
              message: GOAL_RESUMPTION_MESSAGE,
              origin: RUNTIME_GOAL_RESUMPTION_ORIGIN,
              taskTrigger: "goal_resume",
              runTrigger: "goal_resume",
            };
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
        let inspection: InteractiveDiffInspection;
        try {
          inspection = await inspectInteractiveDiff(
            options.workspace,
            hiddenWorkspacePaths,
          );
        } catch (error) {
          inspection = failedInteractiveDiff(error);
        }
        if (options.renderDiffReview !== undefined) {
          options.renderDiffReview(inspection);
        } else if (inspection.kind === "failed") {
          options.writeStderr(formatInteractiveDiffOutput(inspection));
        } else {
          options.writeStdout(formatInteractiveDiffOutput(inspection));
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
            if (savedSession !== null) {
              savedSession.persistBashApprovalsCleared({
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
            if (savedSession !== null) {
              savedSession.persistBashApprovalRevoked({
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
            ledger.append({
              role: "user",
              content: undoRestoredContextMessage(result.restoredLabel),
              origin: RUNTIME_UNDO_RESTORATION_ORIGIN,
            });
            if (savedSession !== null) {
              savedSession.persistMessages({
                messages: sessionLedgerMessages(ledger),
                reason: "turn",
                consumedInputIds: queuedInputIds([rawInput]),
                skillState: null,
                reservedMessageIds: [],
              });
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
            (initialState.modelSelection !== undefined
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
          if (sessionLedgerMessages(ledger).length > 0) {
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
          const modelSwitchCompaction = {
            systemPrompt: currentSystemPrompt(),
            messages: sessionLedgerMessages(ledger),
            target: nextResolved,
            bashToolVisible: bashRuntimeExposesTool(bash),
          };
          if (modelSwitchRequiresCompaction(modelSwitchCompaction)) {
            const currentResolved: InteractiveResolvedProvider =
              previousResolved ?? resolveActiveProvider(userMessage);
            previousResolved = currentResolved;
            resolved = currentResolved;
            const compactAbortController = new AbortController();
            const compactionMessages = [...sessionLedgerMessages(ledger)];
            activeAbortController = compactAbortController;
            setComposerMode("queue");
            try {
              const modelOperations = reportModelOperations(currentResolved, {
                type: "session",
              });
              const compaction = await executeModelSwitchCompaction({
                current: currentResolved,
                target: modelSwitchCompaction.target,
                workspace: options.workspace,
                messages: compactionMessages,
                systemPrompt: currentSystemPrompt(),
                summarySystemPrompt: currentSystemPrompt(),
                signal: compactAbortController.signal,
                readVisibility,
                projectInstructionVisibility,
                nextPostCompactionReadToolCallId: () =>
                  postCompactionReadToolCallId(postCompactionReadSequence++),
                taskProgress,
                options,
                bashToolVisible: bashRuntimeExposesTool(bash),
                recordCompactionCost,
                compactionCost: currentCompactionCost(currentResolved),
                modelOperations,
              });
              if (compaction.status === "rejected") {
                if (compaction.cost?.budget.kind === "budget_limited") {
                  sessionStopReason = "cost_budget";
                  break;
                }
                consumeQueuedInputLines([rawInput]);
                continue;
              }
              replaceSessionLedgerMessages(ledger, compactionMessages);
              modelSwitchCost = compaction.cost;
            } finally {
              activeAbortController = null;
              setComposerMode("ready");
            }
            savedSession?.persistMessages({
              messages: sessionLedgerMessages(ledger),
              reason: "compaction",
              consumedInputIds: queuedInputIds([rawInput]),
              skillState: null,
              reservedMessageIds: [],
            });
            consumedByPersistence = savedSession !== null;
          }
          resolved = nextResolved;
          if (savedSession !== null) {
            savedSession.persistModelSwitch({
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
          if (modelSwitchCost?.budget.kind === "budget_limited") {
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
          const statuses = managedSkills?.activation.activeStatuses() ?? [];
          options.writeStdout(formatActiveWorkflowSkills(statuses));
          consumeQueuedInputLines([rawInput]);
          continue;
        }
        let skillTaskShouldRun = false;
        let commandRollback: InteractiveSkillCheckpoint | null = null;
        try {
          if (skillRuntime.kind !== "managed") {
            throw new WorkflowSkillError(
              skillRuntime.kind === "unavailable"
                ? skillRuntime.reason
                : "explicit skill activation is unavailable",
            );
          }
          commandRollback = {
            runtime: skillRuntime,
            state: skillRuntime.activation.state(),
          };
          let successMessage: string;
          let activationRecord: SkillActivationRecord | undefined;
          if (interactiveCommand.action === "deactivate") {
            const deactivated = skillRuntime.activation.deactivate(
              interactiveCommand.lookup,
            );
            successMessage = `Deactivated workflow skill ${deactivated.qualifiedName}.\n`;
          } else if (interactiveCommand.action === "reload") {
            const reloaded = skillRuntime.activation.reload(
              interactiveCommand.lookup,
            );
            activationRecord = reloaded.record;
            successMessage = `Reloaded workflow skill ${reloaded.activation.qualifiedName}.\n`;
          } else {
            const skill = skillRuntime.loadExplicit(interactiveCommand.lookup);
            const activated = skillRuntime.activation.activateExplicit(
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
              commandRollback.state,
              skillRuntime.activation.state(),
            )
          ) {
            savedSession?.persistSkillState(skillRuntime.activation.state());
          }
          if (activationRecord !== undefined) {
            explicitSkillActivations.push(activationRecord);
          }
          systemPrompt = rebuildSystemPrompt();
          options.writeStdout(successMessage);
        } catch (error) {
          if (commandRollback !== null) {
            commandRollback.runtime.activation.restore(commandRollback.state);
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
        if (savedSession === null) {
          options.writeStderr(formatForkRequiresNamedSession("/fork-points"));
          consumeQueuedInputLines([rawInput]);
          continue;
        }
        options.writeStdout(
          formatInteractiveSessionForkPoints(savedSession.listForkPoints()),
        );
        consumeQueuedInputLines([rawInput]);
        continue;
      }
      if (interactiveCommand?.kind === "compact") {
        if (sessionLedgerMessages(ledger).length === 0) {
          options.writeStderr(
            "Context compaction skipped: no conversation history to compact.\n",
          );
          consumeQueuedInputLines([rawInput]);
          continue;
        }
        const compactResolved = resolveActiveProvider(userMessage);
        const compactAbortController = new AbortController();
        const compactionMessages = [...sessionLedgerMessages(ledger)];
        activeAbortController = compactAbortController;
        setComposerMode("queue");
        let compactCost: CostReport | undefined;
        let compactCommitted = false;
        try {
          const modelOperations = reportModelOperations(compactResolved, {
            type: "session",
          });
          const compaction = await executeManualCompaction({
            command: interactiveCommand,
            resolved: compactResolved,
            workspace: options.workspace,
            messages: compactionMessages,
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
            compactionCost: currentCompactionCost(compactResolved),
            modelOperations,
          });
          compactCost = compaction.cost;
          compactCommitted = compaction.status === "committed";
          if (compactCommitted) {
            replaceSessionLedgerMessages(ledger, compactionMessages);
          }
        } finally {
          activeAbortController = null;
          setComposerMode("ready");
        }
        if (compactAbortController.signal.aborted || !compactCommitted) {
          consumeQueuedInputLines([rawInput]);
        } else {
          savedSession?.persistMessages({
            messages: sessionLedgerMessages(ledger),
            reason: "compaction",
            consumedInputIds: queuedInputIds([rawInput]),
            skillState: null,
            reservedMessageIds: [],
          });
        }
        if (compactCost?.budget.kind === "budget_limited") {
          sessionStopReason = "cost_budget";
          break;
        }
        continue;
      }
      if (interactiveCommand?.kind === "fork") {
        if (savedSession === null) {
          options.writeStderr(formatForkRequiresNamedSession("/fork"));
          consumeQueuedInputLines([rawInput]);
          continue;
        }
        if (interactiveCommand.pick === true) {
          const forkPoints = savedSession.listForkPoints();
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
              savedSession.fork({
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
          options.writeStdout(savedSession.fork(interactiveCommand));
        } catch (error) {
          options.writeStderr(formatInteractiveCommandFailure(error));
        }
        consumeQueuedInputLines([rawInput]);
        continue;
      }
      /* v8 ignore start -- the three-process SIGKILL test verifies blocked input remains queued without a third provider request. */
      if (recoveryBlockedTaskId !== null) {
        if (rawInput.inputId === undefined) {
          savedSession?.persistQueuedInput({
            sequence: rawInput.sequence,
            line: rawInput.line,
          });
        }
        options.writeStderr(
          `Error: recovery_blocked for durable Task ${recoveryBlockedTaskId}; input remains queued.\n`,
        );
        continue;
      }
      /* v8 ignore stop */
      pendingGoalDrive = null;
      const taskStartedWithActiveGoal = sessionGoal?.status === "active";
      reportRecorder.beginTask("user_prompt");
      try {
        const turnResult = await runPromptTurn({
          userMessage,
          userMessageOrigin: userMessageOriginForPromptInput([rawInput]),
          consumedInputLines: [rawInput],
          runTrigger: "user_prompt",
        });
        if (turnResult.kind === "aborted") {
          reportRecorder.endTask("aborted");
          continue;
        }
        if (turnResult.kind === "cost_budget") {
          reportRecorder.endTask(taskOutcomeForGoal(taskStartedWithActiveGoal));
          break;
        }
        const shouldStop = await runAutomaticGoalContinuations();
        reportRecorder.endTask(taskOutcomeForGoal(taskStartedWithActiveGoal));
        if (shouldStop) {
          break;
        }
      } catch (error) {
        failCurrentReportTask();
        throw error;
      }
    }
  } finally {
    options.offSigint(abortActiveTurn);
    try {
      await subagentSession?.shutdown();
    } finally {
      await mcpRuntime?.close().catch(() => undefined);
      lineReader.dispose();
      if (!preserveInputForSessionSwitch) {
        input.close();
      }
    }
  }
  const finalGoal =
    sessionGoal === undefined ? {} : { goal: copySessionGoal(sessionGoal) };
  const invocationState = {
    accounting: invocationAccounting(),
    undoProtection,
    explicitSkillActivations,
  };
  if (options.cliArgs.reportFile !== undefined) {
    const reportEnd = currentReportEnd();
    if (reportEnd === undefined) {
      return { ...finalGoal, invocationState };
    }
    const operationAccounting = accountModelOperations(
      reportRecorder.modelOperations(),
    );
    return {
      ...finalGoal,
      invocationState,
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
  return { ...finalGoal, invocationState };
}
