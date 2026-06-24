import { createInterface } from "node:readline/promises";
import {
  type ContextCompactionOptions,
  compactMessages,
  contextCompactionStatsForCurrentMessages,
} from "../agent/context-compaction.ts";
import type {
  AgentEvent,
  CostReport,
  ReadVisibilityState,
} from "../agent/loop.ts";
import {
  clearReadVisibilityState,
  createReadVisibilityState,
  restorePostCompactionReads,
  runAgentTurn,
} from "../agent/loop.ts";
import {
  buildAgentSystemPrompt,
  type ProjectInstructions,
} from "../agent/prompt.ts";
import { defaultStopPolicy } from "../agent/stop-policy.ts";
import { type CostModel, calculateRequestCostBatchUsd } from "../core/cost.ts";
import {
  type RecordLastBatchCheckpointOperation,
  recordLastTaskCheckpoint,
  restoreLastEditCheckpoint,
} from "../core/git.ts";
import type { ProviderId } from "../core/provider-id.ts";
import type { LLMProvider, Message, Usage } from "../llm/types.ts";
import {
  type BashApprovalGrant,
  type BashMode,
  type BashPermissionPolicy,
  bashModeExposesTool,
  createSessionBashPermissionPolicy,
} from "../permissions/bash.ts";
import {
  formatInteractiveForkPicker,
  formatInteractiveSessionForkPoints,
  type SessionForkPoints,
} from "./fork-points.ts";
import {
  formatContextCompactionReport,
  sanitizeStatusLineText,
} from "./output.ts";
import type { SessionQueuedInput } from "./session-store.ts";

type EndEvent = Extract<AgentEvent, { readonly type: "end" }>;
type EndEventWithCost = EndEvent & { readonly cost: CostReport };

interface InteractiveSessionArgs {
  readonly bashMode: BashMode;
  readonly maxCostUsd?: number;
  readonly reportFile?: string;
}

export type SessionPersistenceReason = "turn" | "compaction";

export interface InteractiveForkSessionRequest {
  readonly targetSessionId: string;
  readonly beforeMessageId?: string;
}

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
  readonly initialQueuedInputs?: readonly SessionQueuedInput[];
  readonly initialBashApprovalGrants?: readonly BashApprovalGrant[];
  readonly persistQueuedInput?: (input: {
    readonly sequence: number;
    readonly line: string;
  }) => SessionQueuedInput;
  readonly consumeQueuedInputs?: (inputIds: readonly string[]) => void;
  readonly persistSessionMessages?: (
    messages: readonly Message[],
    reason: SessionPersistenceReason,
    consumedInputIds: readonly string[],
  ) => void;
  readonly forkSession?: (request: InteractiveForkSessionRequest) => string;
  readonly listForkPoints?: () => SessionForkPoints;
  readonly persistBashApprovalGrant?: (grant: BashApprovalGrant) => void;
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
  readonly readLine: () => Promise<QueuedLine | null>;
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
  readonly inputId?: string;
}

interface LineWaiter {
  readonly after: number;
  readonly resolve: (line: string | null) => void;
}

interface HelpCommand {
  readonly kind: "help";
}

interface UndoCommand {
  readonly kind: "undo";
}

interface ManualCompactCommand {
  readonly kind: "compact";
  readonly focusInstruction?: string;
}

interface ForkCommand {
  readonly kind: "fork";
  readonly targetSessionId: string;
  readonly beforeMessageId?: string;
  readonly pick?: true;
}

interface ForkPointsCommand {
  readonly kind: "fork-points";
}

interface InvalidInteractiveCommand {
  readonly kind: "invalid";
  readonly message: string;
}

type InteractiveCommand =
  | HelpCommand
  | UndoCommand
  | ManualCompactCommand
  | ForkPointsCommand
  | ForkCommand
  | InvalidInteractiveCommand;

type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

function formatInteractiveHelp(): string {
  return [
    "Interactive commands:",
    "  /help              Show this help.",
    "  /undo              Restore the last edit checkpoint.",
    "  /compact [focus]   Summarize older conversation context with optional focus.",
    "  /fork <target-id> [--before-message <id>]",
    "                     Fork this named or resumed session without switching to it.",
    "  /fork <target-id> --pick",
    "                     Choose the fork point interactively.",
    "  /fork-points       List restored user-message fork points.",
    "",
    "Session commands:",
    "  keel sessions",
    "      List saved interactive sessions.",
    "  keel --resume <id>",
    "      Resume a saved interactive session.",
    "  keel --resume <id> --fork-points",
    "      List restored user-message fork points.",
    "  keel sessions fork <source-id> <target-id> [--before-message <id>]",
    "      Fork a saved session into a new session.",
    "",
    "Controls:",
    "  Ctrl-D             Exit when input closes.",
    "  Ctrl-C             Interrupt the active turn or exit while idle.",
    "",
  ].join("\n");
}

