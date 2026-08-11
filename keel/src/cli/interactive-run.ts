import { Readable } from "node:stream";
import type { SessionMessage } from "../agent/session-message.ts";
import { errorMessage, isAbortThrow } from "../core/error.ts";
import {
  pauseActiveSessionGoal,
  type ResumableSessionGoal,
  type SessionGoal,
  type SessionGoalResumeAssessment,
} from "../core/session-goal.ts";
import type {
  BashApprovalGrant,
  SessionBashPermissionPolicy,
} from "../permissions/bash.ts";
import {
  activeSkillActivations,
  createSkillActivation,
  skillLifecycleStatesEqual,
} from "../skills/lifecycle.ts";
import type {
  SkillActivationRecord,
  SkillLifecycleState,
} from "../skills/model.ts";
import { repositoryWorkflowSkillRootPaths } from "../skills/project.ts";
import { createAgentProjectMemory } from "./agent-project-memory.ts";
import {
  type AgentTreeHistory,
  createAgentTreeHistory,
} from "./agent-tree-store.ts";
import type { CliArgs } from "./args.ts";
import { USAGE } from "./args.ts";
import {
  BashProjectApprovalsError,
  bashApprovalProjectRoot,
  listBashProjectApprovalGrants,
  saveBashProjectApprovalGrant,
} from "./bash-project-approvals.ts";
import { sessionForkPointsFromStoredMessages } from "./fork-points.ts";
import {
  type HeadlessGoalOutcome,
  headlessGoalRunReportOutcome,
  headlessGoalRunReportStopReason,
  requireHeadlessGoalOutcome,
} from "./headless-goal-outcome.ts";
import {
  createStableInteractiveDisplay,
  type StableInteractiveDisplay,
} from "./interactive-session/display.ts";
import type { InteractiveLineInput } from "./interactive-session/line-reader.ts";
import {
  type InteractiveActiveSession,
  type InteractiveActiveSessionState,
  type InteractiveForkSessionRequest,
  type InteractiveInvocationState,
  type InteractiveSessionOptions,
  type InteractiveSkillRuntime,
  runInteractiveSession,
  type SavedInteractiveSession,
} from "./interactive-session.ts";
import { listMcpServersSync, McpConfigError } from "./mcp-config.ts";
import {
  createCliMcpConnectionFactory,
  createCliMcpLifecyclePolicy,
} from "./mcp-connection.ts";
import {
  formatCostReport,
  printAgentEvents,
  printInteractiveTerminalAgentEvents,
  printStableInteractiveAgentEvents,
} from "./output.ts";
import {
  loadProjectInstructions,
  ProjectInstructionsError,
} from "./project-instructions.ts";
import {
  loadRenderedProjectMemory,
  ProjectMemoryError,
  type RenderedProjectMemory,
} from "./project-memory.ts";
import {
  ProviderConfigError,
  requireKnownCostModel,
  resolveInteractiveProvider,
} from "./provider-config.ts";
import {
  projectMemoryReportEntry,
  type RunReportMemory,
  type RunReportMemoryEntry,
  reportActiveSkills,
  writeRunReport,
  writeRunReportBestEffort,
} from "./report.ts";
import {
  type AgentEventReportRecorder,
  createAgentEventReportRecorder,
} from "./report-events.ts";
import type { CliRuntime } from "./runtime.ts";
import {
  createCliRuntimeErrorReporter,
  formatCliRuntimeError,
} from "./runtime-error.ts";
import {
  buildSessionPickerView,
  formatSessionCatalogWarnings,
  formatSessionForkCreated,
  formatSessionStartupPrompt,
} from "./session-catalog-format.ts";
import { createAutomaticSessionId } from "./session-id.ts";
import {
  readSessionPickerSelection,
  readSessionStartupSelection,
} from "./session-picker.ts";
import {
  acquireSessionLock,
  consumeSessionQueuedInputs,
  createSessionMessageId,
  createSessionStore,
  ensureSessionCanBeCreated,
  forkSessionStore,
  listSessionCatalog,
  persistSessionBashApprovalGrant,
  persistSessionBashApprovalRevoked,
  persistSessionBashApprovalsCleared,
  persistSessionGoal,
  persistSessionMessages,
  persistSessionModelSwitch,
  persistSessionQueuedInput,
  persistSessionSkillState,
  persistSessionTaskProgress,
  persistSessionTitle,
  resumeSessionStore,
  type SessionCatalog,
  type SessionCatalogEntry,
  type SessionLock,
  type SessionModelSelection,
  type SessionState,
  SessionStoreError,
  sessionStoredMessages,
} from "./session-store.ts";
import {
  resolveSkillRuntimePolicy,
  SkillUserConfigError,
  skillPolicyReport,
} from "./skill-user-config.ts";
import {
  cleanupExpiredToolOutputArtifacts,
  createToolOutputArtifactStore,
  newToolOutputArtifactScope,
  toolOutputArtifactScopeForSession,
} from "./tool-output-artifacts.ts";
import {
  createInteractiveTerminalDisplay,
  type InteractiveTerminalDisplay,
} from "./tui/interactive-terminal.ts";
import {
  disabledWorkflowSkillWorkspacePaths,
  discoverWorkflowSkillCatalog,
  filterWorkflowSkillCatalog,
  formatWorkflowSkillListWarnings,
  loadWorkflowSkills,
  WorkflowSkillError,
} from "./workflow-skills.ts";

type InteractiveRunCliArgs = Extract<
  CliArgs,
  { readonly command: "run"; readonly mode: "interactive" }
>;

function skillLifecycleStateForUserPolicy(
  state: SkillLifecycleState,
  disabledPackageIds: readonly string[],
): SkillLifecycleState {
  if (disabledPackageIds.length === 0) return state;
  const disabled = new Set(disabledPackageIds);
  const activeIds = activeSkillActivations(state)
    .filter((activation) => !disabled.has(activation.packageId))
    .map((activation) => activation.descriptorId);
  return {
    skillActivations: state.skillActivations,
    activeSkillIds: activeIds,
  };
}

function restorePolicyHiddenActiveSkillIds(
  state: SkillLifecycleState,
  persistedState: SkillLifecycleState,
  disabledPackageIds: readonly string[],
): SkillLifecycleState {
  if (disabledPackageIds.length === 0) return state;
  const disabled = new Set(disabledPackageIds);
  const currentActiveIds = new Set(state.activeSkillIds);
  const persistedActiveIds = activeSkillActivations(persistedState)
    .filter(
      (activation) =>
        disabled.has(activation.packageId) ||
        currentActiveIds.has(activation.descriptorId),
    )
    .map((activation) => activation.descriptorId);
  return {
    skillActivations: state.skillActivations,
    activeSkillIds: [
      ...new Set([...persistedActiveIds, ...state.activeSkillIds]),
    ],
  };
}

async function runInteractiveSessionWithTerminalDisplay(
  options: InteractiveSessionOptions,
  terminalDisplay: InteractiveTerminalDisplay | undefined,
) {
  try {
    const result = await runInteractiveSession(options);
    if (result.switchSession === undefined) {
      terminalDisplay?.stop();
    }
    return result;
  } catch (error) {
    terminalDisplay?.stop();
    throw error;
  }
}
type DirectInteractiveSessionCliIntent = Exclude<
  InteractiveRunCliArgs["session"],
  { readonly kind: "resume-pick" }
>;
type HeadlessSessionCliIntent = Extract<
  InteractiveRunCliArgs["session"],
  { readonly kind: "create" | "resume" | "resume-latest" }
>;
type DisabledAgentInteractiveRunCliArgs = Extract<
  InteractiveRunCliArgs,
  { readonly agentPolicy: "off" }
>;
export type HeadlessSessionCliArgs = Omit<
  DisabledAgentInteractiveRunCliArgs,
  "session"
> & { readonly session: HeadlessSessionCliIntent };

const RESUME_PICK_REQUIRES_TTY_ERROR =
  "Error: --resume --pick requires a real TTY so the session choice cannot be read from piped input. Use keel --resume for the latest session or keel --resume <id> for automation.";

