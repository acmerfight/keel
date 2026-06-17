import { type CostModel, calculateCostUsd } from "../core/cost.ts";
import { KeelError } from "../core/error.ts";
import type { LLMProvider, Message, ToolCall, Usage } from "../llm/types.ts";
import type { BashPermissionPolicy } from "../permissions/bash.ts";
import { executeToolCall } from "../tools/execution.ts";
import {
  type CompactMessagesResult,
  type ContextCompactionAccountingSnapshot,
  type ContextCompactionOptions,
  type ContextCompactionStats,
  captureContextCompactionAccountingSnapshot,
  compactMessages,
  shouldCompactBeforeRequest,
} from "./context-compaction.ts";
import type { AgentStopPolicy } from "./stop-policy.ts";
import { defaultStopPolicy } from "./stop-policy.ts";

export interface CostReport {
  readonly spentUsd: number;
  readonly maxUsd?: number;
  readonly budgetExceeded: boolean;
}

interface CostTrackingOptions {
  readonly model: CostModel;
  readonly maxCostUsd?: number;
}

// stopReason is "completed" when the assistant finished with a plain answer;
// otherwise it is the stop policy's reason label (e.g. "cost_budget",
// "repeated_tool_call", "turn_limit").
type ContextCompactionReason = "proactive" | "overflow_recovery";

export type AgentEvent =
  | { readonly type: "text"; readonly text: string }
  | ({
      readonly type: "context_compacted";
      readonly reason: ContextCompactionReason;
    } & ContextCompactionStats)
  | {
      readonly type: "provider_retry";
      readonly provider: string;
      readonly reason: string;
      readonly attempt: number;
      readonly maxRetries: number;
      readonly delayMs: number;
    }
  | { readonly type: "tool_start"; readonly toolCall: ToolCall }
  | {
      readonly type: "tool_end";
      readonly toolCall: ToolCall;
      readonly ok: boolean;
    }
  | {
      readonly type: "end";
      readonly usage: Usage;
      readonly turns: number;
      readonly stopReason: string;
      readonly cost?: CostReport;
    };

export interface RunAgentOptions {
  readonly workspace: string;
  readonly provider: LLMProvider;
  readonly userMessage: string;
  readonly systemPrompt: string;
  readonly signal: AbortSignal;
  readonly costTracking?: CostTrackingOptions;
  readonly allowBash?: boolean;
  readonly bashPermission?: BashPermissionPolicy;
  readonly stopPolicy?: AgentStopPolicy;
  readonly contextCompaction?: ContextCompactionOptions;
}

type SteeringMessage = Extract<Message, { readonly role: "user" }>;

export interface RunAgentTurnOptions {
  readonly workspace: string;
  readonly provider: LLMProvider;
  // Mutated in place: user messages are supplied by the session owner, while
  // agent turns append assistant/tool messages so later turns share context.
  readonly messages: Message[];
  readonly systemPrompt: string;
  readonly signal: AbortSignal;
  readonly costTracking?: CostTrackingOptions;
  readonly allowBash?: boolean;
  readonly bashPermission?: BashPermissionPolicy;
  readonly stopPolicy?: AgentStopPolicy;
  readonly contextCompaction?: ContextCompactionOptions;
  readonly drainSteeringMessages?: () =>
    | readonly SteeringMessage[]
    | Promise<readonly SteeringMessage[]>;
}

class ContextOverflowBeforeAssistantError extends Error {
  readonly error: unknown;

  constructor(error: unknown) {
    super("Provider context overflowed before assistant output started");
    this.name = "ContextOverflowBeforeAssistantError";
    this.error = error;
  }
}

function isProviderContextOverflow(error: unknown): boolean {
  return (
    error instanceof KeelError && error.code === "provider_context_overflow"
  );
}

interface AgentTurn {
  readonly text: string;
  readonly toolCalls: readonly ToolCall[];
  readonly usage: Usage;
}