function parseForkBeforeMessage(raw: string | undefined): ParseResult<string> {
  if (raw === undefined || raw === "") {
    return { ok: false, message: "Error: --before-message requires a value." };
  }
  return { ok: true, value: raw };
}

function parseForkCommandArgs(
  rawArgs: string | undefined,
): ForkCommand | InvalidInteractiveCommand {
  const trimmedArgs = rawArgs?.trim() ?? "";
  if (trimmedArgs === "") {
    return {
      kind: "invalid",
      message: "Error: /fork requires <target-id>.",
    };
  }

  const args = trimmedArgs.split(/\s+/u);
  const targetSessionId = args[0];
  if (targetSessionId === undefined || targetSessionId.startsWith("-")) {
    return {
      kind: "invalid",
      message: "Error: /fork requires <target-id>.",
    };
  }

  let beforeMessageId: string | undefined;
  let pick = false;
  const beforeMessagePrefix = "--before-message=";
  const optionArgs = args.slice(1);
  let skipNext = false;
  for (const [index, arg] of optionArgs.entries()) {
    if (skipNext) {
      skipNext = false;
      continue;
    }

    if (arg === "--pick") {
      pick = true;
      continue;
    }

    if (arg === "--before-message") {
      const parsed = parseForkBeforeMessage(optionArgs[index + 1]);
      if (!parsed.ok) {
        return { kind: "invalid", message: parsed.message };
      }
      beforeMessageId = parsed.value;
      skipNext = true;
      continue;
    }

    if (arg.startsWith(beforeMessagePrefix)) {
      const parsed = parseForkBeforeMessage(
        arg.slice(beforeMessagePrefix.length),
      );
      if (!parsed.ok) {
        return { kind: "invalid", message: parsed.message };
      }
      beforeMessageId = parsed.value;
      continue;
    }

    return {
      kind: "invalid",
      message: `Error: unknown /fork option "${arg}".`,
    };
  }

  if (pick && beforeMessageId !== undefined) {
    return {
      kind: "invalid",
      message: "Error: --pick cannot be combined with --before-message.",
    };
  }

  return {
    kind: "fork",
    targetSessionId,
    ...(beforeMessageId !== undefined ? { beforeMessageId } : {}),
    ...(pick ? { pick } : {}),
  };
}

function parseInteractiveCommand(
  userMessage: string,
): InteractiveCommand | null {
  const trimmed = userMessage.trim();
  if (trimmed === "/help") {
    return { kind: "help" };
  }

  const undoMatch = /^\/undo(?:\s+(.*))?$/u.exec(trimmed);
  if (undoMatch !== null) {
    const extraArgs = undoMatch[1]?.trim();
    if (extraArgs !== undefined && extraArgs !== "") {
      return {
        kind: "invalid",
        message: "Error: /undo does not accept arguments.",
      };
    }
    return { kind: "undo" };
  }

  const forkPointsMatch = /^\/fork-points(?:\s+(.*))?$/u.exec(trimmed);
  if (forkPointsMatch !== null) {
    const extraArgs = forkPointsMatch[1]?.trim();
    if (extraArgs !== undefined && extraArgs !== "") {
      return {
        kind: "invalid",
        message: "Error: /fork-points does not accept arguments.",
      };
    }
    return { kind: "fork-points" };
  }

  const forkMatch = /^\/fork(?:\s+(.*))?$/u.exec(trimmed);
  if (forkMatch !== null) {
    return parseForkCommandArgs(forkMatch[1]);
  }

  const compactMatch = /^\/compact(?:\s+(.*))?$/u.exec(trimmed);
  if (compactMatch === null) {
    return null;
  }
  const focusInstruction = compactMatch[1]?.trim();
  if (focusInstruction === undefined || focusInstruction === "") {
    return { kind: "compact" };
  }
  return { kind: "compact", focusInstruction };
}

function formatInteractiveCommandFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${sanitizeStatusLineText(message)}\n`;
}

function undoRestoredContextMessage(filePath: string): string {
  return `Keel local command /undo restored ${filePath}. Treat this as workspace state, not as a new user request.`;
}

function formatManualCompactionFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Context compaction failed: ${sanitizeStatusLineText(message)}\n`;
}

function formatForkRequiresNamedSession(
  command: "/fork" | "/fork-points",
): string {
  return `Error: ${command} requires a named session. Start with --session or --resume.\n`;
}

