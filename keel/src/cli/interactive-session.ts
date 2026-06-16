import { createInterface } from "node:readline/promises";
import type { AgentEvent, CostReport } from "../agent/loop.ts";
import { runAgentTurn } from "../agent/loop.ts";
import { buildAgentSystemPrompt } from "../agent/prompt.ts";
import type { CostModel } from "../core/cost.ts";
import type { LLMProvider, Message } from "../llm/types.ts";
import {
  type BashMode,
  type BashPermissionPolicy,
  bashModeExposesTool,
  createSessionBashPermissionPolicy,
} from "../permissions/bash.ts";

type EndEvent = Extract<AgentEvent, { readonly type: "end" }>;
export type ProviderId = "fake" | "deepseek" | "kimi" | "qwen";

interface InteractiveSessionArgs {
  readonly bashMode: BashMode;
  readonly maxCostUsd?: number;
}

interface InteractiveResolvedProviderBase {
  readonly provider: LLMProvider;
  readonly model: string;
}

export type InteractiveResolvedProvider =
  | (InteractiveResolvedProviderBase & {
      readonly providerId: "fake";
      readonly costModel: CostModel;
    })
  | (InteractiveResolvedProviderBase & {
      readonly providerId: "deepseek";
      readonly costModel: CostModel;
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

interface LineReader {
  readonly readLine: () => Promise<string | null>;
  readonly readLineAfter: (
    sequence: number,
    signal: AbortSignal,
  ) => Promise<string | null>;
  readonly drainLinesAfter: (sequence: number) => readonly string[];
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
      const drained: string[] = [];
      for (let index = 0; index < queued.length; ) {
        const queuedLine = queued[index];
        if (queuedLine !== undefined && queuedLine.sequence > sequence) {
          queued.splice(index, 1);
          drained.push(queuedLine.line);
          continue;
        }
        index++;
      }
      return drained;
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
): Promise<void> {
  const systemPrompt = buildAgentSystemPrompt({
    workspace: options.workspace,
    platform: options.platform,
  });
  const messages: Message[] = [];
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
  const restoredInputLines: string[] = [];
  const restoreDrainedInput = (lines: string[]) => {
    if (lines.length === 0) {
      return;
    }
    restoredInputLines.push(...lines);
    lines.length = 0;
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

  options.onSigint(abortActiveTurn);
  try {
    for (;;) {
      const restoredLine = restoredInputLines.shift();
      const rawLine =
        restoredLine === undefined ? await lineReader.readLine() : restoredLine;
      if (rawLine === null) break;
      const userMessage = rawLine.trim();
      if (userMessage === "") continue;
      resolved ??= options.resolveProvider(userMessage);
      const messageCountBeforeTurn = messages.length;
      const turnStartSequence = lineReader.sequence();
      const drainedSteeringLines: string[] = [];
      const turnAbortController = new AbortController();
      activeAbortController = turnAbortController;
      messages.push({ role: "user", content: userMessage });

      try {
        const stream = runAgentTurn({
          workspace: options.workspace,
          provider: resolved.provider,
          messages,
          systemPrompt,
          signal: turnAbortController.signal,
          ...(bashModeExposesTool(options.cliArgs.bashMode)
            ? { allowBash: true }
            : {}),
          ...(bashPermission !== undefined ? { bashPermission } : {}),
          ...(options.cliArgs.maxCostUsd !== undefined
            ? {
                costTracking: {
                  model: options.requireKnownCostModel(resolved),
                  maxCostUsd: options.cliArgs.maxCostUsd,
                },
              }
            : {}),
          drainSteeringMessages: () => {
            const steeringLines = lineReader
              .drainLinesAfter(turnStartSequence)
              .map((line) => line.trim())
              .filter((line) => line !== "");
            drainedSteeringLines.push(...steeringLines);
            return steeringLines.map((content) => ({ role: "user", content }));
          },
        });
        const finalEnd = await options.printAgentEvents(stream);
        if (turnAbortController.signal.aborted) {
          messages.length = messageCountBeforeTurn;
          restoreDrainedInput(drainedSteeringLines);
          options.writeStdout("\n");
          continue;
        }
        options.writeStdout("\n");
        if (
          options.cliArgs.maxCostUsd !== undefined &&
          finalEnd?.cost !== undefined
        ) {
          options.writeStderr(
            options.formatCostReport(finalEnd.cost, options.cliArgs.maxCostUsd),
          );
        }
      } catch (error) {
        if (!turnAbortController.signal.aborted) {
          throw error;
        }
        messages.length = messageCountBeforeTurn;
        restoreDrainedInput(drainedSteeringLines);
        options.writeStdout("\n");
      } finally {
        activeAbortController = null;
      }
    }
  } finally {
    options.offSigint(abortActiveTurn);
    input.close();
  }
}
