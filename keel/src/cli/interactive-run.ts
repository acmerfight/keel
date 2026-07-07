import { isAbortThrow } from "../core/error.ts";
import type { Message } from "../llm/types.ts";
import type { BashApprovalGrant } from "../permissions/bash.ts";
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
import { writeRunReport } from "./report.ts";
import { createAgentEventReportRecorder } from "./report-events.ts";
import { resolveResumedWorkflowSkill } from "./resumed-workflow-skill.ts";
import type { CliRuntime } from "./runtime.ts";
import { formatCliRuntimeError } from "./runtime-error.ts";
import { formatSessionForkCreated } from "./session-catalog-format.ts";
import {
  acquireSessionLock,
  consumeSessionQueuedInputs,
  createSessionStore,
  ensureSessionCanBeCreated,
  forkSessionStore,
  persistSessionBashApprovalGrant,
  persistSessionBashApprovalRevoked,
  persistSessionBashApprovalsCleared,
  persistSessionMessages,
  persistSessionModelSwitch,
  persistSessionQueuedInput,
  persistSessionTaskProgress,
  resumeSessionStore,
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
import { loadWorkflowSkill, WorkflowSkillError } from "./workflow-skills.ts";

type RunCliArgs = Extract<CliArgs, { readonly command: "run" }>;

export async function runInteractiveCli(
  cliArgs: RunCliArgs,
  runtime: CliRuntime,
): Promise<number> {
  let exitCode = 0;

  if (
    runtime.input.isTTY !== true &&
    runtime.env("KEEL_FORCE_INTERACTIVE") !== "1"
  ) {
    runtime.writeStderr(`${USAGE}\n`);
    return 1;
  }
  if (cliArgs.bashMode === "ask" && runtime.input.isTTY !== true) {
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
      cliArgs.bashMode === "ask"
        ? (() => {
            const projectRoot = bashApprovalProjectRoot(workspace);
            return {
              projectRoot,
              grants: listBashProjectApprovalGrants(runtime, projectRoot),
            };
          })()
        : undefined;
    try {
      if (
        cliArgs.forkSessionId !== undefined &&
        cliArgs.resumeSessionId !== undefined
      ) {
        sourceSessionLock = acquireSessionLock({
          sessionId: cliArgs.resumeSessionId,
          runtime,
        });
      }
      const sessionIdForLock =
        cliArgs.sessionId ?? cliArgs.forkSessionId ?? cliArgs.resumeSessionId;
      if (sessionIdForLock !== undefined) {
        sessionLock = acquireSessionLock({
          sessionId: sessionIdForLock,
          runtime,
        });
      }
      let session: SessionState | undefined;
      let activeSessionId: string | undefined;
      let persistedMessages: readonly Message[] = [];
      let initialModelSelection: SessionModelSelection | undefined;
      let workflowSkill =
        cliArgs.resumeSessionId === undefined && cliArgs.skillName !== undefined
          ? loadWorkflowSkill(workspace, cliArgs.skillName)
          : undefined;
      if (cliArgs.sessionId !== undefined) {
        activeSessionId = cliArgs.sessionId;
        ensureSessionCanBeCreated({
          sessionId: cliArgs.sessionId,
          runtime,
        });
      } else if (cliArgs.resumeSessionId !== undefined) {
        const resumedSession = resumeSessionStore({
          sessionId: cliArgs.resumeSessionId,
          workspace,
          runtime,
        });
        const resumedWorkflowSkill = resolveResumedWorkflowSkill({
          session: resumedSession,
          ...(cliArgs.skillName !== undefined
            ? { requestedSkillName: cliArgs.skillName }
            : {}),
        });
        if (cliArgs.forkSessionId !== undefined) {
          ensureSessionCanBeCreated({
            sessionId: cliArgs.forkSessionId,
            runtime,
          });
          session = forkSessionStore({
            source: resumedSession,
            targetSessionId: cliArgs.forkSessionId,
            ...(cliArgs.forkBeforeMessage !== undefined
              ? {
                  forkPoint: {
                    beforeMessageId: cliArgs.forkBeforeMessage,
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
        sessionPersistence = {
          initialMessages: initialSession?.messages ?? [],
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
      const interactiveDisplay =
        runtime.input.isTTY === true
          ? createStableInteractiveDisplay(runtime, {
              inputEchoesToDisplay: runtime.stderrIsTTY === true,
            })
          : undefined;
      const reportRecorder = createAgentEventReportRecorder();
      interactiveDisplay?.writeIntro();
      const interactiveResult = await runInteractiveSession({
        cliArgs,
        workspace,
        platform: runtime.platform,
        ...(activeSessionId !== undefined
          ? { sessionId: activeSessionId }
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
        onSigint: (handler) => {
          runtime.onSigint(handler);
        },
        offSigint: (handler) => {
          runtime.offSigint(handler);
        },
        setExitCode: (code) => {
          exitCode = code;
        },
        forceExit: runtime.forceExit,
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
      });
      if (
        cliArgs.reportFile !== undefined &&
        interactiveResult.report !== undefined
      ) {
        writeRunReport(cliArgs.reportFile, {
          usageByModel: interactiveResult.report.usageByModel,
          end: interactiveResult.report.end,
          durationMs: runtime.now() - startedAt,
          contextCompactions: reportRecorder.contextCompactions(),
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