interface ForkPointSelection {
  readonly choice: number;
}

interface ForkPointPickerSelection {
  readonly kind: "selected";
  readonly selection: ForkPointSelection;
  readonly consumedLines: readonly QueuedLine[];
}

interface ForkPointPickerCancelled {
  readonly kind: "cancelled";
  readonly consumedLines: readonly QueuedLine[];
  readonly explicit: boolean;
}

type ForkPointPickerResult =
  | ForkPointPickerSelection
  | ForkPointPickerCancelled;

function formatForkPointSelectionPrompt(maxChoice: number): string {
  return `Select fork point [0-${maxChoice}], or q to cancel:\n`;
}

function parseForkPointSelection(
  rawSelection: string,
  maxChoice: number,
): ForkPointSelection | "cancelled" | "invalid" {
  const selection = rawSelection.trim().toLowerCase();
  if (selection === "0") {
    return { choice: 0 };
  }
  if (selection === "q" || selection === "quit" || selection === "cancel") {
    return "cancelled";
  }
  if (!/^[1-9][0-9]*$/u.test(selection)) {
    return "invalid";
  }

  const choice = Number(selection);
  if (!Number.isSafeInteger(choice) || choice > maxChoice) {
    return "invalid";
  }
  return { choice };
}

async function readForkPointPickerSelection(options: {
  readonly maxChoice: number;
  readonly lineReader: LineReader;
  readonly writeStdout: (text: string) => void;
  readonly writeStderr: (text: string) => void;
}): Promise<ForkPointPickerResult> {
  const consumedLines: QueuedLine[] = [];
  for (;;) {
    const rawSelection = await options.lineReader.readLine();
    if (rawSelection === null) {
      return {
        kind: "cancelled",
        consumedLines,
        explicit: false,
      };
    }
    consumedLines.push(rawSelection);
    const selection = parseForkPointSelection(
      rawSelection.line,
      options.maxChoice,
    );
    if (selection === "cancelled") {
      return {
        kind: "cancelled",
        consumedLines,
        explicit: true,
      };
    }
    if (selection === "invalid") {
      options.writeStderr(
        `Error: selection must be 0-${options.maxChoice} or q.\n`,
      );
      options.writeStdout(formatForkPointSelectionPrompt(options.maxChoice));
      continue;
    }
    return {
      kind: "selected",
      selection,
      consumedLines,
    };
  }
}