type SessionCliMode =
  | { readonly kind: "interactive" }
  | {
      readonly kind: "headless-goal";
      readonly initialCommand: string;
      readonly bashPermission?: SessionBashPermissionPolicy;
      readonly prepareResumedGoal?: (goal: SessionGoal | undefined) => Promise<
        | {
            readonly kind: "ready";
            readonly goal: ResumableSessionGoal;
            readonly bashPermission?: SessionBashPermissionPolicy;
          }
        | { readonly kind: "rejected" }
      >;
      readonly latestGoalResumeAssessment?: (
        goal: SessionGoal | undefined,
      ) => SessionGoalResumeAssessment;
      readonly onActivated: (sessionId: string) => void;
    };

type InteractiveSessionCliMode = Extract<
  SessionCliMode,
  { readonly kind: "interactive" }
>;
type HeadlessGoalSessionCliMode = Extract<
  SessionCliMode,
  { readonly kind: "headless-goal" }
>;

type InteractiveSessionStart =
  | {
      readonly kind: "ephemeral";
    }
  | {
      readonly kind: "create";
      readonly sessionId: string;
    }
  | {
      readonly kind: "resume";
      readonly sessionId: string;
    }
  | {
      readonly kind: "fork";
      readonly sourceSessionId: string;
      readonly targetSessionId: string;
      readonly beforeMessageId: string | null;
    };

type PromptedInteractiveSessionStart =
  | {
      readonly kind: "start";
      readonly sessionStart: InteractiveSessionStart;
      readonly initialInputLines: readonly string[];
    }
  | {
      readonly kind: "cancelled";
    };

interface BareKeelPromptCatalog {
  readonly catalog: SessionCatalog;
  readonly latestSession: SessionCatalogEntry;
}

function interactiveSessionStartFromIntent(
  intent: DirectInteractiveSessionCliIntent,
  options: {
    readonly workspace: string;
    readonly runtime: CliRuntime;
    readonly latestSessionAssessment?: (
      session: SessionCatalogEntry,
    ) => SessionGoalResumeAssessment;
  },
): InteractiveSessionStart {
  switch (intent.kind) {
    case "automatic":
      return { kind: "create", sessionId: createAutomaticSessionId() };
    case "ephemeral":
      return { kind: "ephemeral" };
    case "create":
      return { kind: "create", sessionId: intent.sessionId };
    case "resume":
      return { kind: "resume", sessionId: intent.sessionId };
    case "resume-latest": {
      const sessionId = latestSessionIdForWorkspace(options);
      options.runtime.writeStderr(`Resuming latest session: ${sessionId}\n`);
      return { kind: "resume", sessionId };
    }
    case "fork":
      return {
        kind: "fork",
        sourceSessionId: intent.sourceSessionId,
        targetSessionId: intent.targetSessionId,
        beforeMessageId: intent.beforeMessageId,
      };
  }
}

function latestSessionIdForWorkspace(options: {
  readonly workspace: string;
  readonly runtime: CliRuntime;
  readonly latestSessionAssessment?: (
    session: SessionCatalogEntry,
  ) => SessionGoalResumeAssessment;
}): string {
  const catalog = listSessionCatalog(options);
  options.runtime.writeStderr(formatSessionCatalogWarnings(catalog.warnings));
  const latestSessionAssessment = options.latestSessionAssessment;
  const assessedSessions =
    latestSessionAssessment === undefined
      ? undefined
      : catalog.sessions.map((session) => ({
          session,
          assessment: latestSessionAssessment(session),
        }));
  const latestSession =
    assessedSessions === undefined
      ? catalog.sessions[0]
      : assessedSessions.find(({ assessment }) => assessment.kind === "ready")
          ?.session;
  if (latestSession === undefined) {
    const budgetRejection = assessedSessions?.find(
      ({ assessment }) => assessment.kind === "budget_rejected",
    )?.assessment.rejection;
    throw new SessionStoreError(
      options.latestSessionAssessment === undefined
        ? `Error: no saved sessions for workspace ${catalog.workspace}. Create a saved session before resuming.`
        : (budgetRejection ??
            `Error: no resumable saved Goals for workspace ${catalog.workspace}.`),
    );
  }
  return latestSession.id;
}

function shouldPromptForSavedSessionOnBareKeel(
  cliArgs: InteractiveRunCliArgs,
  runtime: CliRuntime,
): boolean {
  return (
    runtime.args.length === 0 &&
    runtime.input.isTTY === true &&
    cliArgs.session.kind === "automatic"
  );
}

function bareKeelPromptCatalog(options: {
  readonly workspace: string;
  readonly runtime: CliRuntime;
}): BareKeelPromptCatalog | null {
  const catalog = listSessionCatalog(options);
  const latestSession = catalog.sessions[0];
  if (latestSession === undefined) {
    return null;
  }
  return { catalog, latestSession };
}

async function promptedSessionStartForBareKeel(options: {
  readonly promptCatalog: BareKeelPromptCatalog;
  readonly runtime: CliRuntime;
}): Promise<PromptedInteractiveSessionStart> {
  const { runtime } = options;
  const { catalog, latestSession } = options.promptCatalog;
  runtime.writeStderr(formatSessionCatalogWarnings(catalog.warnings));
  const startupPrompt = formatSessionStartupPrompt({
    workspace: catalog.workspace,
    latestSession,
  });
  const pickerView = buildSessionPickerView(catalog);
  runtime.writeStdout(startupPrompt);
  const startupSelection = await readSessionStartupSelection({
    input: runtime.input,
    maxChoice: pickerView.sessions.length,
    startupPrompt,
    pickerPrompt: pickerView.prompt,
    writeStdout: runtime.writeStdout,
    writeStderr: runtime.writeStderr,
  });
  switch (startupSelection.kind) {
    case "resume-latest":
      runtime.writeStderr(`Resuming latest session: ${latestSession.id}\n`);
      return {
        kind: "start",
        sessionStart: { kind: "resume", sessionId: latestSession.id },
        initialInputLines: startupSelection.initialInputLines,
      };
    case "pick": {
      const selectedSession =
        pickerView.sessions[startupSelection.selection.choice - 1];
      /* v8 ignore next 3: the picker validates the choice range against this catalog length. */
      if (selectedSession === undefined) {
        throw new SessionStoreError(
          "Error: selected session is not available.",
        );
      }
      runtime.writeStderr(`Resuming selected session: ${selectedSession.id}\n`);
      return {
        kind: "start",
        sessionStart: { kind: "resume", sessionId: selectedSession.id },
        initialInputLines: startupSelection.initialInputLines,
      };
    }
    case "new":
      runtime.writeStdout("Starting a new saved session.\n");
      return {
        kind: "start",
        sessionStart: {
          kind: "create",
          sessionId: createAutomaticSessionId(),
        },
        initialInputLines: startupSelection.initialInputLines,
      };
    case "cancelled":
      if (startupSelection.explicit) {
        runtime.writeStdout(
          startupSelection.source === "picker"
            ? "Resume cancelled.\n"
            : "Startup cancelled.\n",
        );
      }
      return { kind: "cancelled" };
  }
}

async function pickedSessionIdForWorkspace(options: {
  readonly workspace: string;
  readonly runtime: CliRuntime;
}): Promise<{
  readonly sessionId: string;
  readonly initialInputLines: readonly string[];
} | null> {
  const { runtime } = options;
  const catalog = listSessionCatalog(options);
  runtime.writeStderr(formatSessionCatalogWarnings(catalog.warnings));
  if (catalog.sessions.length === 0) {
    throw new SessionStoreError(
      `Error: no saved sessions for workspace ${catalog.workspace}. Complete an interactive turn before running keel --resume --pick.`,
    );
  }
  const pickerView = buildSessionPickerView(catalog);
  runtime.writeStdout(pickerView.prompt);
  const pickerResult = await readSessionPickerSelection({
    input: runtime.input,
    maxChoice: pickerView.sessions.length,
    writeStdout: runtime.writeStdout,
    writeStderr: runtime.writeStderr,
  });
  if (pickerResult.kind === "cancelled") {
    if (pickerResult.explicit) {
      runtime.writeStdout("Resume cancelled.\n");
    }
    return null;
  }
  const selectedSession =
    pickerView.sessions[pickerResult.selection.choice - 1];
  /* v8 ignore next 3: the picker validates the choice range against this catalog length. */
  if (selectedSession === undefined) {
    throw new SessionStoreError("Error: selected session is not available.");
  }
  return {
    sessionId: selectedSession.id,
    initialInputLines: pickerResult.initialInputLines,
  };
}