function addUsage(left: Usage, right: Usage): Usage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    uncachedInputTokens: left.uncachedInputTokens + right.uncachedInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
  };
}

function priorToolCallsFromMessages(messages: readonly Message[]): ToolCall[] {
  const lastUserIndex = messages.findLastIndex(
    (message) => message.role === "user",
  );
  const currentTurnHistory =
    lastUserIndex < 0 ? messages : messages.slice(lastUserIndex + 1);
  return currentTurnHistory.flatMap((message) =>
    message.role === "assistant" ? (message.toolCalls ?? []) : [],
  );
}

function toolRequestMessage(turn: AgentTurn): Message {
  return {
    role: "assistant",
    content: turn.text,
    toolCalls: turn.toolCalls,
  };
}

function finalReplyMessage(text: string): Message | null {
  return text === "" ? null : { role: "assistant", content: text };
}

function appendMessage(messages: Message[], message: Message | null): void {
  if (message !== null) {
    messages.push(message);
  }
}

function finishAgentTurn(
  assistantText: readonly string[],
  pendingToolCalls: readonly ToolCall[],
  usage: Usage | null,
): AgentTurn {
  if (usage === null) {
    throw new KeelError(
      "agent_missing_stop",
      "LLM stream ended without stop event",
    );
  }

  return {
    text: assistantText.join(""),
    toolCalls: pendingToolCalls,
    usage,
  };
}

const WRAP_UP_INSTRUCTION =
  "You have used all available tool rounds for this task. Do not request any more tools. Briefly summarize what you completed and what remains to be done.";

const MISSING_SUMMARY_NOTICE =
  "\nReached the tool round limit before the task finished; the model did not provide a summary of the remaining work.";

interface StreamTurnOptions {
  readonly provider: LLMProvider;
  readonly systemPrompt: string;
  readonly messages: readonly Message[];
  readonly signal: AbortSignal;
  readonly allowBash: boolean;
  readonly toolChoice?: "none";
  readonly textPrefix?: string;
}

async function* streamAgentTurn(
  options: StreamTurnOptions,
): AsyncGenerator<AgentEvent, AgentTurn> {
  const { provider, systemPrompt, messages, signal, allowBash } = options;
  let textPrefix = options.textPrefix ?? "";
  const stream = provider.stream({
    systemPrompt,
    messages,
    signal,
    ...(allowBash ? { allowBash: true } : {}),
    ...(options.toolChoice !== undefined
      ? { toolChoice: options.toolChoice }
      : {}),
  });

  let usage: Usage | null = null;
  const assistantText: string[] = [];
  const pendingToolCalls: ToolCall[] = [];
  let assistantStarted = false;

  try {
    for await (const event of stream) {
      switch (event.type) {
        case "text":
          if (event.text !== "") {
            assistantStarted = true;
          }
          if (event.text !== "" && textPrefix !== "") {
            if (!event.text.startsWith("\n")) {
              assistantText.push(textPrefix);
              yield { type: "text", text: textPrefix };
            }
            textPrefix = "";
          }
          assistantText.push(event.text);
          yield { type: "text", text: event.text };
          break;
        case "tool_call": {
          assistantStarted = true;
          const { type: _llmEventType, ...toolCall } = event;
          pendingToolCalls.push(toolCall);
          break;
        }
        case "provider_retry":
          yield event;
          break;
        case "stop":
          usage = event.usage;
          break;
      }
    }
  } catch (error) {
    if (isProviderContextOverflow(error) && !assistantStarted) {
      throw new ContextOverflowBeforeAssistantError(error);
    }
    throw error;
  }

  return finishAgentTurn(assistantText, pendingToolCalls, usage);
}

