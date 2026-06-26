#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { runAgent } from "../agent/loop.ts";
import { buildAgentSystemPrompt, type WorkflowSkill } from "../agent/prompt.ts";
import { defaultStopPolicy } from "../agent/stop-policy.ts";
import type { Message } from "../llm/types.ts";
import {
  type BashApprovalGrant,
  type BashMode,
  type BashPermissionPolicy,
  bashModeExposesTool,
} from "../permissions/bash.ts";
import { parseCliArgs, USAGE } from "./args.ts";
import {
  formatExternalSessionForkPoints,
  sessionForkPointsFromStoredMessages,
} from "./fork-points.ts";
import {
  type InteractiveForkSessionRequest,
  runInteractiveSession,
  type SessionPersistenceReason,
} from "./interactive-session.ts";
import { formatCostReport, printAgentEvents } from "./output.ts";
import {
  loadProjectInstructions,
  ProjectInstructionsError,
} from "./project-instructions.ts";
import {
  ProviderConfigError,
  requireKnownCostModel,
  resolveInteractiveProvider,
  resolveProvider,
} from "./provider-config.ts";
import { assertEndEventHasCost, writeRunReport } from "./report.ts";
import {
  acquireSessionLock,
  consumeSessionQueuedInputs,
  createSessionStore,
  ensureSessionCanBeCreated,
  forkSessionStore,
  listSessionCatalog,
  persistSessionBashApprovalGrant,
  persistSessionMessages,
  persistSessionModelSwitch,
  persistSessionQueuedInput,
  resumeSessionStore,
  type SessionCatalog,
  type SessionCatalogEntry,
  type SessionCatalogWarning,
  type SessionForkPointRecord,
  type SessionForkPolicyRecord,
  type SessionLock,
  type SessionModelSelection,
  type SessionQueuedInput,
  type SessionState,
  SessionStoreError,
  type SessionStoreRuntime,
  sessionStoredMessages,
} from "./session-store.ts";
import { writeRunTranscript } from "./transcript.ts";
import {
  formatWorkflowSkillList,
  formatWorkflowSkillListWarnings,
  listWorkflowSkills,
  loadWorkflowSkill,
  WorkflowSkillError,
} from "./workflow-skills.ts";

interface CliInput extends NodeJS.ReadableStream {
  readonly isTTY?: boolean;
}

export interface CliRuntime extends SessionStoreRuntime {
  readonly args: readonly string[];
  readonly cliEntry: string;
  readonly cwd: () => string;
  readonly input: CliInput;
  readonly platform: NodeJS.Platform;
  readonly writeStdout: (text: string) => void;
  readonly writeStderr: (text: string) => void;
  readonly onSigint: (handler: () => void) => void;
  readonly offSigint: (handler: () => void) => void;
  readonly forceExit: (code: number) => never;
}

function oneShotBashPermissionPolicy(
  bashMode: BashMode,
): BashPermissionPolicy | undefined {
  if (bashMode === "ask") {
    return {
      review: () => ({
        type: "deny",
        message:
          "Shell command requires interactive approval; one-shot runs cannot approve bash commands.",
      }),
    };
  }
  return undefined;
}

function sessionCatalogEntryLines(
  entry: SessionCatalogEntry,
  depth: number,
): readonly string[] {
  const indent = "  ".repeat(depth);
  const detailIndent = `${indent}   `;
  return [
    `${indent}${entry.id}  updated ${entry.updatedAt}`,
    `${detailIndent}branch: ${entry.graph.branchTitle}`,
    ...(entry.graph.parentSessionId !== null
      ? [`${detailIndent}parent: ${entry.graph.parentSessionId}`]
      : []),
    ...(entry.graph.forkPoint !== null
      ? [
          `${detailIndent}fork point: ${formatSessionForkPoint(entry.graph.forkPoint)}`,
        ]
      : []),
    ...(entry.graph.parentSessionId !== null
      ? [
          `${detailIndent}fork policy: ${formatSessionForkPolicy(entry.graph.forkPolicy)}`,
        ]
      : []),
    `${detailIndent}preview: ${entry.preview}`,
    `${detailIndent}resume: keel --resume ${entry.id}`,
    `${detailIndent}fork-points: keel --resume ${entry.id} --fork-points`,
    `${detailIndent}fork: keel sessions fork ${entry.id} <new-id>`,
  ];
}