interface ManualCompactContext {
  readonly command: ManualCompactCommand;
  readonly resolved: InteractiveResolvedProvider;
  readonly workspace: string;
  readonly messages: Message[];
  readonly systemPrompt: string;
  readonly signal: AbortSignal;
  readonly readVisibility: ReadVisibilityState;
  readonly nextPostCompactionReadToolCallId: () => string;
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
    workspace,
    messages,
    systemPrompt,
    signal,
    readVisibility,
    nextPostCompactionReadToolCallId,
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
    if (result.compacted) {
      await restorePostCompactionReads({
        workspace,
        signal,
        readVisibility,
        messages,
        nextToolCallId: nextPostCompactionReadToolCallId,
      });
      const reportStats = contextCompactionStatsForCurrentMessages({
        stats: result.stats,
        systemPrompt,
        messages,
      });
      options.writeStderr(
        formatContextCompactionReport({
          ...reportStats,
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

function queuedLineFromSessionInput(input: SessionQueuedInput): QueuedLine {
  return {
    sequence: input.sequence,
    line: input.line,
    inputId: input.id,
  };
}

function queuedLineWithInputId(
  sequence: number,
  line: string,
  inputId: string | undefined,
): QueuedLine {
  if (inputId === undefined) {
    return { sequence, line };
  }
  return { sequence, line, inputId };
}

function trimQueuedLine(queuedLine: QueuedLine): QueuedLine {
  return queuedLineWithInputId(
    queuedLine.sequence,
    queuedLine.line.trim(),
    queuedLine.inputId,
  );
}

function queuedInputIds(lines: readonly QueuedLine[]): readonly string[] {
  const inputIds: string[] = [];
  for (const line of lines) {
    if (line.inputId !== undefined) {
      inputIds.push(line.inputId);
    }
  }
  return inputIds;
}

function createLineReader(
  input: ReturnType<typeof createInterface>,
  options: {
    readonly initialQueuedInputs?: readonly SessionQueuedInput[];
    readonly persistQueuedInput?: (input: {
      readonly sequence: number;
      readonly line: string;
    }) => SessionQueuedInput;
  },
): LineReader {
  const queued: QueuedLine[] = (options.initialQueuedInputs ?? []).map(
    queuedLineFromSessionInput,
  );
  const waiters: Array<(line: QueuedLine | null) => void> = [];
  const freshWaiters: LineWaiter[] = [];
  let closed = false;
  let currentSequence = queued.reduce(
    (highest, queuedLine) => Math.max(highest, queuedLine.sequence),
    0,
  );

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
      waiter(queuedLine);
      return;
    }
    const admittedInput =
      line.trim() === ""
        ? undefined
        : options.persistQueuedInput?.({
            sequence: queuedLine.sequence,
            line: queuedLine.line,
          });
    queued.push(
      queuedLineWithInputId(
        queuedLine.sequence,
        queuedLine.line,
        admittedInput?.id,
      ),
    );
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
        return Promise.resolve(queuedLine);
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
  policyOptions: {
    readonly initialGrants?: readonly BashApprovalGrant[];
    readonly onGrant?: (grant: BashApprovalGrant) => void;
  },
): BashPermissionPolicy | undefined {
  if (mode !== "ask") {
    return undefined;
  }

  return createSessionBashPermissionPolicy({
    ...(policyOptions.initialGrants !== undefined
      ? { initialGrants: policyOptions.initialGrants }
      : {}),
    ...(policyOptions.onGrant !== undefined
      ? { onGrant: policyOptions.onGrant }
      : {}),
    prompt: async (request) => {
      const promptSequence = lineReader.sequence();
      const prefixApprovalLine =
        request.prefixApproval === undefined
          ? []
          : [
              `[p] allow command family for session: ${escapeApprovalText(
                request.prefixApproval.display,
              )}`,
            ];
      writeStderr(
        [
          "Approve bash command?",
          `cwd: ${escapeApprovalText(request.cwd)}`,
          `$ ${escapeApprovalText(request.command)}`,
          ...prefixApprovalLine,
          "[y] allow once, [s] allow exact command for session, [n] deny; any other input denies: ",
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
      if (request.prefixApproval !== undefined && answer === "p") {
        return { type: "allow", scope: "session-prefix" };
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
  const lineReader = createLineReader(input, {
    ...(options.initialQueuedInputs !== undefined
      ? { initialQueuedInputs: options.initialQueuedInputs }
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
      ...(options.persistBashApprovalGrant !== undefined
        ? { onGrant: options.persistBashApprovalGrant }
        : {}),
    },
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
  const readVisibility = createReadVisibilityState();
  let postCompactionReadSequence = 0;

  options.onSigint(abortActiveTurn);
  try {
    for (;;) {
      const rawInput = await lineReader.readLine();
      if (rawInput === null) break;
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
      if (interactiveCommand?.kind === "invalid") {
        options.writeStderr(`${interactiveCommand.message}\n`);
        consumeQueuedInputLines([rawInput]);
        continue;
      }
      if (interactiveCommand?.kind === "undo") {
        const result = restoreLastEditCheckpoint(options.workspace);
        switch (result.status) {
          case "restored":
            options.writeStdout(`Restored ${result.restoredLabel}\n`);
            clearReadVisibilityState(readVisibility);
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
        if (messages.length === 0 || resolved === null) {
          options.writeStderr(
            "Context compaction skipped: no conversation history to compact.\n",
          );
          consumeQueuedInputLines([rawInput]);
          continue;
        }
        const compactAbortController = new AbortController();
        activeAbortController = compactAbortController;
        let compactCost: CostReport | undefined;
        try {
          compactCost = await executeManualCompaction({
            command: interactiveCommand,
            resolved,
            workspace: options.workspace,
            messages,
            systemPrompt,
            signal: compactAbortController.signal,
            readVisibility,
            nextPostCompactionReadToolCallId: () =>
              `post_compaction_read_${postCompactionReadSequence++}`,
            options,
            recordCompactionCost,
          });
        } finally {
          activeAbortController = null;
        }
        if (!compactAbortController.signal.aborted) {
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
      resolved ??= options.resolveProvider(userMessage);
      reportProvider ??= resolved;
      const messagesBeforeTurn = messages.slice();
      const checkpointOperations: RecordLastBatchCheckpointOperation[] = [];
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
          readVisibility,
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
        options.persistSessionMessages?.(messages, "turn", [
          ...queuedInputIds([rawInput]),
          ...queuedInputIds(drainedInjectedLines),
        ]);
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
        if (checkpointOperations.length > 1) {
          recordLastTaskCheckpoint({
            workspace: options.workspace,
            operations: checkpointOperations,
          });
        }
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
