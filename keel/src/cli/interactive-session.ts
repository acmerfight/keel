import { createInterface } from "node:readline/promises";
import {
  type ContextCompactionOptions,
  compactMessages,
} from "../agent/context-compaction.ts";
import type { AgentEvent, CostReport } from "../agent/loop.ts";
import { runAgentTurn } from "../agent/loop.ts";
import {
  buildAgentSystemPrompt,
  type ProjectInstructions,
} from "../agent/prompt.ts";
import { defaultStopPolicy } from "../agent/stop-policy.ts";
import { type CostModel, calculateRequestCostBatchUsd } from "../core/cost.ts";
import type { LLMProvider, Message, Usage } from "../llm/types.ts";
import {
  type BashMode,
  type BashPermissionPolicy,
  bashModeExposesTool,
  createSessionBashPermissionPolicy,
} from "../permissions/bash.ts";
import {
  formatContextCompactionReport,
  sanitizeStatusLineText,
} from "./output.ts";

type EndEvent = Extract<AgentEvent, { readonly type: "end" }>;
type EndEventWithCost = EndEvent & { readonly cost: CostReport };
export type ProviderId = "fake" | "deepseek" | "kimi" | "qwen";

interface InteractiveSessionArgs {
  readonly bashMode: BashMode;
  readonly maxCostUsd?: number;
  readonly reportFile?: string;
}

export type SessionPersistenceReason = "turn" | "compaction";

interface InteractiveResolvedProviderBase {
  readonly provider: LLMProvider;
  readonly model: string;
  readonly contextCompaction?: ContextCompactionOptions;
}

export type InteractiveResolvedProvider =
  | (InteractiveResolvedProviderBase & {
      readonly providerId: "fake";
      readonly costModel: CostModel;
    })
  | (InteractiveResolvedProviderBase & {
      readonly providerId: "deepseek";
      readonly costModel: CostModel | null;
    })
  | (InteractiveResolvedProviderBase & {
      readonly providerId: "kimi";
      readonly costModel: CostModel | null;
    })
  | (InteractiveResolvedProviderBase & {
      readonly providerId: "qwen";
      readonly costModel: CostModel | null;
    });

export interface InteractiveSessionOptions {
  readonly cliArgs: InteractiveSessionArgs;
  readonly workspace: string;
  readonly platform: NodeJS.Platform;
  readonly projectInstructions?: ProjectInstructions;
  readonly initialMessages?: readonly Message[];
  readonly persistSessionMessages?: (
    messages: readonly Message[],
    reason: SessionPersistenceReason,
  ) => void;
  readonly input: NodeJS.ReadableStream;
  readonly writeStdout: (text: string) => void;
  readonly writeStderr: (text: string) => void;
  readonly onSigint: (handler: () => void) => void;
  readonly offSigint: (handler: () => void) => void;
  readonly setExitCode: (code: number) => void;
  readonly forceExit: (code: number) => never;
  readonly resolveProvider: (
    userMessage: string,
  ) => InteractiveResolvedProvider;
  readonly requireKnownCostModel: (
    resolved: InteractiveResolvedProvider,
  ) => CostModel;
  readonly printAgentEvents: (
    stream: AsyncIterable<AgentEvent>,
  ) => Promise<EndEvent | undefined>;
  readonly formatCostReport: (cost: CostReport, maxUsd: number) => string;
}

export interface InteractiveSessionResult {
  readonly report?: {
    readonly provider: ProviderId;
    readonly model: string;
    readonly end: EndEventWithCost;
  };
}

interface LineReader {
  readonly readLine: () => Promise<string | null>;
  readonly readLineAfter: (
    sequence: number,
    signal: AbortSignal,
  ) => Promise<string | null>;
  readonly drainLinesAfter: (sequence: number) => readonly QueuedLine[];
  readonly restoreLines: (lines: readonly QueuedLine[]) => void;
  readonly sequence: () => number;
}

