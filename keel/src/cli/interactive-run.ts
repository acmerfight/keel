import { Readable } from "node:stream";
import { isAbortThrow } from "../core/error.ts";
import {
  pauseActiveSessionGoal,
  type SessionGoal,
  type SessionGoalResumeAssessment,
} from "../core/session-goal.ts";
import type { Message } from "../llm/types.ts";
import type {
  BashApprovalGrant,
  SessionBashPermissionPolicy,
} from "../permissions/bash.ts";
import type { CliArgs } from "./args.ts";
import { USAGE } from "./args.ts";
import {
  BashProjectApprovalsError,
  bashApprovalProjectRoot,
  listBashProjectApprovalGrants,
  saveBashProjectApprovalGrant,
} from "./bash-project-approvals.ts";
import { sessionForkPointsFromStoredMessages } from "./fork-points.ts";
import { createStableInteractiveDisplay } from "./interactive-session/display.ts";
import {
  type InteractiveForkSessionRequest,
  type InteractiveSessionOptions,
  runInteractiveSession,
  type SessionPersistenceReason,
} from "./interactive-session.ts";
import {
  formatCostReport,
  printAgentEvents,
  printStableInteractiveAgentEvents,
} from "./output.ts";
import {
  loadProjectInstructions,
  ProjectInstructionsError,
} from "./project-instructions.ts";
import {
  ProviderConfigError,
  requireKnownCostModel,
  resolveInteractiveProvider,
} from "./provider-config.ts";
import { type RunReportGoalOutcome, writeRunReport } from "./report.ts";
import { createAgentEventReportRecorder } from "./report-events.ts";
import { resolveResumedWorkflowSkill } from "./resumed-workflow-skill.ts";
import type { CliRuntime } from "./runtime.ts";
import { formatCliRuntimeError } from "./runtime-error.ts";
import {
  formatSessionCatalogWarnings,
  formatSessionForkCreated,
  formatSessionPicker,
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
  persistSessionTaskProgress,
  persistSessionTitle,
  resumeSessionStore,
  type SessionCatalog,
  type SessionCatalogEntry,
  type SessionLock,
  type SessionModelSelection,
  type SessionQueuedInput,
  type SessionState,
  SessionStoreError,
  sessionStoredMessages,
} from "./session-store.ts";
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
import { loadWorkflowSkill, WorkflowSkillError } from "./workflow-skills.ts";

type RunCliArgs = Extract<CliArgs, { readonly command: "run" }>;

async function runInteractiveSessionWithTerminalDisplay(
  options: InteractiveSessionOptions,
  terminalDisplay: InteractiveTerminalDisplay | undefined,
) {
  try {
    return await runInteractiveSession(options);
  } finally {
    terminalDisplay?.stop();
  }
}
type DirectResumeSessionCliArg = Exclude<
  NonNullable<RunCliArgs["resumeSession"]>,
  { readonly kind: "pick" }
>;

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
            readonly goal: SessionGoal;
            readonly bashPermission?: SessionBashPermissionPolicy;
          }
        | { readonly kind: "rejected" }
      >;
      readonly latestGoalResumeAssessment?: (
        goal: SessionGoal | undefined,
      ) => SessionGoalResumeAssessment;
      readonly onActivated: (sessionId: string) => void;
      readonly onFinished: (result: {
        readonly sessionId: string;
        readonly goal: SessionGoal | undefined;
      }) => void;
    };

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
      readonly beforeMessageId?: string;
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

