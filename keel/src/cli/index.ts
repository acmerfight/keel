#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { runAgent } from "../agent/loop.ts";
import { buildAgentSystemPrompt } from "../agent/prompt.ts";
import { defaultStopPolicy } from "../agent/stop-policy.ts";
import type { Message } from "../llm/types.ts";
import {
  type BashMode,
  type BashPermissionPolicy,
  bashModeExposesTool,
} from "../permissions/bash.ts";
import { parseCliArgs, USAGE } from "./args.ts";
import {
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
  persistSessionMessages,
  persistSessionQueuedInput,
  resumeSessionStore,
  type SessionLock,
  type SessionQueuedInput,
  type SessionState,
  SessionStoreError,
} from "./session-store.ts";

interface CliInput extends NodeJS.ReadableStream {
  readonly isTTY?: boolean;
}

export interface CliRuntime {
  readonly args: readonly string[];
  readonly cliEntry: string;
  readonly cwd: () => string;
  readonly env: (key: string) => string | undefined;
  readonly input: CliInput;
  readonly platform: NodeJS.Platform;
  readonly now: () => number;
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

export async function runCliMain(runtime: CliRuntime): Promise<number> {
  let exitCode = 0;
  const parsedCliArgs = parseCliArgs(runtime.args);
  if (!parsedCliArgs.ok) {
    runtime.writeStderr(`${parsedCliArgs.message}\n`);
    return 1;
  }
  const cliArgs = parsedCliArgs.value;

  if (cliArgs.command === "doctor") {
    const { runDoctor } = await import("./doctor.ts");
    const result = await runDoctor();
    runtime.writeStdout(result.stdout);
    runtime.writeStderr(result.stderr);
    return result.exitCode;
  }

  if (cliArgs.command === "eval") {
    const { runEvalCommand } = await import("../eval/run.ts");
    return await runEvalCommand({
      suiteDir: cliArgs.suiteDir,
      outFile: cliArgs.outFile,
      trials: cliArgs.trials,
      ...(cliArgs.taskId !== undefined ? { taskId: cliArgs.taskId } : {}),
      check: cliArgs.check,
      cliEntry: runtime.cliEntry,
    });
  }

  if (cliArgs.command === "undo") {
    const { restoreLastEditCheckpoint } = await import("../core/git.ts");
    const result = restoreLastEditCheckpoint(runtime.cwd());
    switch (result.status) {
      case "restored":
        runtime.writeStdout(`Restored ${result.filePath}\n`);
        return 0;
      case "none":
        runtime.writeStderr(`${result.message}\n`);
        return 1;
      case "blocked":
        runtime.writeStderr(`${result.message}\n`);
        return 1;
    }
  }

  const userMessage = cliArgs.userMessage;
  if (
    userMessage !== undefined &&
    (cliArgs.sessionId !== undefined || cliArgs.resumeSessionId !== undefined)
  ) {
    runtime.writeStderr(
      "Error: --session and --resume are only supported for interactive sessions.\n",
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
    try {
      const workspace = runtime.cwd();
      try {
        const sessionIdForLock = cliArgs.sessionId ?? cliArgs.resumeSessionId;
        if (sessionIdForLock !== undefined) {
          sessionLock = acquireSessionLock({
            sessionId: sessionIdForLock,
            runtime,
          });
        }
        let session: SessionState | undefined;
        let persistedMessages: readonly Message[] = [];
        if (cliArgs.sessionId !== undefined) {
          ensureSessionCanBeCreated({
            sessionId: cliArgs.sessionId,
            runtime,
          });
        } else if (cliArgs.resumeSessionId !== undefined) {
          session = resumeSessionStore({
            sessionId: cliArgs.resumeSessionId,
            workspace,
            runtime,
          });
          persistedMessages = session.messages;
        }
        let sessionPersistence:
          | {
              readonly initialMessages: readonly Message[];
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
            }
          | undefined;
        if (session !== undefined) {
          const resumedSession = session;
          sessionPersistence = {
            initialMessages: resumedSession.messages,
            initialQueuedInputs: resumedSession.pendingInputs,
            persistQueuedInput: (input: {
              readonly sequence: number;
              readonly line: string;
            }) =>
              persistSessionQueuedInput({
                session: resumedSession,
                sequence: input.sequence,
                line: input.line,
                runtime,
              }),
            consumeQueuedInputs: (inputIds: readonly string[]) => {
              consumeSessionQueuedInputs({
                session: resumedSession,
                inputIds,
                runtime,
              });
            },
            persistSessionMessages: (
              messages: readonly Message[],
              reason: SessionPersistenceReason,
              consumedInputIds: readonly string[],
            ) => {
              persistedMessages = persistSessionMessages({
                session: resumedSession,
                previousMessages: persistedMessages,
                currentMessages: messages,
                runtime,
                reason,
                consumedInputIds,
              });
            },
          };
        } else if (cliArgs.sessionId !== undefined) {
          const sessionId = cliArgs.sessionId;
          const ensureActiveSession = (): SessionState => {
            let activeSession = session;
            if (activeSession === undefined) {
              activeSession = createSessionStore({
                sessionId,
                workspace,
                runtime,
              });
              session = activeSession;
              persistedMessages = activeSession.messages;
            }
            return activeSession;
          };
          sessionPersistence = {
            initialMessages: [],
            initialQueuedInputs: [],
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
          };
        }
        const projectInstructions = loadProjectInstructions(workspace);
        const startedAt = runtime.now();
        const interactiveResult = await runInteractiveSession({
          cliArgs,
          workspace,
          platform: runtime.platform,
          ...(projectInstructions !== undefined ? { projectInstructions } : {}),
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
          resolveProvider: (message) =>
            resolveInteractiveProvider(message, runtime, {
              ...(cliArgs.providerId !== undefined
                ? { providerId: cliArgs.providerId }
                : {}),
              ...(cliArgs.model !== undefined ? { model: cliArgs.model } : {}),
            }),
          requireKnownCostModel,
          printAgentEvents: (stream) => printAgentEvents(stream, runtime),
          formatCostReport,
        });
        if (
          cliArgs.reportFile !== undefined &&
          interactiveResult.report !== undefined
        ) {
          writeRunReport(cliArgs.reportFile, {
            provider: interactiveResult.report.provider,
            model: interactiveResult.report.model,
            end: interactiveResult.report.end,
            durationMs: runtime.now() - startedAt,
          });
        }
      } finally {
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
    const resolved = resolveProvider(userMessage, runtime, {
      ...(cliArgs.providerId !== undefined
        ? { providerId: cliArgs.providerId }
        : {}),
      ...(cliArgs.model !== undefined ? { model: cliArgs.model } : {}),
    });
    runtime.onSigint(abort);

    const workspace = runtime.cwd();
    const projectInstructions = loadProjectInstructions(workspace);
    const startedAt = runtime.now();
    const bashPermission = oneShotBashPermissionPolicy(cliArgs.bashMode);
    const stream = runAgent({
      workspace,
      provider: resolved.provider,
      userMessage,
      systemPrompt: buildAgentSystemPrompt({
        workspace,
        platform: runtime.platform,
        ...(projectInstructions !== undefined ? { projectInstructions } : {}),
      }),
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
    });

    const finalEnd = await printAgentEvents(stream, runtime);
    runtime.writeStdout("\n");
    if (cliArgs.maxCostUsd !== undefined && finalEnd?.cost !== undefined) {
      runtime.writeStderr(formatCostReport(finalEnd.cost, cliArgs.maxCostUsd));
    }
    if (cliArgs.reportFile !== undefined && finalEnd !== undefined) {
      assertEndEventHasCost(finalEnd);
      writeRunReport(cliArgs.reportFile, {
        provider: resolved.provider.id,
        model: resolved.model,
        end: finalEnd,
        durationMs: runtime.now() - startedAt,
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
