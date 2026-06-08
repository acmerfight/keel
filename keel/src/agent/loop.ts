import { type CostModel, calculateCostUsd } from "../core/cost.ts";
import type { KeelErrorCode } from "../core/error.ts";
import { KeelError } from "../core/error.ts";
import type { LLMProvider, Message, ToolCall, Usage } from "../llm/types.ts";
import { executeEdit } from "../tools/edit.ts";
import { executeGrep } from "../tools/grep.ts";
import { executeRead } from "../tools/read.ts";

const MAX_AGENT_TURNS = 8;
const RECOVERABLE_TOOL_ERRORS = new Set<KeelErrorCode>([
  "tool_file_not_found",
  "tool_empty_pattern",
  "tool_not_file",
  "tool_old_string_not_found",
  "tool_path_ignored",
  "tool_path_outside_workspace",
]);

export interface CostReport {
  readonly spentUsd: number;
  readonly maxUsd?: number;
  readonly budgetExceeded: boolean;
}

export interface CostTrackingOptions {
  readonly model: CostModel;
  readonly maxCostUsd?: number;
}

export type AgentEvent =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "end";
      readonly usage: Usage;
      readonly cost?: CostReport;
    };

export interface RunAgentOptions {
  readonly workspace: string;
  readonly provider: LLMProvider;
  readonly userMessage: string;
  readonly systemPrompt: string;
  readonly signal: AbortSignal;
  readonly costTracking?: CostTrackingOptions;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecoverableToolError(error: unknown): boolean {
  return error instanceof KeelError && RECOVERABLE_TOOL_ERRORS.has(error.code);
}

function toolFailureMessage(error: unknown): string {
  return `Tool failed: ${errorMessage(error)}`;
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

function singleToolCall(toolCalls: readonly ToolCall[]): ToolCall | null {
  const [toolCall, extraToolCall] = toolCalls;
  if (extraToolCall !== undefined) {
    throw new KeelError(
      "agent_unsupported_tool_calls",
      "Keel does not support multiple tool calls in one turn",
    );
  }
  return toolCall ?? null;
}

export async function* runAgent(
  options: RunAgentOptions,
): AsyncGenerator<AgentEvent> {
  const {
    workspace,
    provider,
    userMessage,
    systemPrompt,
    signal,
    costTracking,
  } = options;
  const messages: Message[] = [{ role: "user", content: userMessage }];
  let totalUsage: Usage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    uncachedInputTokens: 0,
    outputTokens: 0,
  };

  for (let turn = 0; turn < MAX_AGENT_TURNS; turn++) {
    const stream = provider.stream({
      systemPrompt,
      messages,
      signal,
    });

    let usage: Usage | null = null;
    const assistantText: string[] = [];
    const pendingToolCalls: ToolCall[] = [];

    for await (const event of stream) {
      switch (event.type) {
        case "text":
          assistantText.push(event.text);
          yield { type: "text", text: event.text };
          break;
        case "tool_call":
          pendingToolCalls.push(event);
          break;
        case "stop":
          usage = event.usage;
          break;
      }
    }

    const turnResult = finishAgentTurn(assistantText, pendingToolCalls, usage);
    totalUsage = addUsage(totalUsage, turnResult.usage);
    const cost =
      costTracking === undefined
        ? undefined
        : (() => {
            const spentUsd = calculateCostUsd(totalUsage, costTracking.model);
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
          })();

    if (cost?.budgetExceeded === true) {
      yield { type: "end", usage: totalUsage, cost };
      return;
    }

    const toolCall = singleToolCall(turnResult.toolCalls);
    if (toolCall === null) {
      yield {
        type: "end",
        usage: totalUsage,
        ...(cost !== undefined ? { cost } : {}),
      };
      return;
    }

    messages.push({
      role: "assistant",
      content: turnResult.text,
      toolCalls: [toolCall],
    });

    switch (toolCall.tool) {
      case "grep": {
        let result: { readonly content: string };
        try {
          result = await executeGrep(workspace, toolCall.pattern, {
            ...(toolCall.path !== undefined ? { path: toolCall.path } : {}),
            signal,
          });
        } catch (error) {
          if (!isRecoverableToolError(error)) {
            throw error;
          }
          messages.push({
            role: "tool",
            toolCallId: toolCall.id,
            content: toolFailureMessage(error),
          });
          break;
        }

        messages.push({
          role: "tool",
          toolCallId: toolCall.id,
          content: result.content,
        });
        break;
      }
      case "read": {
        let result: { readonly content: string };
        try {
          result = executeRead(workspace, toolCall.path, {
            offset: toolCall.offset,
            limit: toolCall.limit,
          });
        } catch (error) {
          if (!isRecoverableToolError(error)) {
            throw error;
          }
          messages.push({
            role: "tool",
            toolCallId: toolCall.id,
            content: toolFailureMessage(error),
          });
          break;
        }

        messages.push({
          role: "tool",
          toolCallId: toolCall.id,
          content: result.content,
        });
        break;
      }
      case "edit": {
        let result: { readonly content: string };
        try {
          result = executeEdit(
            workspace,
            toolCall.path,
            toolCall.oldString,
            toolCall.newString,
          );
        } catch (error) {
          if (!isRecoverableToolError(error)) {
            throw error;
          }
          messages.push({
            role: "tool",
            toolCallId: toolCall.id,
            content: toolFailureMessage(error),
          });
          break;
        }

        messages.push({
          role: "tool",
          toolCallId: toolCall.id,
          content: result.content,
        });
        yield { type: "text", text: result.content };
        yield {
          type: "end",
          usage: totalUsage,
          ...(cost !== undefined ? { cost } : {}),
        };
        return;
      }
    }
  }

  throw new KeelError(
    "agent_tool_call_limit_exceeded",
    "Agent exceeded tool call limit",
  );
}