function formatSessionForkPoint(forkPoint: SessionForkPointRecord): string {
  switch (forkPoint.kind) {
    case "before_message":
      return `before message ${forkPoint.sourceMessageId} (message ${forkPoint.sourceOrdinal}): ${forkPoint.preview}`;
    case "end":
      return forkPoint.sourceLastMessageId === null
        ? `full restored history from ${forkPoint.sourceSessionId} (0 messages)`
        : `full restored history from ${forkPoint.sourceSessionId} through message ${forkPoint.sourceLastMessageId} (message ${forkPoint.sourceOrdinal})`;
  }
}

function formatSessionForkPolicy(policy: SessionForkPolicyRecord): string {
  return `transcript=${policy.transcript}, pendingInputs=${policy.pendingInputs}, queuedInputs=${policy.queuedInputs}, bashApprovalGrants=${policy.bashApprovalGrants}`;
}

interface ResumedWorkflowSkillOptions {
  readonly session: SessionState;
  readonly requestedSkillName?: string;
}

function ensureResumedWorkflowSkillMatchesRequest(
  options: ResumedWorkflowSkillOptions,
): void {
  const workflowSkill = options.session.workflowSkill;
  if (options.requestedSkillName === undefined) {
    return;
  }
  if (workflowSkill === undefined) {
    throw new SessionStoreError(
      `Error: session "${options.session.id}" has no workflow skill; cannot resume it with workflow skill "${options.requestedSkillName}".`,
    );
  }
  if (workflowSkill.name !== options.requestedSkillName) {
    throw new SessionStoreError(
      `Error: session "${options.session.id}" already uses workflow skill "${workflowSkill.name}"; cannot resume it with workflow skill "${options.requestedSkillName}".`,
    );
  }
}

function resolveResumedWorkflowSkill(
  options: ResumedWorkflowSkillOptions,
): WorkflowSkill | undefined {
  ensureResumedWorkflowSkillMatchesRequest(options);
  return options.session.workflowSkill;
}

interface SessionCatalogGraphGroup {
  readonly graphId: string;
  readonly rootSessionId: string;
  readonly updatedAt: string;
  readonly entries: readonly SessionCatalogEntry[];
}

function compareSessionCatalogGraphGroups(
  left: SessionCatalogGraphGroup,
  right: SessionCatalogGraphGroup,
): number {
  const timestampDelta = right.updatedAt.localeCompare(left.updatedAt);
  if (timestampDelta !== 0) {
    return timestampDelta;
  }
  return left.graphId.localeCompare(right.graphId);
}

function sessionCatalogGraphGroups(
  entries: readonly SessionCatalogEntry[],
): readonly SessionCatalogGraphGroup[] {
  const groupsById = new Map<string, SessionCatalogGraphGroup>();
  for (const entry of [...entries].sort(
    compareSessionCatalogEntriesForFormat,
  )) {
    const group = groupsById.get(entry.graph.graphId);
    if (group === undefined) {
      groupsById.set(entry.graph.graphId, {
        graphId: entry.graph.graphId,
        rootSessionId: entry.graph.rootSessionId,
        updatedAt: entry.updatedAt,
        entries: [entry],
      });
      continue;
    }
    groupsById.set(entry.graph.graphId, {
      graphId: group.graphId,
      rootSessionId: group.rootSessionId,
      updatedAt: group.updatedAt,
      entries: [...group.entries, entry],
    });
  }

  return [...groupsById.values()].sort(compareSessionCatalogGraphGroups);
}