function interactiveSessionStartFromCliArgs(
  cliArgs: {
    readonly ephemeral: boolean;
    readonly sessionId?: string;
    readonly resumeSession?: DirectResumeSessionCliArg;
    readonly forkSessionId?: string;
    readonly forkBeforeMessage?: string;
  },
  options: {
    readonly workspace: string;
    readonly runtime: CliRuntime;
    readonly latestSessionAssessment?: (
      session: SessionCatalogEntry,
    ) => SessionGoalResumeAssessment;
  },
): InteractiveSessionStart {
  if (cliArgs.ephemeral) {
    return { kind: "ephemeral" };
  }
  if (cliArgs.sessionId !== undefined) {
    return { kind: "create", sessionId: cliArgs.sessionId };
  }
  if (
    cliArgs.resumeSession?.kind === "id" &&
    cliArgs.forkSessionId !== undefined
  ) {
    return {
      kind: "fork",
      sourceSessionId: cliArgs.resumeSession.sessionId,
      targetSessionId: cliArgs.forkSessionId,
      ...(cliArgs.forkBeforeMessage !== undefined
        ? { beforeMessageId: cliArgs.forkBeforeMessage }
        : {}),
    };
  }
  if (cliArgs.resumeSession?.kind === "id") {
    return { kind: "resume", sessionId: cliArgs.resumeSession.sessionId };
  }
  if (cliArgs.resumeSession?.kind === "latest") {
    const sessionId = latestSessionIdForWorkspace(options);
    options.runtime.writeStderr(`Resuming latest session: ${sessionId}\n`);
    return { kind: "resume", sessionId };
  }
  return { kind: "create", sessionId: createAutomaticSessionId() };
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
  cliArgs: RunCliArgs,
  runtime: CliRuntime,
): boolean {
  return (
    runtime.args.length === 0 &&
    runtime.input.isTTY === true &&
    !cliArgs.ephemeral &&
    cliArgs.sessionId === undefined &&
    cliArgs.resumeSession === undefined &&
    cliArgs.forkSessionId === undefined &&
    cliArgs.forkBeforeMessage === undefined &&
    cliArgs.forkPoints !== true
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
  runtime.writeStdout(startupPrompt);
  const startupSelection = await readSessionStartupSelection({
    input: runtime.input,
    maxChoice: catalog.sessions.length,
    startupPrompt,
    pickerPrompt: formatSessionPicker(catalog),
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
        catalog.sessions[startupSelection.selection.choice - 1];
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
  runtime.writeStdout(formatSessionPicker(catalog));
  const pickerResult = await readSessionPickerSelection({
    input: runtime.input,
    maxChoice: catalog.sessions.length,
    writeStdout: runtime.writeStdout,
    writeStderr: runtime.writeStderr,
  });
  if (pickerResult.kind === "cancelled") {
    if (pickerResult.explicit) {
      runtime.writeStdout("Resume cancelled.\n");
    }
    return null;
  }
  const selectedSession = catalog.sessions[pickerResult.selection.choice - 1];
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

async function runSessionCli(
  cliArgs: RunCliArgs,
  runtime: CliRuntime,
  mode: SessionCliMode,
): Promise<number> {
  let exitCode = 0;

  if (
    mode.kind === "interactive" &&
    cliArgs.resumeSession?.kind === "pick" &&
    runtime.input.isTTY !== true
  ) {
    runtime.writeStderr(`${RESUME_PICK_REQUIRES_TTY_ERROR}\n`);
    return 1;
  }
  if (
    mode.kind === "interactive" &&
    runtime.input.isTTY !== true &&
    runtime.env("KEEL_FORCE_INTERACTIVE") !== "1"
  ) {
    runtime.writeStderr(`${USAGE}\n`);
    return 1;
  }
  if (
    mode.kind === "interactive" &&
    cliArgs.bashMode === "ask" &&
    runtime.input.isTTY !== true
  ) {
    runtime.writeStderr(
      "Error: --bash-policy ask requires a real TTY so approvals cannot be read from piped input. Use --bash-policy deny or --bash-policy trusted for non-TTY runs.\n",
    );
    return 1;
  }
  let sessionLock: SessionLock | undefined;
  let sourceSessionLock: SessionLock | undefined;
  try {
    const workspace = runtime.cwd();
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
      mode.kind === "headless-goal" ? [mode.initialCommand] : [];
    if (cliArgs.resumeSession?.kind === "pick") {
      const pickedSession = await pickedSessionIdForWorkspace({
        workspace,
        runtime,
      });
      if (pickedSession === null) {
        return 0;
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
        sessionStart = interactiveSessionStartFromCliArgs(
          {
            ephemeral: cliArgs.ephemeral,
          },
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
          return 0;
        }
        sessionStart = promptedSessionStart.sessionStart;
        initialInputLines = promptedSessionStart.initialInputLines;
      }
    } else {
      const directResumeSession: DirectResumeSessionCliArg | undefined =
        cliArgs.resumeSession;
      sessionStart = interactiveSessionStartFromCliArgs(
        {
          ephemeral: cliArgs.ephemeral,
          ...(cliArgs.sessionId !== undefined
            ? { sessionId: cliArgs.sessionId }
            : {}),
          ...(directResumeSession !== undefined
            ? { resumeSession: directResumeSession }
            : {}),
          ...(cliArgs.forkSessionId !== undefined
            ? { forkSessionId: cliArgs.forkSessionId }
            : {}),
          ...(cliArgs.forkBeforeMessage !== undefined
            ? { forkBeforeMessage: cliArgs.forkBeforeMessage }
            : {}),
        },
        {
          workspace,
          runtime,
          ...(latestGoalResumeAssessment !== undefined
            ? {
                latestSessionAssessment: (
                  catalogSession: SessionCatalogEntry,
                ) => latestGoalResumeAssessment(catalogSession.goal),
              }
            : {}),
        },
      );
    }
    try {
      if (sessionStart.kind === "fork") {
        sourceSessionLock = acquireSessionLock({
          sessionId: sessionStart.sourceSessionId,
          runtime,
        });
      }
      const sessionIdForLock = activeSessionIdForStart(sessionStart);
      if (sessionIdForLock !== null) {
        sessionLock = acquireSessionLock({
          sessionId: sessionIdForLock,
          runtime,
        });
      }
      let session: SessionState | undefined;
      let activeSessionId: string | undefined;
      let persistedMessages: readonly Message[] = [];
      let initialModelSelection: SessionModelSelection | undefined;
      let headlessGoalBashPermission =
        mode.kind === "headless-goal" ? mode.bashPermission : undefined;
      let headlessPreparedSessionGoal: SessionGoal | undefined;
      let workflowSkill =
        (sessionStart.kind === "create" || sessionStart.kind === "ephemeral") &&
        cliArgs.skillName !== undefined
          ? loadWorkflowSkill(workspace, cliArgs.skillName)
          : undefined;
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
        const resumedWorkflowSkill = resolveResumedWorkflowSkill({
          session: resumedSession,
          ...(cliArgs.skillName !== undefined
            ? { requestedSkillName: cliArgs.skillName }
            : {}),
        });
        if (sessionStart.kind === "fork") {
          ensureSessionCanBeCreated({
            sessionId: sessionStart.targetSessionId,
            runtime,
          });
          session = forkSessionStore({
            source: resumedSession,
            targetSessionId: sessionStart.targetSessionId,
            ...(sessionStart.beforeMessageId !== undefined
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
              return 1;
            }
            headlessPreparedSessionGoal = preparation.goal;
            headlessGoalBashPermission = preparation.bashPermission;
          }
        }
        workflowSkill = resumedWorkflowSkill;
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
      let sessionPersistence:
        | {
            readonly initialMessages: readonly Message[];
            readonly initialSessionTitle?: string;
            readonly initialSessionGoal?: SessionGoal;
            readonly initialTaskProgress: SessionState["taskProgress"];
            readonly initialModelSelection?: SessionModelSelection;
            readonly initialModelSwitchCount: number;
            readonly initialQueuedInputs: readonly SessionQueuedInput[];
            readonly persistQueuedInput: (input: {
              readonly sequence: number;
              readonly line: string;
            }) => SessionQueuedInput;
            readonly consumeQueuedInputs: (inputIds: readonly string[]) => void;
            readonly persistSessionMessages: (
              messages: readonly Message[],
              reason: SessionPersistenceReason,
              consumedInputIds: readonly string[],
            ) => void;
            readonly persistSessionTitle: (titleRecord: {
              readonly title: string;
              readonly consumedInputIds: readonly string[];
            }) => string;
            readonly persistSessionGoal: (update: {
              readonly goal: SessionGoal | null;
              readonly consumedInputIds: readonly string[];
            }) => SessionGoal | undefined;
            readonly persistTaskProgress: (update: {
              readonly taskProgress: SessionState["taskProgress"];
              readonly messageOrdinal: number;
            }) => void;
            readonly persistModelSwitch: (switchRecord: {
              readonly from: SessionModelSelection | null;
              readonly to: SessionModelSelection;
              readonly consumedInputIds: readonly string[];
            }) => void;
            readonly forkSession: (
              request: InteractiveForkSessionRequest,
            ) => string;
            readonly listForkPoints: () => ReturnType<
              typeof sessionForkPointsFromStoredMessages
            >;
            readonly initialBashApprovalGrants: readonly BashApprovalGrant[];
            readonly persistBashApprovalGrant: (
              grant: BashApprovalGrant,
            ) => void;
            readonly persistBashApprovalRevoked: (revocation: {
              readonly grant: BashApprovalGrant;
              readonly consumedInputIds: readonly string[];
            }) => void;
            readonly persistBashApprovalsCleared: (clear: {
              readonly consumedInputIds: readonly string[];
            }) => void;
          }
        | undefined;
      let headlessGoalActivated = false;
      if (activeSessionId !== undefined) {
        const sessionId = activeSessionId;
        const ensureActiveSession = (): SessionState => {
          let activeSession = session;
          if (activeSession === undefined) {
            activeSession = createSessionStore({
              sessionId,
              workspace,
              runtime,
              ...(workflowSkill !== undefined ? { workflowSkill } : {}),
            });
            session = activeSession;
            persistedMessages = activeSession.messages;
          }
          return activeSession;
        };
        const forkActiveSession = (
          request: InteractiveForkSessionRequest,
        ): string => {
          const sourceSessionId = ensureActiveSession().id;
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
            storedMessages: sessionStoredMessages(ensureActiveSession()),
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
        sessionPersistence = {
          initialMessages: initialSession?.messages ?? [],
          ...(initialSession?.title !== undefined
            ? { initialSessionTitle: initialSession.title }
            : {}),
          ...(initialSessionGoal !== undefined ? { initialSessionGoal } : {}),
          initialTaskProgress: initialSession?.taskProgress ?? {
            tasks: [],
          },
          ...(initialModelSelection !== undefined
            ? { initialModelSelection }
            : {}),
          initialModelSwitchCount: initialSession?.modelSwitches.length ?? 0,
          initialQueuedInputs: initialSession?.pendingInputs ?? [],
          initialBashApprovalGrants: initialSession?.bashApprovalGrants ?? [],
          persistQueuedInput: (input: {
            readonly sequence: number;
            readonly line: string;
          }) =>
            persistSessionQueuedInput({
              session: ensureActiveSession(),
              sequence: input.sequence,
              line: input.line,
              runtime,
            }),
          consumeQueuedInputs: (inputIds: readonly string[]) => {
            consumeSessionQueuedInputs({
              session: ensureActiveSession(),
              inputIds,
              runtime,
            });
          },
          persistSessionMessages: (
            messages: readonly Message[],
            reason: SessionPersistenceReason,
            consumedInputIds: readonly string[],
          ) => {
            const activeSession = ensureActiveSession();
            persistedMessages = persistSessionMessages({
              session: activeSession,
              previousMessages: persistedMessages,
              currentMessages: messages,
              runtime,
              reason,
              consumedInputIds,
            });
          },
          persistSessionTitle: (titleRecord: {
            readonly title: string;
            readonly consumedInputIds: readonly string[];
          }) =>
            persistSessionTitle({
              session: ensureActiveSession(),
              title: titleRecord.title,
              runtime,
              consumedInputIds: titleRecord.consumedInputIds,
            }),
          persistSessionGoal: (update: {
            readonly goal: SessionGoal | null;
            readonly consumedInputIds: readonly string[];
          }) => {
            const persistedGoal = persistSessionGoal({
              session: ensureActiveSession(),
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
              session: ensureActiveSession(),
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
              session: ensureActiveSession(),
              from: switchRecord.from,
              to: switchRecord.to,
              runtime,
              consumedInputIds: switchRecord.consumedInputIds,
            });
          },
          forkSession: forkActiveSession,
          listForkPoints: listActiveForkPoints,
          persistBashApprovalGrant: (grant: BashApprovalGrant) => {
            persistSessionBashApprovalGrant({
              session: ensureActiveSession(),
              grant,
              runtime,
            });
          },
          persistBashApprovalRevoked: (revocation: {
            readonly grant: BashApprovalGrant;
            readonly consumedInputIds: readonly string[];
          }) => {
            persistSessionBashApprovalRevoked({
              session: ensureActiveSession(),
              grant: revocation.grant,
              runtime,
              consumedInputIds: revocation.consumedInputIds,
            });
          },
          persistBashApprovalsCleared: (clear: {
            readonly consumedInputIds: readonly string[];
          }) => {
            persistSessionBashApprovalsCleared({
              session: ensureActiveSession(),
              runtime,
              consumedInputIds: clear.consumedInputIds,
            });
          },
        };
      }
      const projectInstructions = loadProjectInstructions(workspace);
      const startedAt = runtime.now();
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
      const displaySession =
        activeSessionId === undefined
          ? ({ kind: "ephemeral" } as const)
          : ({
              kind: "saved",
              sessionId: activeSessionId,
              resumeAvailable: sessionStart.kind !== "create",
            } as const);
      let activeSigintHandler: (() => void) | null = null;
      const interactiveTerminalDisplay =
        mode.kind === "interactive" &&
        runtime.input.isTTY === true &&
        runtime.stdoutIsTTY === true &&
        runtime.stderrIsTTY === true &&
        runtime.createInteractiveTerminal !== undefined
          ? createInteractiveTerminalDisplay(
              runtime.createInteractiveTerminal(),
              {
                inputEchoesToDisplay: true,
                session: displaySession,
                onInterrupt: () => {
                  activeSigintHandler?.();
                },
              },
            )
          : undefined;
      const interactiveDisplay =
        interactiveTerminalDisplay ??
        (mode.kind === "interactive" && runtime.input.isTTY === true
          ? createStableInteractiveDisplay(runtime, {
              inputEchoesToDisplay: runtime.stderrIsTTY === true,
              session: displaySession,
            })
          : undefined);
      const reportRecorder = createAgentEventReportRecorder();
      interactiveDisplay?.writeIntro();
      interactiveTerminalDisplay?.start();
      const interactiveSessionOptions: InteractiveSessionOptions = {
        cliArgs,
        workspace,
        platform: runtime.platform,
        ...(mode.kind === "headless-goal" ? { exitOnTurnAbort: true } : {}),
        ...(mode.kind === "headless-goal" &&
        headlessGoalBashPermission !== undefined
          ? { bashPermission: headlessGoalBashPermission }
          : {}),
        ...(activeSessionId !== undefined
          ? {
              sessionId: activeSessionId,
              sessionResumeAvailable: () => session !== undefined,
            }
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
        ...(workflowSkill !== undefined ? { workflowSkill } : {}),
        ...(sessionPersistence !== undefined ? sessionPersistence : {}),
        ...(initialInputLines.length > 0 ? { initialInputLines } : {}),
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
        input: runtime.input,
        ...(interactiveTerminalDisplay !== undefined
          ? { lineInput: interactiveTerminalDisplay.lineInput }
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
              setGoalStatus: interactiveTerminalDisplay.setGoalStatus,
            }
          : {}),
        onSigint: (handler) => {
          activeSigintHandler = handler;
          runtime.onSigint(handler);
        },
        offSigint: (handler) => {
          activeSigintHandler = null;
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
        printAgentEvents: (stream) =>
          interactiveDisplay === undefined
            ? printAgentEvents(stream, runtime, reportRecorder)
            : printStableInteractiveAgentEvents(
                stream,
                interactiveDisplay,
                reportRecorder,
              ),
        formatCostReport,
      };
      const interactiveResult = await runInteractiveSessionWithTerminalDisplay(
        interactiveSessionOptions,
        interactiveTerminalDisplay,
      );
      if (
        cliArgs.reportFile !== undefined &&
        interactiveResult.report !== undefined
      ) {
        const goalOutcome =
          mode.kind === "headless-goal" && activeSessionId !== undefined
            ? runReportGoalOutcome(activeSessionId, interactiveResult.goal)
            : undefined;
        const headlessStopReason =
          mode.kind === "headless-goal" &&
          interactiveResult.report.end.stopReason !== "cost_budget"
            ? headlessGoalReportStopReason(interactiveResult.goal)
            : undefined;
        writeRunReport(cliArgs.reportFile, {
          usageByModel: interactiveResult.report.usageByModel,
          end:
            headlessStopReason === undefined
              ? interactiveResult.report.end
              : {
                  ...interactiveResult.report.end,
                  stopReason: headlessStopReason,
                },
          durationMs: runtime.now() - startedAt,
          contextCompactions: reportRecorder.contextCompactions(),
          ...(goalOutcome !== undefined ? { goalOutcome } : {}),
        });
      }
      if (mode.kind === "headless-goal" && activeSessionId !== undefined) {
        mode.onFinished({
          sessionId: activeSessionId,
          goal: interactiveResult.goal,
        });
      }
    } finally {
      sourceSessionLock?.release();
      sessionLock?.release();
    }
  } catch (error) {
    if (error instanceof ProviderConfigError) {
      runtime.writeStderr(`${error.message}\n`);
      return 1;
    }
    if (error instanceof ProjectInstructionsError) {
      runtime.writeStderr(`${error.message}\n`);
      return 1;
    }
    if (error instanceof WorkflowSkillError) {
      runtime.writeStderr(`${error.message}\n`);
      return 1;
    }
    if (error instanceof BashProjectApprovalsError) {
      runtime.writeStderr(`${error.message}\n`);
      return 1;
    }
    if (isAbortThrow(error)) {
      return 130;
    }
    if (error instanceof SessionStoreError) {
      runtime.writeStderr(`${error.message}\n`);
      return 1;
    }
    runtime.writeStderr(formatCliRuntimeError(error));
    return 1;
  }
  return exitCode;
}

function runReportGoalOutcome(
  sessionId: string,
  goal: SessionGoal | undefined,
): RunReportGoalOutcome | undefined {
  /* v8 ignore start: report finalization follows a terminal headless Goal, so it cannot be absent, active, or paused. */
  if (
    goal === undefined ||
    goal.status === "active" ||
    goal.status === "paused"
  ) {
    return undefined;
  }
  /* v8 ignore stop */
  if (goal.status === "completed") {
    return {
      sessionId,
      status: "completed",
      /* v8 ignore next: completed Goals always persist a completion runtime outcome before report finalization. */
      reason: goal.latestRuntimeOutcome?.reason ?? "Session goal completed.",
      evidenceKind: goal.completionEvidence.kind,
    };
  }
  return {
    sessionId,
    status: goal.status,
    reason: goal.statusReason,
  };
}

function headlessGoalReportStopReason(
  goal: SessionGoal | undefined,
): "goal_blocked" | "goal_budget" | "goal_usage_limit" | undefined {
  /* v8 ignore start: report finalization follows a terminal headless Goal, so it cannot be absent, active, or paused. */
  if (
    goal === undefined ||
    goal.status === "active" ||
    goal.status === "paused"
  )
    return undefined;
  /* v8 ignore stop */
  switch (goal.status) {
    case "blocked":
      return "goal_blocked";
    case "budget_limited":
      return "goal_budget";
    case "usage_limited":
      return "goal_usage_limit";
    case "completed":
      return undefined;
  }
}

export interface HeadlessSessionCliResult {
  readonly exitCode: number;
  readonly sessionId?: string;
  readonly goal?: SessionGoal;
}

export async function runHeadlessSessionCli(
  cliArgs: RunCliArgs,
  runtime: CliRuntime,
  initialCommand: string,
  bashPermission: SessionBashPermissionPolicy | undefined,
  onActivated: (sessionId: string) => void,
  prepareResumedGoal?: (goal: SessionGoal | undefined) => Promise<
    | {
        readonly kind: "ready";
        readonly goal: SessionGoal;
        readonly bashPermission?: SessionBashPermissionPolicy;
      }
    | { readonly kind: "rejected" }
  >,
  latestGoalResumeAssessment?: (
    goal: SessionGoal | undefined,
  ) => SessionGoalResumeAssessment,
): Promise<HeadlessSessionCliResult> {
  let finalSessionId: string | undefined;
  let finalGoal: SessionGoal | undefined;
  const headlessInput = Readable.from([]);
  const exitCode = await runSessionCli(
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
      onFinished: (result) => {
        finalSessionId = result.sessionId;
        finalGoal = result.goal;
      },
    },
  );
  return {
    exitCode,
    ...(finalSessionId !== undefined ? { sessionId: finalSessionId } : {}),
    ...(finalGoal !== undefined ? { goal: finalGoal } : {}),
  };
}

export async function runInteractiveCli(
  cliArgs: RunCliArgs,
  runtime: CliRuntime,
): Promise<number> {
  return await runSessionCli(cliArgs, runtime, { kind: "interactive" });
}