export async function* runAgentTurn(
  options: RunAgentTurnOptions,
): AsyncGenerator<AgentEvent> {
  const {
    workspace,
    provider,
    messages,
    systemPrompt,
    signal,
    costTracking,
    allowBash = false,
    bashPermission,
    stopPolicy = defaultStopPolicy(),
    drainSteeringMessages,
  } = options;
  const priorToolCalls = priorToolCallsFromMessages(messages);
  const { contextCompaction } = options;
  let totalUsage: Usage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    uncachedInputTokens: 0,
    outputTokens: 0,
  };
  let contextAccounting: ContextCompactionAccountingSnapshot | undefined;

  function reportCost(usage: Usage): CostReport | undefined {
    if (costTracking === undefined) {
      return undefined;
    }
    const spentUsd = calculateCostUsd(usage, costTracking.model);
    const budgetExceeded =
      costTracking.maxCostUsd !== undefined &&
      spentUsd > costTracking.maxCostUsd;
    return {
      spentUsd,
      ...(costTracking.maxCostUsd !== undefined
        ? { maxUsd: costTracking.maxCostUsd }
        : {}),
      budgetExceeded,
    };
  }

  async function compactContextIfPossible(
    targetMessages: Message[],
    streamOptions: StreamTurnOptions,
  ): Promise<CompactMessagesResult> {
    const result = await compactMessages({
      provider,
      systemPrompt,
      messages: targetMessages,
      signal,
      ...(contextCompaction !== undefined ? { contextCompaction } : {}),
      ...(contextAccounting !== undefined ? { contextAccounting } : {}),
      ...(streamOptions.toolChoice !== undefined
        ? { requestMetadata: { toolChoice: streamOptions.toolChoice } }
        : {}),
    });
    if (result.compacted) {
      contextAccounting = undefined;
    }
    totalUsage = addUsage(totalUsage, result.usage);
    return result;
  }

  async function* streamRecoverableAgentTurn(
    streamOptions: StreamTurnOptions & { readonly messages: Message[] },
  ): AsyncGenerator<AgentEvent, AgentTurn> {
    let overflowRecoveryAttempted = false;
    let compactedBeforeRequest = false;
    const requestMessages = streamOptions.messages;

    for (;;) {
      if (
        !compactedBeforeRequest &&
        shouldCompactBeforeRequest(
          systemPrompt,
          requestMessages,
          contextCompaction,
          contextAccounting,
          streamOptions.toolChoice !== undefined
            ? { toolChoice: streamOptions.toolChoice }
            : undefined,
        )
      ) {
        compactedBeforeRequest = true;
        const compaction = await compactContextIfPossible(
          requestMessages,
          streamOptions,
        );
        if (compaction.stats !== undefined) {
          yield {
            type: "context_compacted",
            reason: "proactive",
            ...compaction.stats,
          };
        }
      }
      try {
        const turn = yield* streamAgentTurn(streamOptions);
        contextAccounting =
          contextCompaction === undefined
            ? undefined
            : captureContextCompactionAccountingSnapshot({
                systemPrompt,
                messages: requestMessages,
                usage: turn.usage,
                ...(streamOptions.toolChoice !== undefined
                  ? {
                      requestMetadata: { toolChoice: streamOptions.toolChoice },
                    }
                  : {}),
              });
        return turn;
      } catch (error) {
        if (error instanceof ContextOverflowBeforeAssistantError) {
          if (!overflowRecoveryAttempted) {
            overflowRecoveryAttempted = true;
            const compaction = await compactContextIfPossible(
              requestMessages,
              streamOptions,
            );
            if (compaction.compacted) {
              if (compaction.stats !== undefined) {
                yield {
                  type: "context_compacted",
                  reason: "overflow_recovery",
                  ...compaction.stats,
                };
              }
              compactedBeforeRequest = true;
              continue;
            }
          }
          throw error.error;
        }
        throw error;
      }
    }
  }

  for (let completedTurns = 1; ; completedTurns++) {
    const turnResult = yield* streamRecoverableAgentTurn({
      provider,
      systemPrompt,
      messages,
      signal,
      allowBash,
    });
    totalUsage = addUsage(totalUsage, turnResult.usage);
    const cost = reportCost(totalUsage);

    const decision = stopPolicy.shouldStopAfterTurn({
      completedTurns,
      toolCalls: turnResult.toolCalls,
      priorToolCalls,
      ...(cost !== undefined ? { cost } : {}),
    });

    if (decision.type === "stop") {
      appendMessage(messages, finalReplyMessage(turnResult.text));
      yield {
        type: "end",
        usage: totalUsage,
        turns: completedTurns,
        stopReason: decision.reason,
        ...(cost !== undefined ? { cost } : {}),
      };
      return;
    }

    if (decision.type === "summarize") {
      const interimReply = finalReplyMessage(turnResult.text);
      const wrapUpMessages: Message[] = [
        ...messages,
        ...(interimReply === null ? [] : [interimReply]),
        { role: "user", content: WRAP_UP_INSTRUCTION },
      ];
      const wrapUpTurn = yield* streamRecoverableAgentTurn({
        provider,
        systemPrompt,
        messages: wrapUpMessages,
        signal,
        allowBash,
        toolChoice: "none",
        textPrefix:
          turnResult.text === "" || turnResult.text.endsWith("\n") ? "" : "\n",
      });
      const summary =
        wrapUpTurn.text === "" ? MISSING_SUMMARY_NOTICE : wrapUpTurn.text;
      if (wrapUpTurn.text === "") {
        yield { type: "text", text: MISSING_SUMMARY_NOTICE };
      }
      appendMessage(
        messages,
        finalReplyMessage(`${turnResult.text}${summary}`),
      );
      totalUsage = addUsage(totalUsage, wrapUpTurn.usage);
      const finalCost = reportCost(totalUsage);
      yield {
        type: "end",
        usage: totalUsage,
        turns: completedTurns + 1,
        stopReason: decision.reason,
        ...(finalCost !== undefined ? { cost: finalCost } : {}),
      };
      return;
    }

    if (turnResult.toolCalls.length === 0) {
      appendMessage(messages, finalReplyMessage(turnResult.text));
      yield {
        type: "end",
        usage: totalUsage,
        turns: completedTurns,
        stopReason: "completed",
        ...(cost !== undefined ? { cost } : {}),
      };
      return;
    }

    messages.push(toolRequestMessage(turnResult));
    priorToolCalls.push(...turnResult.toolCalls);

    for (const toolCall of turnResult.toolCalls) {
      yield { type: "tool_start", toolCall };
      const execution = await executeToolCall({
        workspace,
        toolCall,
        signal,
        allowBash,
        ...(bashPermission !== undefined ? { bashPermission } : {}),
      });
      yield { type: "tool_end", toolCall, ok: execution.ok };
      messages.push({
        role: "tool",
        toolCallId: toolCall.id,
        content: execution.content,
      });
    }

    if (drainSteeringMessages !== undefined && !signal.aborted) {
      messages.push(...(await drainSteeringMessages()));
    }
  }
}

export async function* runAgent(
  options: RunAgentOptions,
): AsyncGenerator<AgentEvent> {
  const messages: Message[] = [{ role: "user", content: options.userMessage }];
  yield* runAgentTurn({
    workspace: options.workspace,
    provider: options.provider,
    messages,
    systemPrompt: options.systemPrompt,
    signal: options.signal,
    ...(options.costTracking !== undefined
      ? { costTracking: options.costTracking }
      : {}),
    ...(options.allowBash !== undefined
      ? { allowBash: options.allowBash }
      : {}),
    ...(options.bashPermission !== undefined
      ? { bashPermission: options.bashPermission }
      : {}),
    ...(options.stopPolicy !== undefined
      ? { stopPolicy: options.stopPolicy }
      : {}),
    ...(options.contextCompaction !== undefined
      ? { contextCompaction: options.contextCompaction }
      : {}),
  });
}