function sessionCatalogTreeLines(
  entries: readonly SessionCatalogEntry[],
): readonly string[] {
  const entryIds = new Set(entries.map((entry) => entry.id));
  const childrenByParent = new Map<string, SessionCatalogEntry[]>();
  const roots: SessionCatalogEntry[] = [];
  for (const entry of entries) {
    const parentSessionId = entry.graph.parentSessionId;
    if (parentSessionId === null || !entryIds.has(parentSessionId)) {
      roots.push(entry);
      continue;
    }
    const children = childrenByParent.get(parentSessionId) ?? [];
    children.push(entry);
    childrenByParent.set(parentSessionId, children);
  }

  const lines: string[] = [];
  const appendEntry = (entry: SessionCatalogEntry, depth: number): void => {
    lines.push(...sessionCatalogEntryLines(entry, depth));
    for (const child of (childrenByParent.get(entry.id) ?? []).sort(
      compareSessionCatalogEntriesForFormat,
    )) {
      appendEntry(child, depth + 1);
    }
  };
  for (const root of roots.sort(compareSessionCatalogEntriesForFormat)) {
    appendEntry(root, 0);
  }
  return lines;
}

function compareSessionCatalogEntriesForFormat(
  left: SessionCatalogEntry,
  right: SessionCatalogEntry,
): number {
  const timestampDelta = right.updatedAt.localeCompare(left.updatedAt);
  if (timestampDelta !== 0) {
    return timestampDelta;
  }
  return left.id.localeCompare(right.id);
}

function formatSessionCatalog(catalog: SessionCatalog): string {
  if (catalog.sessions.length === 0) {
    return `No sessions for workspace ${catalog.workspace}.\n`;
  }
  const lines = [`Sessions for workspace ${catalog.workspace}:`];
  for (const group of sessionCatalogGraphGroups(catalog.sessions)) {
    lines.push(
      `graph ${group.graphId} root ${group.rootSessionId}  updated ${group.updatedAt}`,
    );
    lines.push(...sessionCatalogTreeLines(group.entries));
  }
  return `${lines.join("\n")}\n`;
}

function formatSessionCatalogWarnings(
  warnings: readonly SessionCatalogWarning[],
): string {
  return warnings
    .map(
      (warning) =>
        `Warning: skipped session "${warning.sessionId}": ${warning.message}\n`,
    )
    .join("");
}

function formatSessionForkCreated(options: {
  readonly sourceSessionId: string;
  readonly targetSessionId: string;
  readonly forkBeforeMessage?: string;
}): string {
  const forkLine =
    options.forkBeforeMessage === undefined
      ? `Forked session "${options.sourceSessionId}" to "${options.targetSessionId}".`
      : `Forked session "${options.sourceSessionId}" to "${options.targetSessionId}" before message ${options.forkBeforeMessage}.`;
  return `${forkLine}\nresume: keel --resume ${options.targetSessionId}\n`;
}