function activeSessionIdForStart(
  sessionStart: InteractiveSessionStart,
): string | null {
  switch (sessionStart.kind) {
    case "ephemeral":
      return null;
    case "create":
    case "resume":
      return sessionStart.sessionId;
    case "fork":
      return sessionStart.targetSessionId;
  }
}

export type HeadlessSessionCliResult =
  | {
      readonly kind: "failed";
      readonly exitCode: number;
    }
  | {
      readonly kind: "finished";
      readonly outcome: HeadlessGoalOutcome;
    };

interface InteractiveInvocationScope {
  readonly lineInput: InteractiveLineInput;
  readonly interrupt: InteractiveInvocationInterrupt;
  readonly terminalDisplay: InteractiveTerminalDisplay | undefined;
  readonly stableDisplay: StableInteractiveDisplay | undefined;
  readonly reportRecorder: AgentEventReportRecorder;
  readonly startedAt: number;
  readonly state: InteractiveInvocationState;
  readonly agentMemory: ReturnType<typeof createAgentProjectMemory>;
  readonly memoryReportState: InteractiveMemoryReportState;
}

interface InteractiveInvocationInterrupt {
  handler: (() => void) | null;
}

interface ActiveSessionTransition {
  readonly preacquiredSessionLock: SessionLock;
  readonly initialInputLines: readonly string[];
  readonly sourceHandoff?: {
    readonly lock: SessionLock;
    readonly consumeSourceInputs: () => void;
    readonly targetSessionId: string;
  };
}

type InteractiveActiveSessionResult =
  | { readonly kind: "finished"; readonly exitCode: number }
  | {
      readonly kind: "switch";
      readonly cliArgs: InteractiveRunCliArgs;
      readonly invocation: InteractiveInvocationScope;
      readonly transition: ActiveSessionTransition;
    };

interface InteractiveMemoryReportState {
  loadedMemory: RenderedProjectMemory | undefined;
  memoryLoadError: string | undefined;
  readonly exposedEntries: Map<string, RunReportMemoryEntry>;
  exposedBytes: number;
  exposedTokens: number;
}

function activeSessionCliExit(
  mode: SessionCliMode,
  exitCode: number,
): InteractiveActiveSessionResult | HeadlessSessionCliResult {
  return mode.kind === "interactive"
    ? { kind: "finished", exitCode }
    : { kind: "failed", exitCode };
}

