import { createInterface } from "node:readline/promises";
import type { AgentEvent, CostReport } from "../agent/loop.ts";
import { runAgentTurn } from "../agent/loop.ts";
import { buildAgentSystemPrompt } from "../agent/prompt.ts";
import type { CostModel } from "../core/cost.ts";
import type { LLMProvider, Message } from "../llm/types.ts";
import {
  type BashPermissionPolicy,
  type BashPolicy,
  createSessionBashPermissionPolicy,
} from "../permissions/bash.ts";

type EndEvent = Extract<AgentEvent, { readonly type: "end" }>;

interface InteractiveSessionArgs {
  readonly allowBash: boolean;
  readonly bashPolicy: BashPolicy;
  readonly maxCostUsd?: number;
}

export interface InteractiveResolvedProvider {
  readonly provider: LLMProvider;
  readonly model: string;
  readonly costModel: CostModel | null;
}

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
  policy: BashPolicy,
  lineReader: LineReader,
  writeStderr: (text: string) => void,
): BashPermissionPolicy | undefined {
  if (policy !== "ask") {
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
    options.cliArgs.bashPolicy,
    lineReader,
    options.writeStderr,
  );
  let activeAbortController: AbortController | null = null;
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
      const rawLine = await lineReader.readLine();
      if (rawLine === null) break;
      const userMessage = rawLine.trim();
      if (userMessage === "") continue;
      resolved ??= options.resolveProvider(userMessage);
      const messageCountBeforeTurn = messages.length;
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
          ...(options.cliArgs.allowBash ? { allowBash: true } : {}),
          ...(bashPermission !== undefined ? { bashPermission } : {}),
          ...(options.cliArgs.maxCostUsd !== undefined
            ? {
                costTracking: {
                  model: options.requireKnownCostModel(resolved),
                  maxCostUsd: options.cliArgs.maxCostUsd,
                },
              }
            : {}),
        });
        const finalEnd = await options.printAgentEvents(stream);
        if (turnAbortController.signal.aborted) {
          messages.length = messageCountBeforeTurn;
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