interface QueuedLine {
  readonly sequence: number;
  readonly line: string;
}

interface LineWaiter {
  readonly after: number;
  readonly resolve: (line: string | null) => void;
}

interface ManualCompactCommand {
  readonly focusInstruction?: string;
}

function parseManualCompactCommand(
  userMessage: string,
): ManualCompactCommand | null {
  const match = /^\/compact(?:\s+(.*))?$/u.exec(userMessage.trim());
  if (match === null) {
    return null;
  }
  const focusInstruction = match[1]?.trim();
  if (focusInstruction === undefined || focusInstruction === "") {
    return {};
  }
  return { focusInstruction };
}

function formatManualCompactionFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Context compaction failed: ${sanitizeStatusLineText(message)}\n`;
}

interface ManualCompactContext {
  readonly command: ManualCompactCommand;
  readonly resolved: InteractiveResolvedProvider;
  readonly messages: Message[];
  readonly systemPrompt: string;
  readonly signal: AbortSignal;
  readonly options: InteractiveSessionOptions;
  readonly recordCompactionCost: (
    usage: Usage,
    costModel: CostModel,
  ) => CostReport;
}

async function executeManualCompaction(
  ctx: ManualCompactContext,
): Promise<CostReport | undefined> {
  const {
    command,
    resolved,
    messages,
    systemPrompt,
    signal,
    options,
    recordCompactionCost,
  } = ctx;
  const manualCostModel = !shouldTrackInteractiveCost(options.cliArgs)
    ? undefined
    : options.requireKnownCostModel(resolved);
  const messagesBeforeCompact = messages.slice();

  try {
    const result = await compactMessages({
      provider: resolved.provider,
      systemPrompt,
      messages,
      signal,
      ...(resolved.contextCompaction !== undefined
        ? { contextCompaction: resolved.contextCompaction }
        : {}),
      ...(command.focusInstruction !== undefined
        ? { focusInstruction: command.focusInstruction }
        : {}),
    });
    if (signal.aborted) {
      messages.splice(0, messages.length, ...messagesBeforeCompact);
      options.writeStdout("\n");
      return undefined;
    }
    if (result.compacted && result.stats !== undefined) {
      options.writeStderr(
        formatContextCompactionReport({
          ...result.stats,
          reasonLabel: "manual",
        }),
      );
      if (manualCostModel !== undefined) {
        const cost = recordCompactionCost(result.usage, manualCostModel);
        if (options.cliArgs.maxCostUsd !== undefined) {
          options.writeStderr(
            options.formatCostReport(cost, options.cliArgs.maxCostUsd),
          );
        }
        return cost;
      }
    } else {
      options.writeStderr(
        "Context compaction skipped: no safe history to compact.\n",
      );
    }
    return undefined;
  } catch (error) {
    messages.splice(0, messages.length, ...messagesBeforeCompact);
    if (signal.aborted) {
      options.writeStdout("\n");
      return undefined;
    }
    options.writeStderr(formatManualCompactionFailure(error));
    return undefined;
  }
}

const EMPTY_USAGE: Usage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  uncachedInputTokens: 0,
  outputTokens: 0,
};

function addUsage(left: Usage, right: Usage): Usage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    uncachedInputTokens: left.uncachedInputTokens + right.uncachedInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
  };
}

function shouldTrackInteractiveCost(args: InteractiveSessionArgs): boolean {
  return args.maxCostUsd !== undefined || args.reportFile !== undefined;
}

function buildSessionCostReport(
  spentUsd: number,
  maxCostUsd: number | undefined,
): CostReport {
  return {
    spentUsd,
    ...(maxCostUsd !== undefined ? { maxUsd: maxCostUsd } : {}),
    budgetExceeded: maxCostUsd !== undefined && spentUsd > maxCostUsd,
  };
}

function createLineReader(
  input: ReturnType<typeof createInterface>,
): LineReader {
  const queued: QueuedLine[] = [];
  const waiters: Array<(line: string | null) => void> = [];
  const freshWaiters: LineWaiter[] = [];
  let closed = false;
  let currentSequence = 0;

  // Approval answers must be typed after the approval prompt appears. The
  // sequence lets approval waits ignore already-queued user messages.
  input.on("line", (line) => {
    currentSequence++;
    const queuedLine = { sequence: currentSequence, line };
    const freshWaiterIndex = freshWaiters.findIndex(
      (waiter) => queuedLine.sequence > waiter.after,
    );
    if (freshWaiterIndex >= 0) {
      const freshWaiter = freshWaiters[freshWaiterIndex];
      freshWaiters.splice(freshWaiterIndex, 1);
      freshWaiter?.resolve(queuedLine.line);
      return;
    }

    const waiter = waiters.shift();
    if (waiter !== undefined) {
      waiter(line);
      return;
    }
    queued.push(queuedLine);
  });

  input.once("close", () => {
    closed = true;
    for (;;) {
      const waiter = waiters.shift();
      if (waiter === undefined) break;
      waiter(null);
    }
    for (;;) {
      const waiter = freshWaiters.shift();
      if (waiter === undefined) return;
      waiter.resolve(null);
    }
  });

  return {
    readLine: () => {
      const queuedLine = queued.shift();
      if (queuedLine !== undefined) {
        return Promise.resolve(queuedLine.line);
      }
      if (closed) {
        return Promise.resolve(null);
      }
      return new Promise((resolve) => {
        waiters.push(resolve);
      });
    },
    readLineAfter: (sequence, signal) => {
      const queuedIndex = queued.findIndex((line) => line.sequence > sequence);
      if (queuedIndex >= 0) {
        const queuedLine = queued[queuedIndex];
        queued.splice(queuedIndex, 1);
        return Promise.resolve(queuedLine?.line ?? null);
      }
      if (closed) {
        return Promise.resolve(null);
      }
      return new Promise((resolve) => {
        if (signal.aborted) {
          resolve(null);
          return;
        }
        let waiter: LineWaiter;
        const onAbort = () => {
          const index = freshWaiters.indexOf(waiter);
          if (index >= 0) {
            freshWaiters.splice(index, 1);
          }
          resolve(null);
        };
        waiter = {
          after: sequence,
          resolve: (line) => {
            signal.removeEventListener("abort", onAbort);
            resolve(line);
          },
        };
        signal.addEventListener("abort", onAbort, { once: true });
        freshWaiters.push(waiter);
      });
    },
    drainLinesAfter: (sequence) => {
      const drained: QueuedLine[] = [];
      for (let index = 0; index < queued.length; ) {
        const queuedLine = queued[index];
        if (queuedLine !== undefined && queuedLine.sequence > sequence) {
          queued.splice(index, 1);
          drained.push(queuedLine);
          continue;
        }
        index++;
      }
      return drained;
    },
    restoreLines: (lines) => {
      queued.push(...lines);
      queued.sort((left, right) => left.sequence - right.sequence);
    },
    sequence: () => currentSequence,
  };
}

function escapeApprovalText(text: string): string {
  return text.replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: approval prompts must render model-controlled bytes visibly.
    /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2060\u202a-\u202e\u2066-\u2069\ufeff]/g,
    (char) => {
      switch (char) {
        case "\n":
          return "\\n";
        case "\r":
          return "\\r";
        case "\t":
          return "\\t";
        default: {
          const code = char.charCodeAt(0);
          return code <= 0x9f
            ? `\\x${code.toString(16).padStart(2, "0")}`
            : `\\u{${code.toString(16)}}`;
        }
      }
    },
  );
}

function interactiveBashPermissionPolicy(
  mode: BashMode,
  lineReader: LineReader,
  writeStderr: (text: string) => void,
): BashPermissionPolicy | undefined {
  if (mode !== "ask") {
    return undefined;
  }

  return createSessionBashPermissionPolicy({
    prompt: async (request) => {
      const promptSequence = lineReader.sequence();
      writeStderr(
        [
          "Approve bash command?",
          `cwd: ${escapeApprovalText(request.cwd)}`,
          `$ ${escapeApprovalText(request.command)}`,
          "[y] allow once, [s] allow for session, [n] deny; any other input denies: ",
        ].join("\n"),
      );
      const rawAnswer = await lineReader.readLineAfter(
        promptSequence,
        request.signal,
      );
      if (rawAnswer === null) {
        return {
          type: "deny",
          message: "Command approval was interrupted or input closed.",
        };
      }
      const answer = rawAnswer.trim().toLowerCase();
      if (answer === "") {
        return {
          type: "deny",
          message: "No approval response provided.",
        };
      }
      if (answer === "y" || answer === "yes") {
        return { type: "allow", scope: "once" };
      }
      if (answer === "s" || answer === "session" || answer === "a") {
        return { type: "allow", scope: "session" };
      }
      return { type: "deny", message: "User did not approve this command." };
    },
  });
}

export async function runInteractiveSession(
  options: InteractiveSessionOptions,
): Promise<InteractiveSessionResult> {
  const systemPrompt = buildAgentSystemPrompt({
    workspace: options.workspace,
    platform: options.platform,
    ...(options.projectInstructions !== undefined
      ? { projectInstructions: options.projectInstructions }
      : {}),
  });
  const messages: Message[] = [...(options.initialMessages ?? [])];
  let resolved: InteractiveResolvedProvider | null = null;
  const input = createInterface({
    input: options.input,
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  const lineReader = createLineReader(input);
  const bashPermission = interactiveBashPermissionPolicy(
    options.cliArgs.bashMode,
    lineReader,
    options.writeStderr,
  );
  let activeAbortController: AbortController | null = null;
  let reportProvider: InteractiveResolvedProvider | null = null;
  let sessionUsage = EMPTY_USAGE;
  let sessionTurns = 0;
  let sessionCostUsd = 0;
  let sessionStopReason = "completed";
  const restoreDrainedInput = (lines: readonly QueuedLine[]) => {
    if (lines.length === 0) {
      return;
    }
    lineReader.restoreLines(lines);
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
      stopReason: sessionStopReason,
      cost: currentSessionCostReport(),
    };
  };
  const remainingMaxCostUsd = (): number | undefined => {
    if (options.cliArgs.maxCostUsd === undefined) {
      return undefined;
    }
    return Math.max(0, options.cliArgs.maxCostUsd - sessionCostUsd);
  };
  const recordCompactionCost = (
    usage: Usage,
    costModel: CostModel,
  ): CostReport => {
    sessionUsage = addUsage(sessionUsage, usage);
    sessionCostUsd += calculateRequestCostBatchUsd(
      { requests: [{ usage }] },
      costModel,
    );
    return currentSessionCostReport();
  };
  const recordTurnEnd = (end: EndEvent): CostReport | undefined => {
    sessionUsage = addUsage(sessionUsage, end.usage);
    sessionTurns += end.turns;
    sessionStopReason = end.stopReason;
    if (end.cost === undefined) {
      return undefined;
    }
    sessionCostUsd += end.cost.spentUsd;
    return currentSessionCostReport();
  };

  options.onSigint(abortActiveTurn);
  try {
    for (;;) {
      const rawLine = await lineReader.readLine();
      if (rawLine === null) break;
      const userMessage = rawLine.trim();
      if (userMessage === "") continue;
      const manualCompactCommand = parseManualCompactCommand(rawLine);
      if (manualCompactCommand !== null) {
        if (messages.length === 0 || resolved === null) {
          options.writeStderr(
            "Context compaction skipped: no conversation history to compact.\n",
          );
          continue;
        }
        const compactAbortController = new AbortController();
        activeAbortController = compactAbortController;
        let compactCost: CostReport | undefined;
        try {
          compactCost = await executeManualCompaction({
            command: manualCompactCommand,
            resolved,
            messages,
            systemPrompt,
            signal: compactAbortController.signal,
            options,
            recordCompactionCost,
          });
        } finally {
          activeAbortController = null;
        }
        if (!compactAbortController.signal.aborted) {
          options.persistSessionMessages?.(messages, "compaction");
        }
        if (compactCost?.budgetExceeded === true) {
          sessionStopReason = "cost_budget";
          break;
        }
        continue;
      }
      resolved ??= options.resolveProvider(userMessage);
      reportProvider ??= resolved;
      const messagesBeforeTurn = messages.slice();
      const turnStartSequence = lineReader.sequence();
      const drainedInjectedLines: QueuedLine[] = [];
      const deferredInputLines: QueuedLine[] = [];
      const turnAbortController = new AbortController();
      activeAbortController = turnAbortController;
      messages.push({ role: "user", content: userMessage });
      let deferRemainingInjectedInput = false;

      try {
        const remainingCostUsd = remainingMaxCostUsd();
        const stream = runAgentTurn({
          workspace: options.workspace,
          provider: resolved.provider,
          messages,
          systemPrompt,
          signal: turnAbortController.signal,
          allowBash: bashModeExposesTool(options.cliArgs.bashMode),
          stopPolicy: defaultStopPolicy(),
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
          drainInjectedUserMessages: () => {
            const queuedLines = lineReader
              .drainLinesAfter(turnStartSequence)
              .map((queuedLine) => ({
                sequence: queuedLine.sequence,
                line: queuedLine.line.trim(),
              }))
              .filter((queuedLine) => queuedLine.line !== "");
            if (deferRemainingInjectedInput) {
              deferredInputLines.push(...queuedLines);
              return [];
            }
            const firstCommandIndex = queuedLines.findIndex(
              (queuedLine) =>
                parseManualCompactCommand(queuedLine.line) !== null,
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
        });
        const finalEnd = await options.printAgentEvents(stream);
        if (turnAbortController.signal.aborted) {
          messages.splice(0, messages.length, ...messagesBeforeTurn);
          const restoredLines = [
            ...drainedInjectedLines,
            ...deferredInputLines,
          ];
          restoreDrainedInput(restoredLines);
          options.writeStdout("\n");
          continue;
        }
        restoreDrainedInput(deferredInputLines);
        options.persistSessionMessages?.(messages, "turn");
        options.writeStdout("\n");
        const cumulativeCost =
          finalEnd === undefined ? undefined : recordTurnEnd(finalEnd);
        if (
          options.cliArgs.maxCostUsd !== undefined &&
          cumulativeCost !== undefined
        ) {
          options.writeStderr(
            options.formatCostReport(
              cumulativeCost,
              options.cliArgs.maxCostUsd,
            ),
          );
        }
        if (cumulativeCost?.budgetExceeded === true) {
          break;
        }
      } catch (error) {
        if (!turnAbortController.signal.aborted) {
          throw error;
        }
        messages.splice(0, messages.length, ...messagesBeforeTurn);
        const restoredLines = [...drainedInjectedLines, ...deferredInputLines];
        restoreDrainedInput(restoredLines);
        options.writeStdout("\n");
      } finally {
        activeAbortController = null;
      }
    }
  } finally {
    options.offSigint(abortActiveTurn);
    input.close();
  }
  const reportEnd = currentReportEnd();
  if (
    options.cliArgs.reportFile !== undefined &&
    reportProvider !== null &&
    reportEnd !== undefined
  ) {
    return {
      report: {
        provider: reportProvider.providerId,
        model: reportProvider.model,
        end: reportEnd,
      },
    };
  }
  return {};
}