async function runActiveSessionCli(
  cliArgs: InteractiveRunCliArgs,
  runtime: CliRuntime,
  mode: InteractiveSessionCliMode,
  invocation?: InteractiveInvocationScope,
  transition?: ActiveSessionTransition,
): Promise<InteractiveActiveSessionResult>;
async function runActiveSessionCli(
  cliArgs: InteractiveRunCliArgs,
  runtime: CliRuntime,
  mode: HeadlessGoalSessionCliMode,
  invocation?: InteractiveInvocationScope,
  transition?: ActiveSessionTransition,
): Promise<HeadlessSessionCliResult>;
async function runActiveSessionCli(
  cliArgs: InteractiveRunCliArgs,
  runtime: CliRuntime,
  mode: SessionCliMode,
  invocation?: InteractiveInvocationScope,
  transition?: ActiveSessionTransition,
): Promise<InteractiveActiveSessionResult | HeadlessSessionCliResult> {
  let exitCode = 0;

  if (
    mode.kind === "interactive" &&
    cliArgs.session.kind === "resume-pick" &&
    runtime.input.isTTY !== true
  ) {
    runtime.writeStderr(`${RESUME_PICK_REQUIRES_TTY_ERROR}\n`);
    return activeSessionCliExit(mode, 1);
  }
  if (
    mode.kind === "interactive" &&
    runtime.input.isTTY !== true &&
    runtime.env("KEEL_FORCE_INTERACTIVE") !== "1"
  ) {
    runtime.writeStderr(`${USAGE}\n`);
    return activeSessionCliExit(mode, 1);
  }
  if (
    mode.kind === "interactive" &&
    cliArgs.bashMode === "ask" &&
    runtime.input.isTTY !== true
  ) {
    runtime.writeStderr(
      "Error: --bash-policy ask requires a real TTY so approvals cannot be read from piped input. Use --bash-policy deny or --bash-policy trusted for non-TTY runs.\n",
    );
    return activeSessionCliExit(mode, 1);
  }
  let sessionLock: SessionLock | undefined = transition?.preacquiredSessionLock;
  const sourceHandoff = transition?.sourceHandoff;
  let handoffSourceLock = sourceHandoff?.lock;
  let sourceSessionLock: SessionLock | undefined;
  let writeFailureReport: ((error: unknown) => void) | undefined;
  try {
    const workspace = runtime.cwd();
    const skillPolicy = resolveSkillRuntimePolicy(
      runtime,
      cliArgs.skillsEnabled,
    );
    const projectBashApprovals =
      cliArgs.bashMode === "ask" && mode.kind === "interactive"
        ? (() => {
            const projectRoot = bashApprovalProjectRoot(workspace);
            return {
              projectRoot,
              grants: listBashProjectApprovalGrants(runtime, projectRoot),
            };
          })()
        : undefined;
    const latestGoalResumeAssessment =
      mode.kind === "headless-goal"
        ? mode.latestGoalResumeAssessment
        : undefined;
    let sessionStart: InteractiveSessionStart;
    let initialInputLines: readonly string[] =
      transition?.initialInputLines ??
      (mode.kind === "headless-goal" ? [mode.initialCommand] : []);
    if (cliArgs.session.kind === "resume-pick") {
      const pickedSession = await pickedSessionIdForWorkspace({
        workspace,
        runtime,
      });
      if (pickedSession === null) {
        return activeSessionCliExit(mode, 0);
      }
      const sessionId = pickedSession.sessionId;
      initialInputLines = pickedSession.initialInputLines;
      runtime.writeStderr(`Resuming selected session: ${sessionId}\n`);
      sessionStart = { kind: "resume", sessionId };
    } else if (
      mode.kind === "interactive" &&
      shouldPromptForSavedSessionOnBareKeel(cliArgs, runtime)
    ) {
      const promptCatalog = bareKeelPromptCatalog({
        workspace,
        runtime,
      });
      if (promptCatalog === null) {
        sessionStart = interactiveSessionStartFromIntent(
          { kind: "automatic" },
          {
            workspace,
            runtime,
          },
        );
      } else {
        const promptedSessionStart = await promptedSessionStartForBareKeel({
          promptCatalog,
          runtime,
        });
        if (promptedSessionStart.kind === "cancelled") {
          return activeSessionCliExit(mode, 0);
        }
        sessionStart = promptedSessionStart.sessionStart;
        initialInputLines = promptedSessionStart.initialInputLines;
      }
    } else {
      sessionStart = interactiveSessionStartFromIntent(cliArgs.session, {
        workspace,
        runtime,
        ...(latestGoalResumeAssessment !== undefined
          ? {
              latestSessionAssessment: (catalogSession: SessionCatalogEntry) =>
                latestGoalResumeAssessment(catalogSession.goal),
            }
          : {}),
      });
    }
    try {
      if (sessionStart.kind === "fork") {
        sourceSessionLock = acquireSessionLock({
          sessionId: sessionStart.sourceSessionId,
          runtime,
        });
      }
      const sessionIdForLock = activeSessionIdForStart(sessionStart);
      if (sessionIdForLock !== null && sessionLock === undefined) {
        sessionLock = acquireSessionLock({
          sessionId: sessionIdForLock,
          runtime,
        });
      }
      let session: SessionState | undefined;
      let activeSessionId: string | undefined;
      let persistedMessages: readonly SessionMessage[] = [];
      let initialModelSelection: SessionModelSelection | undefined;
      let headlessGoalBashPermission =
        mode.kind === "headless-goal" ? mode.bashPermission : undefined;
      let headlessPreparedSessionGoal: SessionGoal | undefined;
      if (!skillPolicy.enabled && (cliArgs.skillNames?.length ?? 0) > 0) {
        throw new WorkflowSkillError(skillPolicy.unavailableReason);
      }
      const requestedWorkflowSkills =
        !skillPolicy.enabled || cliArgs.skillNames === undefined
          ? []
          : loadWorkflowSkills(
              runtime,
              workspace,
              cliArgs.skillNames,
              skillPolicy.disabledPackageIds,
            );
      if (sessionStart.kind === "create") {
        activeSessionId = sessionStart.sessionId;
        ensureSessionCanBeCreated({
          sessionId: sessionStart.sessionId,
          runtime,
        });
      } else if (
        sessionStart.kind === "resume" ||
        sessionStart.kind === "fork"
      ) {
        const sourceSessionId =
          sessionStart.kind === "resume"
            ? sessionStart.sessionId
            : sessionStart.sourceSessionId;
        const resumedSession = resumeSessionStore({
          sessionId: sourceSessionId,
          workspace,
          runtime,
        });
        if (sessionStart.kind === "fork") {
          ensureSessionCanBeCreated({
            sessionId: sessionStart.targetSessionId,
            runtime,
          });
          session = forkSessionStore({
            source: resumedSession,
            targetSessionId: sessionStart.targetSessionId,
            ...(sessionStart.beforeMessageId !== null
              ? {
                  forkPoint: {
                    beforeMessageId: sessionStart.beforeMessageId,
                    optionName: "--fork-before-message",
                  },
                }
              : {}),
            runtime,
          });
          sourceSessionLock?.release();
          sourceSessionLock = undefined;
        } else {
          session = resumedSession;
          if (
            mode.kind === "headless-goal" &&
            mode.prepareResumedGoal !== undefined
          ) {
            const goalForPreparation =
              session.goal?.status === "active"
                ? pauseActiveSessionGoal(session.goal)
                : session.goal;
            const preparation =
              await mode.prepareResumedGoal(goalForPreparation);
            if (preparation.kind === "rejected") {
              return activeSessionCliExit(mode, 1);
            }
            headlessPreparedSessionGoal = preparation.goal;
            headlessGoalBashPermission = preparation.bashPermission;
          }
        }
        activeSessionId = session.id;
        persistedMessages = session.messages;
        initialModelSelection = session.activeModel;
        if (cliArgs.providerId !== undefined || cliArgs.model !== undefined) {
          const overrideProviderId =
            cliArgs.providerId ?? session.activeModel?.providerId;
          const override = resolveInteractiveProvider("", runtime, {
            ...(overrideProviderId !== undefined
              ? { providerId: overrideProviderId }
              : {}),
            ...(cliArgs.model !== undefined ? { model: cliArgs.model } : {}),
          });
          const overrideSelection = {
            providerId: override.providerId,
            model: override.model,
          };
          const previousSelection = session.activeModel ?? null;
          if (
            previousSelection === null ||
            overrideSelection.providerId !== previousSelection.providerId ||
            overrideSelection.model !== previousSelection.model
          ) {
            persistSessionModelSwitch({
              session,
              from: previousSelection,
              to: overrideSelection,
              runtime,
            });
            const action =
              previousSelection === null ? "selected as" : "overridden to";
            runtime.writeStdout(
              `Model ${action} ${overrideSelection.providerId}/${overrideSelection.model} for resumed session.\n`,
            );
          }
          initialModelSelection = overrideSelection;
        }
      }
      const skillDiscovery = skillPolicy.enabled
        ? (() => {
            const rawCatalog = discoverWorkflowSkillCatalog(runtime, workspace);
            return {
              kind: "available" as const,
              rawCatalog,
              catalog: filterWorkflowSkillCatalog(
                rawCatalog,
                skillPolicy.disabledPackageIds,
              ),
            };
          })()
        : {
            kind: "unavailable" as const,
            reason: skillPolicy.unavailableReason,
          };
      const discoveredSkillCatalog =
        skillDiscovery.kind === "available"
          ? skillDiscovery.catalog
          : undefined;
      const hiddenWorkspacePaths =
        skillDiscovery.kind === "unavailable"
          ? repositoryWorkflowSkillRootPaths(workspace)
          : disabledWorkflowSkillWorkspacePaths(
              workspace,
              skillDiscovery.rawCatalog,
              skillPolicy.disabledPackageIds,
            );
      if (discoveredSkillCatalog !== undefined) {
        runtime.writeStderr(
          formatWorkflowSkillListWarnings(discoveredSkillCatalog.warnings),
        );
      }
      const disabledPackageIds = new Set(skillPolicy.disabledPackageIds);
      const sessionSkillState =
        session === undefined
          ? undefined
          : {
              skillActivations: session.skillActivations,
              activeSkillIds: session.activeSkillIds,
            };
      const policyFilteredSessionSkillState =
        sessionSkillState === undefined
          ? undefined
          : skillLifecycleStateForUserPolicy(
              sessionSkillState,
              skillPolicy.disabledPackageIds,
            );
      const catalogHasDisabledSkill =
        skillDiscovery.kind === "available" &&
        skillDiscovery.rawCatalog.skills.some((skill) =>
          disabledPackageIds.has(skill.packageId),
        );
      const sessionHasDisabledActiveSkill =
        sessionSkillState !== undefined &&
        activeSkillActivations(sessionSkillState).some((activation) =>
          disabledPackageIds.has(activation.packageId),
        );
      const sessionHasEnabledActiveSkill =
        (policyFilteredSessionSkillState?.activeSkillIds.length ?? 0) > 0;
      const allRelevantSkillsDisabledByUser =
        discoveredSkillCatalog?.skills.length === 0 &&
        (catalogHasDisabledSkill || sessionHasDisabledActiveSkill) &&
        !sessionHasEnabledActiveSkill;
      const skillCatalog = allRelevantSkillsDisabledByUser
        ? undefined
        : discoveredSkillCatalog;
      let lazySessionInitialSkillState: SkillLifecycleState = {
        skillActivations: [],
        activeSkillIds: [],
      };
      const savedSessionOwner =
        activeSessionId === undefined
          ? null
          : {
              id: activeSessionId,
              ensure: (): SessionState => {
                let activeSession = session;
                if (activeSession === undefined) {
                  activeSession = createSessionStore({
                    sessionId: activeSessionId,
                    workspace,
                    runtime,
                    skillState: lazySessionInitialSkillState,
                  });
                  session = activeSession;
                  persistedMessages = activeSession.messages;
                }
                return activeSession;
              },
            };
      const persistSkillLifecycleState = (
        activeSession: SessionState,
        state: SkillLifecycleState,
      ): void => {
        persistSessionSkillState({
          session: activeSession,
          state: restorePolicyHiddenActiveSkillIds(
            state,
            activeSession,
            skillPolicy.disabledPackageIds,
          ),
          runtime,
        });
      };
      const initialSkillActivationRecords: SkillActivationRecord[] = [];
      let skills: InteractiveSkillRuntime;
      if (skillDiscovery.kind === "unavailable") {
        skills = {
          kind: "unavailable",
          reason: skillDiscovery.reason,
        };
      } else if (allRelevantSkillsDisabledByUser) {
        skills = {
          kind: "unavailable",
          reason:
            "Error: workflow skills are disabled by user configuration; run keel skills enable <skill> to enable one.",
        };
      } else {
        const activation = createSkillActivation(skillDiscovery.catalog, {
          initialState:
            policyFilteredSessionSkillState === undefined
              ? { skillActivations: [], activeSkillIds: [] }
              : policyFilteredSessionSkillState,
          now: () => new Date(runtime.now()).toISOString(),
        });
        const skillStateBeforeRequested = activation.state();
        for (const skill of requestedWorkflowSkills) {
          const activated = activation.activateExplicit(skill, "");
          if (activated.record !== undefined) {
            initialSkillActivationRecords.push(activated.record);
          }
        }
        if (
          session !== undefined &&
          !skillLifecycleStatesEqual(
            skillStateBeforeRequested,
            activation.state(),
          )
        ) {
          persistSkillLifecycleState(session, activation.state());
        }
        if (session === undefined) {
          lazySessionInitialSkillState = activation.state();
        }
        skills = {
          kind: "managed",
          activation,
          implicitSkills: skillDiscovery.catalog.implicitSkills,
          loadExplicit: (lookup) => skillDiscovery.catalog.load(lookup),
          initialActivationRecords: initialSkillActivationRecords,
        };
      }
      const skillActivation =
        skills.kind === "managed" ? skills.activation : undefined;
      for (const status of skillActivation?.activeStatuses() ?? []) {
        if (status.diskStatus === "current") continue;
        runtime.writeStderr(
          `Warning: workflow skill ${status.activation.qualifiedName} ${status.diskStatus}; continuing with session snapshot sha256:${status.activation.digest}.\n`,
        );
      }
      let savedInteractiveSession: SavedInteractiveSession | null = null;
      let initialActiveSessionState: InteractiveActiveSessionState = {
        messages: [],
        taskProgress: { tasks: [] },
        modelSwitchCount: 0,
        queuedInputs: [],
        bashApprovalGrants: [],
      };
      let headlessGoalActivated = false;
      if (savedSessionOwner !== null) {
        const sessionId = savedSessionOwner.id;
        const activeSessionForPersistence = savedSessionOwner.ensure;
        const forkActiveSession = (
          request: InteractiveForkSessionRequest,
        ): string => {
          const sourceSessionId = activeSessionForPersistence().id;
          let targetSessionLock: SessionLock | undefined;
          try {
            targetSessionLock = acquireSessionLock({
              sessionId: request.targetSessionId,
              runtime,
            });
            ensureSessionCanBeCreated({
              sessionId: request.targetSessionId,
              runtime,
            });
            const source = resumeSessionStore({
              sessionId: sourceSessionId,
              workspace,
              runtime,
            });
            forkSessionStore({
              source,
              targetSessionId: request.targetSessionId,
              ...(request.beforeMessageId !== undefined
                ? {
                    forkPoint: {
                      beforeMessageId: request.beforeMessageId,
                      optionName: "--before-message",
                    },
                  }
                : {}),
              runtime,
            });
            return formatSessionForkCreated({
              sourceSessionId,
              targetSessionId: request.targetSessionId,
              ...(request.beforeMessageId !== undefined
                ? { forkBeforeMessage: request.beforeMessageId }
                : {}),
            });
          } finally {
            targetSessionLock?.release();
          }
        };
        const listActiveForkPoints = () =>
          sessionForkPointsFromStoredMessages({
            sessionId,
            storedMessages: sessionStoredMessages(
              activeSessionForPersistence(),
            ),
          });
        const initialSession = session;
        const initialSessionGoal = (() => {
          if (headlessPreparedSessionGoal !== undefined) {
            return headlessPreparedSessionGoal;
          }
          if (
            sessionStart.kind !== "resume" ||
            initialSession?.goal?.status !== "active"
          ) {
            return initialSession?.goal;
          }
          const pausedGoal = pauseActiveSessionGoal(initialSession.goal);
          persistSessionGoal({
            session: initialSession,
            goal: pausedGoal,
            runtime,
          });
          runtime.writeStdout(
            "Goal paused after session resume. Run /goal resume to continue.\n",
          );
          return pausedGoal;
        })();
        initialActiveSessionState = {
          messages: initialSession?.messages ?? [],
          ...(initialSession?.title !== undefined
            ? { title: initialSession.title }
            : {}),
          ...(initialSessionGoal !== undefined
            ? { goal: initialSessionGoal }
            : {}),
          taskProgress: initialSession?.taskProgress ?? {
            tasks: [],
          },
          ...(initialModelSelection !== undefined
            ? { modelSelection: initialModelSelection }
            : {}),
          modelSwitchCount: initialSession?.modelSwitches.length ?? 0,
          queuedInputs: initialSession?.pendingInputs ?? [],
          bashApprovalGrants: initialSession?.bashApprovalGrants ?? [],
        };
        savedInteractiveSession = {
          kind: "saved",
          id: sessionId,
          resumeAvailable: () => session !== undefined,
          reserveMessageId: createSessionMessageId,
          persistQueuedInput: (input: {
            readonly sequence: number;
            readonly line: string;
          }) =>
            persistSessionQueuedInput({
              session: activeSessionForPersistence(),
              sequence: input.sequence,
              line: input.line,
              runtime,
            }),
          consumeQueuedInputs: (inputIds: readonly string[]) => {
            consumeSessionQueuedInputs({
              session: activeSessionForPersistence(),
              inputIds,
              runtime,
            });
          },
          persistMessages: (request) => {
            const activeSession = activeSessionForPersistence();
            const persistedSkillState =
              request.skillState === null
                ? undefined
                : restorePolicyHiddenActiveSkillIds(
                    request.skillState,
                    activeSession,
                    skillPolicy.disabledPackageIds,
                  );
            persistedMessages = persistSessionMessages({
              session: activeSession,
              previousMessages: persistedMessages,
              currentMessages: request.messages,
              runtime,
              reason: request.reason,
              ...(persistedSkillState !== undefined
                ? { skillState: persistedSkillState }
                : {}),
              consumedInputIds: request.consumedInputIds,
              reservedMessageIds: request.reservedMessageIds,
            });
          },
          persistTitle: (titleRecord: {
            readonly title: string;
            readonly consumedInputIds: readonly string[];
          }) =>
            persistSessionTitle({
              session: activeSessionForPersistence(),
              title: titleRecord.title,
              runtime,
              consumedInputIds: titleRecord.consumedInputIds,
            }),
          persistGoal: (update: {
            readonly goal: SessionGoal | null;
            readonly consumedInputIds: readonly string[];
          }) => {
            const persistedGoal = persistSessionGoal({
              session: activeSessionForPersistence(),
              goal: update.goal,
              runtime,
              consumedInputIds: update.consumedInputIds,
            });
            if (
              mode.kind === "headless-goal" &&
              !headlessGoalActivated &&
              persistedGoal?.status === "active"
            ) {
              headlessGoalActivated = true;
              mode.onActivated(sessionId);
            }
            return persistedGoal;
          },
          persistTaskProgress: (update: {
            readonly taskProgress: SessionState["taskProgress"];
            readonly messageOrdinal: number;
          }) => {
            persistSessionTaskProgress({
              session: activeSessionForPersistence(),
              taskProgress: update.taskProgress,
              messageOrdinal: update.messageOrdinal,
              runtime,
            });
          },
          persistModelSwitch: (switchRecord: {
            readonly from: SessionModelSelection | null;
            readonly to: SessionModelSelection;
            readonly consumedInputIds: readonly string[];
          }) => {
            persistSessionModelSwitch({
              session: activeSessionForPersistence(),
              from: switchRecord.from,
              to: switchRecord.to,
              runtime,
              consumedInputIds: switchRecord.consumedInputIds,
            });
          },
          persistSkillState: (state) => {
            persistSkillLifecycleState(activeSessionForPersistence(), state);
          },
          fork: forkActiveSession,
          listForkPoints: listActiveForkPoints,
          persistBashApprovalGrant: (grant: BashApprovalGrant) => {
            persistSessionBashApprovalGrant({
              session: activeSessionForPersistence(),
              grant,
              runtime,
            });
          },
          persistBashApprovalRevoked: (revocation: {
            readonly grant: BashApprovalGrant;
            readonly consumedInputIds: readonly string[];
          }) => {
            persistSessionBashApprovalRevoked({
              session: activeSessionForPersistence(),
              grant: revocation.grant,
              runtime,
              consumedInputIds: revocation.consumedInputIds,
            });
          },
          persistBashApprovalsCleared: (clear: {
            readonly consumedInputIds: readonly string[];
          }) => {
            persistSessionBashApprovalsCleared({
              session: activeSessionForPersistence(),
              runtime,
              consumedInputIds: clear.consumedInputIds,
            });
          },
        };
      }
      const projectInstructions = loadProjectInstructions(workspace);
      const mcpServers = listMcpServersSync(runtime);
      const [firstMcpServer, ...remainingMcpServers] = mcpServers;
      const startedAt = invocation?.startedAt ?? runtime.now();
      void cleanupExpiredToolOutputArtifacts({ runtime });
      const toolOutputArtifactScope =
        activeSessionId === undefined
          ? newToolOutputArtifactScope("interactive")
          : toolOutputArtifactScopeForSession(activeSessionId);
      const toolOutputArtifacts = {
        store: createToolOutputArtifactStore({
          runtime,
          scope: toolOutputArtifactScope,
        }),
      };
      const agentHistory: AgentTreeHistory | undefined =
        savedSessionOwner === null
          ? undefined
          : (() => {
              const owner = savedSessionOwner;
              let opened =
                session === undefined
                  ? undefined
                  : createAgentTreeHistory({
                      sessionId: owner.id,
                      runtime,
                    });
              const requireHistory = (): AgentTreeHistory => {
                owner.ensure();
                opened ??= createAgentTreeHistory({
                  sessionId: owner.id,
                  runtime,
                });
                return opened;
              };
              return {
                sessionId: owner.id,
                persistence: {
                  accepted: (lifecycle) =>
                    requireHistory().persistence.accepted(lifecycle),
                  rejected: (lifecycle) => {
                    requireHistory().persistence.rejected(lifecycle);
                  },
                },
                entries: () => requireHistory().entries(),
                runs: (id) => requireHistory().runs(id),
                pendingResultDeliveries: (parentMessages) =>
                  opened?.pendingResultDeliveries(parentMessages) ?? [],
                deliveredResult: (delivery) => {
                  requireHistory().deliveredResult(delivery);
                },
                transcript: (entry) => requireHistory().transcript(entry),
                messages: (entry) => requireHistory().messages(entry),
              };
            })();
      const displaySession =
        activeSessionId === undefined
          ? ({ kind: "ephemeral" } as const)
          : ({
              kind: "saved",
              sessionId: activeSessionId,
              resumeAvailable: sessionStart.kind !== "create",
            } as const);
      const invocationInterrupt = invocation?.interrupt ?? { handler: null };
      const interactiveTerminalDisplay =
        invocation?.terminalDisplay ??
        (mode.kind === "interactive" &&
        runtime.input.isTTY === true &&
        runtime.stdoutIsTTY === true &&
        runtime.stderrIsTTY === true &&
        runtime.createInteractiveTerminal !== undefined
          ? createInteractiveTerminalDisplay(
              runtime.createInteractiveTerminal(),
              {
                inputEchoesToDisplay: true,
                session: displaySession,
                colorMode:
                  runtime.env("NO_COLOR") === undefined ? "ansi" : "plain",
                workspace,
                skillCompletions: skillCatalog?.skills ?? [],
                onInterrupt: () => {
                  invocationInterrupt.handler?.();
                },
              },
            )
          : undefined);
      const stableInteractiveDisplay =
        invocation?.stableDisplay ??
        (interactiveTerminalDisplay === undefined &&
        mode.kind === "interactive" &&
        runtime.input.isTTY === true
          ? createStableInteractiveDisplay(runtime, {
              inputEchoesToDisplay: runtime.stderrIsTTY === true,
              session: displaySession,
            })
          : undefined);
      const interactiveDisplay =
        interactiveTerminalDisplay ?? stableInteractiveDisplay;
      const reportRecorder =
        invocation?.reportRecorder ?? createAgentEventReportRecorder();
      const memoryReportState = invocation?.memoryReportState ?? {
        loadedMemory: undefined,
        memoryLoadError: undefined,
        exposedEntries: new Map<string, RunReportMemoryEntry>(),
        exposedBytes: 0,
        exposedTokens: 0,
      };
      const agentMemory =
        invocation?.agentMemory ??
        createAgentProjectMemory({ runtime, workspace });
      const disabledMemoryReport = (): RunReportMemory => ({
        status: "disabled",
        scope: null,
        loadedIds: [],
        loadedEntries: [],
        renderedBytes: 0,
        estimatedTokens: 0,
        operations: [],
      });
      const loadedMemoryReport = (
        memory: RenderedProjectMemory,
      ): RunReportMemory => ({
        status: "available",
        scope: memory.scope,
        loadedIds: memory.entries.map((entry) => entry.id),
        loadedEntries: memory.entries.map(projectMemoryReportEntry),
        renderedBytes: memory.renderedBytes,
        estimatedTokens: memory.estimatedTokens,
        operations: agentMemory.operations(),
      });
      const lastLoadedMemoryScope = () =>
        memoryReportState.loadedMemory?.scope ?? null;
      const readMemory = (): RenderedProjectMemory => {
        try {
          memoryReportState.loadedMemory = loadRenderedProjectMemory(
            runtime,
            workspace,
          );
          memoryReportState.memoryLoadError = undefined;
          return memoryReportState.loadedMemory;
        } catch (error) {
          memoryReportState.memoryLoadError = errorMessage(error);
          throw error;
        }
      };
      const loadMemoryPrompt = (): string => {
        const memory = readMemory();
        for (const entry of memory.entries) {
          memoryReportState.exposedEntries.set(
            entry.id,
            projectMemoryReportEntry(entry),
          );
        }
        memoryReportState.exposedBytes = Math.max(
          memoryReportState.exposedBytes,
          memory.renderedBytes,
        );
        memoryReportState.exposedTokens = Math.max(
          memoryReportState.exposedTokens,
          memory.estimatedTokens,
        );
        return memory.prompt;
      };
      const memoryReport = (): RunReportMemory => {
        if (!cliArgs.memoryEnabled) return disabledMemoryReport();
        if (memoryReportState.memoryLoadError !== undefined) {
          return {
            status: "error",
            scope: lastLoadedMemoryScope(),
            loadedIds: [...memoryReportState.exposedEntries.keys()],
            loadedEntries: [...memoryReportState.exposedEntries.values()],
            renderedBytes: memoryReportState.exposedBytes,
            estimatedTokens: memoryReportState.exposedTokens,
            operations: agentMemory.operations(),
            error: memoryReportState.memoryLoadError,
          };
        }
        let currentMemory = memoryReportState.loadedMemory;
        try {
          currentMemory ??= readMemory();
        } catch (error) {
          return {
            status: "error",
            scope: lastLoadedMemoryScope(),
            loadedIds: [...memoryReportState.exposedEntries.keys()],
            loadedEntries: [...memoryReportState.exposedEntries.values()],
            renderedBytes: memoryReportState.exposedBytes,
            estimatedTokens: memoryReportState.exposedTokens,
            operations: agentMemory.operations(),
            error: errorMessage(error),
          };
        }
        return {
          status: "available",
          scope: currentMemory.scope,
          loadedIds: [...memoryReportState.exposedEntries.keys()],
          loadedEntries: [...memoryReportState.exposedEntries.values()],
          renderedBytes: memoryReportState.exposedBytes,
          estimatedTokens: memoryReportState.exposedTokens,
          operations: agentMemory.operations(),
        };
      };
      const inspectMemoryStatus = (): RunReportMemory => {
        if (!cliArgs.memoryEnabled) return disabledMemoryReport();
        try {
          return loadedMemoryReport(readMemory());
        } catch (error) {
          return {
            status: "error",
            scope: lastLoadedMemoryScope(),
            loadedIds: [],
            loadedEntries: [],
            renderedBytes: 0,
            estimatedTokens: 0,
            operations: agentMemory.operations(),
            error: errorMessage(error),
          };
        }
      };
      if (invocation === undefined) {
        interactiveDisplay?.writeIntro();
        interactiveTerminalDisplay?.start();
      }
      const activeSession: InteractiveActiveSession =
        cliArgs.memoryEnabled &&
        mode.kind === "interactive" &&
        savedInteractiveSession !== null &&
        runtime.input.isTTY === true
          ? {
              kind: "saved",
              persistence: savedInteractiveSession,
              state: initialActiveSessionState,
              memory: {
                kind: "reviewed",
                prompt: loadMemoryPrompt,
                mutation: agentMemory.capability,
                proposal: agentMemory.proposalCapability,
                status: inspectMemoryStatus,
              },
            }
          : savedInteractiveSession === null
            ? {
                kind: "ephemeral",
                state: initialActiveSessionState,
                memory: !cliArgs.memoryEnabled
                  ? { kind: "disabled", status: inspectMemoryStatus }
                  : {
                      kind: "direct",
                      prompt: loadMemoryPrompt,
                      mutation: agentMemory.capability,
                      status: inspectMemoryStatus,
                    },
              }
            : {
                kind: "saved",
                persistence: savedInteractiveSession,
                state: initialActiveSessionState,
                memory: !cliArgs.memoryEnabled
                  ? { kind: "disabled", status: inspectMemoryStatus }
                  : {
                      kind: "direct",
                      prompt: loadMemoryPrompt,
                      mutation: agentMemory.capability,
                      status: inspectMemoryStatus,
                    },
              };
      const interactiveSessionOptions: InteractiveSessionOptions = {
        cliArgs,
        workspace,
        reportRecorder,
        ...(invocation !== undefined
          ? {
              initialInvocationAccounting: invocation.state.accounting,
              undoProtection: invocation.state.undoProtection,
              priorExplicitSkillActivations:
                invocation.state.explicitSkillActivations,
            }
          : {}),
        activeSession,
        ...(hiddenWorkspacePaths.length > 0 ? { hiddenWorkspacePaths } : {}),
        platform: runtime.platform,
        ...(mode.kind === "headless-goal" ? { exitOnTurnAbort: true } : {}),
        ...(mode.kind === "headless-goal" &&
        headlessGoalBashPermission !== undefined
          ? { bashPermission: headlessGoalBashPermission }
          : {}),
        ...(cliArgs.providerId !== undefined || cliArgs.model !== undefined
          ? {
              configuredModelSelection: {
                ...(cliArgs.providerId !== undefined
                  ? { providerId: cliArgs.providerId }
                  : {}),
                ...(cliArgs.model !== undefined
                  ? { model: cliArgs.model }
                  : {}),
              },
            }
          : {}),
        ...(projectInstructions !== undefined ? { projectInstructions } : {}),
        skills,
        ...(firstMcpServer !== undefined
          ? {
              mcp: {
                servers: [firstMcpServer, ...remainingMcpServers],
                connectionFactory: createCliMcpConnectionFactory(runtime),
                lifecycle: createCliMcpLifecyclePolicy(runtime),
                canPrompt:
                  mode.kind === "interactive" && runtime.input.isTTY === true,
                approvalRuntime: runtime,
              },
            }
          : {}),
        ...(initialInputLines.length > 0 ? { initialInputLines } : {}),
        ...(sourceHandoff !== undefined
          ? {
              onInitialInputLinesAdmitted: () => {
                sourceHandoff.consumeSourceInputs();
                handoffSourceLock?.release();
                handoffSourceLock = undefined;
                runtime.writeStderr(
                  `Switched session: ${sourceHandoff.targetSessionId}\n`,
                );
              },
            }
          : {}),
        ...(projectBashApprovals !== undefined
          ? {
              projectRoot: projectBashApprovals.projectRoot,
              initialProjectBashApprovalGrants: projectBashApprovals.grants,
              persistProjectBashApprovalGrant: (grant) => {
                saveBashProjectApprovalGrant(runtime, grant);
              },
            }
          : {}),
        toolOutputArtifacts,
        ...(agentHistory !== undefined ? { agentHistory } : {}),
        ...(cliArgs.agentPolicy !== "off"
          ? {
              delegation: {
                policy: cliArgs.agentPolicy,
                transcriptStore: toolOutputArtifacts.store,
                maxCostUsd: cliArgs.maxCostUsd,
              },
            }
          : {}),
        input: runtime.input,
        ...(invocation?.lineInput !== undefined
          ? { lineInput: invocation.lineInput }
          : interactiveTerminalDisplay !== undefined
            ? { lineInput: interactiveTerminalDisplay.lineInput }
            : {}),
        ...(mode.kind === "interactive" && savedInteractiveSession !== null
          ? {
              sessionPicker: () => {
                const catalog = listSessionCatalog({ workspace, runtime });
                runtime.writeStderr(
                  formatSessionCatalogWarnings(catalog.warnings),
                );
                return buildSessionPickerView(catalog, {
                  activeSessionId: savedInteractiveSession.id,
                });
              },
            }
          : {}),
        writeStdout: (text) => {
          (interactiveDisplay ?? runtime).writeStdout(text);
        },
        writeStderr: (text) => {
          (interactiveDisplay ?? runtime).writeStderr(text);
        },
        ...(interactiveDisplay !== undefined
          ? { renderPrompt: interactiveDisplay.renderPrompt }
          : {}),
        ...(interactiveDisplay !== undefined
          ? { acceptInput: interactiveDisplay.acceptInput }
          : {}),
        ...(interactiveDisplay !== undefined
          ? { closePrompt: interactiveDisplay.closePrompt }
          : {}),
        ...(interactiveTerminalDisplay !== undefined
          ? {
              setComposerMode: interactiveTerminalDisplay.setComposerMode,
              renderSubmittedInput:
                interactiveTerminalDisplay.renderSubmittedInput,
              renderDiffReview: interactiveTerminalDisplay.renderDiffReview,
              setGoalStatus: interactiveTerminalDisplay.setGoalStatus,
            }
          : {}),
        onSigint: (handler) => {
          invocationInterrupt.handler = handler;
          runtime.onSigint(handler);
        },
        offSigint: (handler) => {
          invocationInterrupt.handler = null;
          runtime.offSigint(handler);
        },
        setExitCode: (code) => {
          exitCode = code;
        },
        forceExit: (code) => {
          interactiveTerminalDisplay?.stop();
          return runtime.forceExit(code);
        },
        resolveProvider: (message, selection) =>
          resolveInteractiveProvider(
            message,
            runtime,
            selection ?? {
              ...(cliArgs.providerId !== undefined
                ? { providerId: cliArgs.providerId }
                : {}),
              ...(cliArgs.model !== undefined ? { model: cliArgs.model } : {}),
            },
          ),
        requireKnownCostModel,
        printAgentEvents: (stream) => {
          if (interactiveTerminalDisplay !== undefined) {
            return printInteractiveTerminalAgentEvents(
              stream,
              interactiveTerminalDisplay,
            );
          }
          if (stableInteractiveDisplay !== undefined) {
            return printStableInteractiveAgentEvents(
              stream,
              stableInteractiveDisplay,
            );
          }
          return printAgentEvents(stream, runtime);
        },
        formatCostReport,
      };
      const failureReportFile = cliArgs.reportFile;
      if (failureReportFile !== undefined) {
        writeFailureReport = (error) => {
          writeRunReportBestEffort(
            failureReportFile,
            {
              tasks: reportRecorder.tasks(),
              modelOperations: reportRecorder.modelOperations(),
              outcome: {
                status: "failed",
                error,
                ...(cliArgs.maxCostUsd !== undefined
                  ? { maxCostUsd: cliArgs.maxCostUsd }
                  : {}),
                ...(activeSessionId !== undefined
                  ? { sessionId: activeSessionId }
                  : {}),
              },
              durationMs: runtime.now() - startedAt,
              contextCompactions: reportRecorder.contextCompactions(),
              skillActivations: [
                ...(invocation?.state.explicitSkillActivations ?? []),
                ...initialSkillActivationRecords,
                ...reportRecorder.skillActivations(),
              ],
              activeSkills: reportActiveSkills(
                skillActivation?.activeStatuses() ?? [],
              ),
              skillCatalog: reportRecorder.skillCatalog(),
              skillPolicy: skillPolicyReport(
                skillPolicy,
                cliArgs.skillsEnabled,
              ),
              undoProtection: reportRecorder.undoProtection(),
              memory: memoryReport(),
            },
            createCliRuntimeErrorReporter(runtime.writeStderr),
          );
        };
      }
      const interactiveResult = await runInteractiveSessionWithTerminalDisplay(
        interactiveSessionOptions,
        interactiveTerminalDisplay,
      );
      writeFailureReport = undefined;
      if (interactiveResult.switchSession !== undefined) {
        const switchRequest = interactiveResult.switchSession;
        let nextSessionId = switchRequest.targetSessionId;
        let nextSessionLock: SessionLock;
        let nextInitialInputLines = switchRequest.initialInputLines;
        let nextSourceHandoff:
          | ActiveSessionTransition["sourceHandoff"]
          | undefined;
        let acquiredTargetLock: SessionLock | undefined;
        try {
          acquiredTargetLock = acquireSessionLock({
            sessionId: nextSessionId,
            runtime,
          });
          resumeSessionStore({
            sessionId: nextSessionId,
            workspace,
            runtime,
          });
          /* v8 ignore next 8: a switch request can only come from the saved interactive session that owns sessionLock. */
          if (sessionLock === undefined || savedInteractiveSession === null) {
            throw new SessionStoreError(
              "Error: cannot transfer an unlocked interactive session.",
            );
          }
          nextSessionLock = acquiredTargetLock;
          nextSourceHandoff = {
            lock: sessionLock,
            consumeSourceInputs: () => {
              savedInteractiveSession.consumeQueuedInputs(
                switchRequest.sourceInputIds,
              );
            },
            targetSessionId: nextSessionId,
          };
          sessionLock = undefined;
        } catch (error) {
          acquiredTargetLock?.release();
          runtime.writeStderr(
            `Session switch failed: ${errorMessage(error)}\n`,
          );
          /* v8 ignore next 3: both source identities remain owned until a validated target handoff succeeds. */
          if (sessionLock === undefined || activeSessionId === undefined) {
            throw error;
          }
          nextSessionId = activeSessionId;
          nextSessionLock = sessionLock;
          nextInitialInputLines = [];
          sessionLock = undefined;
        }
        const nextCliArgs: InteractiveRunCliArgs = {
          ...cliArgs,
          session: { kind: "resume", sessionId: nextSessionId },
        };
        const nextInvocation: InteractiveInvocationScope = {
          lineInput: switchRequest.lineInput,
          interrupt: invocationInterrupt,
          terminalDisplay: interactiveTerminalDisplay,
          stableDisplay: stableInteractiveDisplay,
          reportRecorder,
          startedAt,
          state: interactiveResult.invocationState,
          agentMemory,
          memoryReportState,
        };
        const nextTransition: ActiveSessionTransition = {
          preacquiredSessionLock: nextSessionLock,
          initialInputLines: nextInitialInputLines,
          ...(nextSourceHandoff !== undefined
            ? { sourceHandoff: nextSourceHandoff }
            : {}),
        };
        /* v8 ignore next 5: /sessions is only exposed by the interactive-mode session loop. */
        if (mode.kind !== "interactive") {
          throw new Error(
            "internal: a headless session cannot switch sessions",
          );
        }
        return {
          kind: "switch",
          cliArgs: nextCliArgs,
          invocation: nextInvocation,
          transition: nextTransition,
        };
      }
      let headlessGoalOutcome: HeadlessGoalOutcome | undefined;
      if (mode.kind === "headless-goal" && exitCode === 0) {
        headlessGoalOutcome = requireHeadlessGoalOutcome(
          activeSessionId,
          interactiveResult.goal,
        );
      }
      if (
        cliArgs.reportFile !== undefined &&
        interactiveResult.report !== undefined
      ) {
        const goalOutcome =
          headlessGoalOutcome === undefined
            ? undefined
            : headlessGoalRunReportOutcome(headlessGoalOutcome);
        const headlessStopReason =
          headlessGoalOutcome !== undefined &&
          interactiveResult.report.end.stopReason !== "cost_budget"
            ? headlessGoalRunReportStopReason(headlessGoalOutcome)
            : undefined;
        writeRunReport(cliArgs.reportFile, {
          tasks: interactiveResult.report.tasks,
          modelOperations: interactiveResult.report.modelOperations,
          outcome: {
            status: "completed",
            end:
              headlessStopReason === undefined
                ? interactiveResult.report.end
                : {
                    ...interactiveResult.report.end,
                    stopReason: headlessStopReason,
                  },
          },
          durationMs: runtime.now() - startedAt,
          contextCompactions: reportRecorder.contextCompactions(),
          skillActivations: [
            ...interactiveResult.report.explicitSkillActivations,
            ...reportRecorder.skillActivations(),
          ],
          activeSkills: reportActiveSkills(
            skillActivation?.activeStatuses() ?? [],
          ),
          skillCatalog: interactiveResult.report.skillCatalog,
          skillPolicy: skillPolicyReport(skillPolicy, cliArgs.skillsEnabled),
          undoProtection: interactiveResult.report.undoProtection,
          memory: memoryReport(),
          ...(goalOutcome !== undefined ? { goalOutcome } : {}),
        });
      }
      if (mode.kind === "headless-goal") {
        return headlessGoalOutcome === undefined
          ? { kind: "failed", exitCode }
          : { kind: "finished", outcome: headlessGoalOutcome };
      }
    } finally {
      sourceSessionLock?.release();
      sessionLock?.release();
      handoffSourceLock?.release();
    }
  } catch (error) {
    if (!isAbortThrow(error)) {
      writeFailureReport?.(error);
    }
    if (error instanceof ProviderConfigError) {
      runtime.writeStderr(`${error.message}\n`);
      return activeSessionCliExit(mode, 1);
    }
    if (error instanceof ProjectInstructionsError) {
      runtime.writeStderr(`${error.message}\n`);
      return activeSessionCliExit(mode, 1);
    }
    if (error instanceof ProjectMemoryError) {
      runtime.writeStderr(`${error.message}\n`);
      return activeSessionCliExit(mode, 1);
    }
    if (
      error instanceof WorkflowSkillError ||
      error instanceof SkillUserConfigError
    ) {
      runtime.writeStderr(`${error.message}\n`);
      return activeSessionCliExit(mode, 1);
    }
    if (error instanceof BashProjectApprovalsError) {
      runtime.writeStderr(`${error.message}\n`);
      return activeSessionCliExit(mode, 1);
    }
    if (error instanceof McpConfigError) {
      runtime.writeStderr(`${error.message}\n`);
      return activeSessionCliExit(mode, 1);
    }
    if (isAbortThrow(error)) {
      return activeSessionCliExit(mode, 130);
    }
    if (error instanceof SessionStoreError) {
      runtime.writeStderr(`${error.message}\n`);
      return activeSessionCliExit(mode, 1);
    }
    runtime.writeStderr(formatCliRuntimeError(error));
    return activeSessionCliExit(mode, 1);
  }
  return activeSessionCliExit(mode, exitCode);
}

