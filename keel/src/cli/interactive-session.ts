import { createInterface } from "node:readline/promises";
import type { AgentEvent, CostReport } from "../agent/loop.ts";
import { runAgentTurn } from "../agent/loop.ts";
import { buildAgentSystemPrompt } from "../agent/prompt.ts";
import type { CostModel } from "../core/cost.ts";
import type { LLMProvider, Message } from "../llm/types.ts";

type EndEvent = Extract<AgentEvent, { readonly type: "end" }>;

export interface InteractiveSessionArgs {
  readonly allowBash: boolean;
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
  readonly formatCostReport: (cost: CostReport) => string;
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
    for await (const rawLine of input) {
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
        options.writeStdout("\n");
        if (
          options.cliArgs.maxCostUsd !== undefined &&
          finalEnd?.cost !== undefined
        ) {
          options.writeStderr(options.formatCostReport(finalEnd.cost));
        }
      } catch (error) {
        if (!turnAbortController.signal.aborted) {
          throw error;
        }
        messages.length = messageCountBeforeTurn;
        options.writeStdout("\n");
      } finally {
        if (activeAbortController === turnAbortController) {
          activeAbortController = null;
        }
      }
    }
  } finally {
    options.offSigint(abortActiveTurn);
    input.close();
  }
}