export async function runCliMain(runtime: CliRuntime): Promise<number> {
  let exitCode = 0;
  const parsedCliArgs = parseCliArgs(runtime.args);
  if (!parsedCliArgs.ok) {
    runtime.writeStderr(`${parsedCliArgs.message}\n`);
    return 1;
  }
  const cliArgs = parsedCliArgs.value;

  if (cliArgs.command === "doctor") {
    const {
      readBundledRipgrepDiagnostic,
      readProviderModelsDiagnostic,
      runDoctor,
    } = await import("./doctor.ts");
    const result = await runDoctor({
      runtime,
      readRipgrepDiagnostic: readBundledRipgrepDiagnostic,
      readProviderOnlineDiagnostic: readProviderModelsDiagnostic,
      onlineMode: cliArgs.offline ? "offline" : "online",
      selection: {
        ...(cliArgs.providerId !== undefined
          ? { providerId: cliArgs.providerId }
          : {}),
        ...(cliArgs.model !== undefined ? { model: cliArgs.model } : {}),
      },
    });
    runtime.writeStdout(result.stdout);
    runtime.writeStderr(result.stderr);
    return result.exitCode;
  }

  if (cliArgs.command === "eval") {
    if (cliArgs.mode === "compare") {
      const { runEvalCompareCommand } = await import("../eval/compare.ts");
      return runEvalCompareCommand({
        baseFile: cliArgs.baseFile,
        headFile: cliArgs.headFile,
      });
    }

    const { runEvalCommand } = await import("../eval/run.ts");
    return await runEvalCommand({
      suiteDir: cliArgs.suiteDir,
      outFile: cliArgs.outFile,
      ...(cliArgs.transcriptDir !== undefined
        ? { transcriptDir: cliArgs.transcriptDir }
        : {}),
      trials: cliArgs.trials,
      ...(cliArgs.taskId !== undefined ? { taskId: cliArgs.taskId } : {}),
      ...(cliArgs.providerId !== undefined
        ? { providerId: cliArgs.providerId }
        : {}),
      ...(cliArgs.model !== undefined ? { model: cliArgs.model } : {}),
      check: cliArgs.check,
      cliEntry: runtime.cliEntry,
    });
  }

  if (cliArgs.command === "undo") {
    const { restoreLastEditCheckpoint } = await import("../core/git.ts");
    const result = restoreLastEditCheckpoint(runtime.cwd());
    switch (result.status) {
      case "restored":
        runtime.writeStdout(`Restored ${result.restoredLabel}\n`);
        return 0;
      case "none":
        runtime.writeStderr(`${result.message}\n`);
        return 1;
      case "blocked":
        runtime.writeStderr(`${result.message}\n`);
        return 1;
    }
  }

  if (cliArgs.command === "skills") {
    try {
      const result = listWorkflowSkills(runtime.cwd());
      runtime.writeStdout(formatWorkflowSkillList(result.skills));
      const warningText = formatWorkflowSkillListWarnings(result.warnings);
      if (warningText !== "") {
        runtime.writeStderr(warningText);
      }
      return 0;
    } catch (error) {
      /* v8 ignore next 3: unexpected workflow skill listing failures are allowed to escape. */
      if (!(error instanceof WorkflowSkillError)) {
        throw error;
      }
      runtime.writeStderr(`${error.message}\n`);
      return 1;
    }
  }

  if (cliArgs.command === "sessions") {
    if (cliArgs.mode === "fork") {
      let sourceSessionLock: SessionLock | undefined;
      let targetSessionLock: SessionLock | undefined;
      try {
        sourceSessionLock = acquireSessionLock({
          sessionId: cliArgs.sourceSessionId,
          runtime,
        });
        targetSessionLock = acquireSessionLock({
          sessionId: cliArgs.targetSessionId,
          runtime,
        });
        ensureSessionCanBeCreated({
          sessionId: cliArgs.targetSessionId,
          runtime,
        });
        const source = resumeSessionStore({
          sessionId: cliArgs.sourceSessionId,
          workspace: runtime.cwd(),
          runtime,
        });
        forkSessionStore({
          source,
          targetSessionId: cliArgs.targetSessionId,
          ...(cliArgs.forkBeforeMessage !== undefined
            ? {
                forkPoint: {
                  beforeMessageId: cliArgs.forkBeforeMessage,
                  optionName: "--before-message",
                },
              }
            : {}),
          runtime,
        });
        runtime.writeStdout(formatSessionForkCreated(cliArgs));
        return 0;
      } catch (error) {
        /* v8 ignore next 3: session fork command converts supported failures to SessionStoreError. */
        if (!(error instanceof SessionStoreError)) {
          throw error;
        }
        runtime.writeStderr(`${error.message}\n`);
        return 1;
      } finally {
        targetSessionLock?.release();
        sourceSessionLock?.release();
      }
    }

    try {
      const catalog = listSessionCatalog({
        workspace: runtime.cwd(),
        runtime,
      });
      runtime.writeStdout(formatSessionCatalog(catalog));
      runtime.writeStderr(formatSessionCatalogWarnings(catalog.warnings));
      return 0;
    } catch (error) {
      /* v8 ignore next 3: listSessionCatalog converts supported catalog failures to SessionStoreError. */
      if (!(error instanceof SessionStoreError)) {
        throw error;
      }
      runtime.writeStderr(`${error.message}\n`);
      return 1;
    }
  }

  const userMessage = cliArgs.userMessage;
  if (cliArgs.forkPoints && cliArgs.resumeSessionId !== undefined) {
    try {
      const session = resumeSessionStore({
        sessionId: cliArgs.resumeSessionId,
        workspace: runtime.cwd(),
        runtime,
      });
      ensureResumedWorkflowSkillMatchesRequest({
        session,
        ...(cliArgs.skillName !== undefined
          ? { requestedSkillName: cliArgs.skillName }
          : {}),
      });
      runtime.writeStdout(
        formatExternalSessionForkPoints(
          sessionForkPointsFromStoredMessages({
            sessionId: session.id,
            storedMessages: session.storedMessages,
          }),
        ),
      );
      return 0;
    } catch (error) {
      /* v8 ignore next 3: resumeSessionStore reports supported fork-point failures as SessionStoreError. */
      if (!(error instanceof SessionStoreError)) {
        throw error;
      }
      runtime.writeStderr(`${error.message}\n`);
      return 1;
    }
  }
  if (
    userMessage !== undefined &&
    (cliArgs.sessionId !== undefined || cliArgs.resumeSessionId !== undefined)
  ) {
    runtime.writeStderr(
      "Error: --session and --resume are only supported for interactive sessions.\n",
    );
    return 1;
  }
  if (!userMessage && cliArgs.transcriptFile !== undefined) {
    runtime.writeStderr(
      "Error: --transcript is only supported for one-shot runs.\n",
    );
    return 1;
  }
  if (!userMessage) {
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
          cliArgs.resumeSessionId === undefined &&
          cliArgs.skillName !== undefined
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
              runtime.writeStdout(
                `Model overridden to ${overrideSelection.providerId}/${overrideSelection.model} for resumed session.\n`,
              );
            }
            initialModelSelection = overrideSelection;
          }
        }
        let sessionPersistence:
          | {
              readonly initialMessages: readonly Message[];
              readonly initialModelSelection?: SessionModelSelection;
              readonly initialQueuedInputs: readonly SessionQueuedInput[];
              readonly persistQueuedInput: (input: {
                readonly sequence: number;
                readonly line: string;
              }) => SessionQueuedInput;
              readonly consumeQueuedInputs: (
                inputIds: readonly string[],
              ) => void;
              readonly persistSessionMessages: (
                messages: readonly Message[],
                reason: SessionPersistenceReason,
                consumedInputIds: readonly string[],
              ) => void;
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
            ...(initialModelSelection !== undefined
              ? { initialModelSelection }
              : {}),
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
          };
        }
        const projectInstructions = loadProjectInstructions(workspace);
        const startedAt = runtime.now();
        const interactiveResult = await runInteractiveSession({
          cliArgs,
          workspace,
          platform: runtime.platform,
          ...(projectInstructions !== undefined ? { projectInstructions } : {}),
          ...(workflowSkill !== undefined ? { workflowSkill } : {}),
          ...(sessionPersistence !== undefined ? sessionPersistence : {}),
          input: runtime.input,
          writeStdout: (text) => {
            runtime.writeStdout(text);
          },
          writeStderr: (text) => {
            runtime.writeStderr(text);
          },
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
                ...(cliArgs.model !== undefined
                  ? { model: cliArgs.model }
                  : {}),
              },
            ),
          requireKnownCostModel,
          printAgentEvents: (stream) => printAgentEvents(stream, runtime),
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
      /* v8 ignore next 3: unexpected interactive runtime failures are allowed to escape. */
      if (!(error instanceof SessionStoreError)) {
        throw error;
      }
      runtime.writeStderr(`${error.message}\n`);
      return 1;
    }
    return exitCode;
  }

  const abortController = new AbortController();
  const abort = () => {
    abortController.abort();
  };
  try {
    const workspace = runtime.cwd();
    const projectInstructions = loadProjectInstructions(workspace);
    const workflowSkill =
      cliArgs.skillName === undefined
        ? undefined
        : loadWorkflowSkill(workspace, cliArgs.skillName);
    const resolved = resolveProvider(userMessage, runtime, {
      ...(cliArgs.providerId !== undefined
        ? { providerId: cliArgs.providerId }
        : {}),
      ...(cliArgs.model !== undefined ? { model: cliArgs.model } : {}),
    });
    runtime.onSigint(abort);

    const startedAt = runtime.now();
    const bashPermission = oneShotBashPermissionPolicy(cliArgs.bashMode);
    const systemPrompt = buildAgentSystemPrompt({
      workspace,
      platform: runtime.platform,
      ...(projectInstructions !== undefined ? { projectInstructions } : {}),
      ...(workflowSkill !== undefined ? { workflowSkill } : {}),
    });
    let transcriptMessages: readonly Message[] | undefined;
    const stream = runAgent({
      workspace,
      provider: resolved.provider,
      userMessage,
      systemPrompt,
      signal: abortController.signal,
      allowBash: bashModeExposesTool(cliArgs.bashMode),
      stopPolicy: defaultStopPolicy(),
      ...(bashPermission !== undefined ? { bashPermission } : {}),
      ...(cliArgs.maxCostUsd !== undefined || cliArgs.reportFile !== undefined
        ? {
            costTracking: {
              model: requireKnownCostModel(resolved),
              ...(cliArgs.maxCostUsd !== undefined
                ? { maxCostUsd: cliArgs.maxCostUsd }
                : {}),
            },
          }
        : {}),
      ...(resolved.contextCompaction !== undefined
        ? { contextCompaction: resolved.contextCompaction }
        : {}),
      ...(cliArgs.transcriptFile !== undefined
        ? {
            onTranscriptReady: (messages) => {
              transcriptMessages = messages;
            },
          }
        : {}),
    });

    const finalEnd = await printAgentEvents(stream, runtime);
    runtime.writeStdout("\n");
    if (cliArgs.maxCostUsd !== undefined && finalEnd?.cost !== undefined) {
      runtime.writeStderr(formatCostReport(finalEnd.cost, cliArgs.maxCostUsd));
    }
    if (cliArgs.reportFile !== undefined && finalEnd !== undefined) {
      assertEndEventHasCost(finalEnd);
      writeRunReport(cliArgs.reportFile, {
        usageByModel: [
          {
            provider: resolved.provider.id,
            model: resolved.model,
            turns: finalEnd.turns,
            usage: finalEnd.usage,
            costUsd: finalEnd.cost.spentUsd,
          },
        ],
        end: finalEnd,
        durationMs: runtime.now() - startedAt,
      });
    }
    if (
      cliArgs.transcriptFile !== undefined &&
      transcriptMessages !== undefined
    ) {
      writeRunTranscript(cliArgs.transcriptFile, {
        provider: resolved.provider.id,
        model: resolved.model,
        systemPrompt,
        messages: transcriptMessages,
      });
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
    /* v8 ignore next 4: unexpected runtime failures are allowed to escape. */
    if (!abortController.signal.aborted) {
      throw error;
    }
    runtime.writeStdout("\n");
    return 130;
  } finally {
    runtime.offSigint(abort);
  }
  return 0;
}

/* v8 ignore start: real process adapter is exercised by CLI subprocess tests. */
function defaultRuntime(): CliRuntime {
  return {
    args: process.argv.slice(2),
    cliEntry: import.meta.filename,
    cwd: () => process.cwd(),
    env: (key) => process.env[key],
    input: process.stdin,
    platform: process.platform,
    now: () => Date.now(),
    writeStdout: (text) => {
      process.stdout.write(text);
    },
    writeStderr: (text) => {
      process.stderr.write(text);
    },
    onSigint: (handler) => {
      process.on("SIGINT", handler);
    },
    offSigint: (handler) => {
      process.off("SIGINT", handler);
    },
    forceExit: (code) => process.exit(code),
  };
}

export async function main(): Promise<void> {
  process.exitCode = await runCliMain(defaultRuntime());
}

// process.argv[1] keeps the launch path; npm/pnpm install bins as symlinks,
// so resolve to the real path before comparing against the resolved module URL.
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  await main();
}
/* v8 ignore stop */