async function runInteractiveInvocationCli(
  cliArgs: InteractiveRunCliArgs,
  runtime: CliRuntime,
): Promise<number> {
  let activeCliArgs = cliArgs;
  let invocation: InteractiveInvocationScope | undefined;
  let transition: ActiveSessionTransition | undefined;
  while (true) {
    const result = await runActiveSessionCli(
      activeCliArgs,
      runtime,
      { kind: "interactive" },
      invocation,
      transition,
    );
    if (result.kind === "finished") {
      return result.exitCode;
    }
    activeCliArgs = result.cliArgs;
    invocation = result.invocation;
    transition = result.transition;
  }
}

export async function runHeadlessSessionCli(
  cliArgs: HeadlessSessionCliArgs,
  runtime: CliRuntime,
  initialCommand: string,
  bashPermission: SessionBashPermissionPolicy | undefined,
  onActivated: (sessionId: string) => void,
  prepareResumedGoal?: (goal: SessionGoal | undefined) => Promise<
    | {
        readonly kind: "ready";
        readonly goal: ResumableSessionGoal;
        readonly bashPermission?: SessionBashPermissionPolicy;
      }
    | { readonly kind: "rejected" }
  >,
  latestGoalResumeAssessment?: (
    goal: SessionGoal | undefined,
  ) => SessionGoalResumeAssessment,
): Promise<HeadlessSessionCliResult> {
  const headlessInput = Readable.from([]);
  return await runActiveSessionCli(
    cliArgs,
    { ...runtime, input: headlessInput },
    {
      kind: "headless-goal",
      initialCommand,
      ...(bashPermission !== undefined ? { bashPermission } : {}),
      ...(prepareResumedGoal !== undefined ? { prepareResumedGoal } : {}),
      ...(latestGoalResumeAssessment !== undefined
        ? { latestGoalResumeAssessment }
        : {}),
      onActivated,
    },
  );
}

export async function runInteractiveCli(
  cliArgs: InteractiveRunCliArgs,
  runtime: CliRuntime,
): Promise<number> {
  return await runInteractiveInvocationCli(cliArgs, runtime);
}
