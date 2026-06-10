import { type CostModel, calculateCostUsd } from "../core/cost.ts";
import type { KeelErrorCode, RecoverableToolErrorCode } from "../core/error.ts";
import { KeelError } from "../core/error.ts";
import type { LLMProvider, Message, ToolCall, Usage } from "../llm/types.ts";
import { executeBash } from "../tools/bash.ts";
import { executeEdit } from "../tools/edit.ts";
import { executeGrep } from "../tools/grep.ts";
import { executeRead } from "../tools/read.ts";
import { executeWrite } from "../tools/write.ts";

const MAX_AGENT_TURNS = 16;

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
  readonly allowBash?: boolean;
}

interface AgentTurn {
  readonly text: string;
  readonly toolCalls: readonly ToolCall[];
  readonly usage: Usage;
}

interface ExecuteToolCallOptions {
  readonly workspace: string;
  readonly toolCall: ToolCall;
  readonly signal: AbortSignal;
  readonly allowBash: boolean;
}

interface RecoverableToolError extends KeelError {
  readonly code: RecoverableToolErrorCode;
  readonly recovery: string;
}

function addUsage(left: Usage, right: Usage): Usage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    uncachedInputTokens: left.uncachedInputTokens + right.uncachedInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
  };
}

function isRecoverableToolErrorCode(
  code: KeelErrorCode,
): code is RecoverableToolErrorCode {
  switch (code) {
    case "tool_binary_file":
    case "tool_file_exists":
    case "tool_file_not_found":
    case "tool_empty_command":
    case "tool_empty_old_string":
    case "tool_empty_pattern":
    case "tool_not_file":
    case "tool_not_directory":
    case "tool_old_string_not_found":
    case "tool_path_ignored":
    case "tool_path_outside_workspace":
      return true;
    default:
      return false;
  }
}

function isRecoverableToolError(error: unknown): error is RecoverableToolError {
  return error instanceof KeelError && isRecoverableToolErrorCode(error.code);
}

function toolFailureMessage(error: RecoverableToolError): string {
  return `Tool failed: ${error.message}\nRecovery: ${error.recovery}`;
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

async function executeToolCall(
  options: ExecuteToolCallOptions,
): Promise<string> {
  const { workspace, toolCall, signal, allowBash } = options;
  switch (toolCall.tool) {
    case "grep": {
      try {
        const result = await executeGrep(workspace, toolCall.pattern, {
          ...(toolCall.path !== undefined ? { path: toolCall.path } : {}),
          signal,
        });
        return result.content;
      } catch (error) {
        if (!isRecoverableToolError(error)) {
          throw error;
        }
        return toolFailureMessage(error);
      }
    }
    case "read": {
      try {
        const result = executeRead(workspace, toolCall.path, {
          offset: toolCall.offset,
          limit: toolCall.limit,
        });
        return result.content;
      } catch (error) {
        if (!isRecoverableToolError(error)) {
          throw error;
        }
        return toolFailureMessage(error);
      }
    }
    case "bash": {
      if (!allowBash) {
        return "Tool failed: bash failed: shell commands are disabled. Re-run with --allow-bash to enable them.";
      }

      try {
        const result = await executeBash(workspace, toolCall.command, {
          signal,
          ...(toolCall.timeoutMs !== undefined
            ? { timeoutMs: toolCall.timeoutMs }
            : {}),
        });
        return result.content;
      } catch (error) {
        if (!isRecoverableToolError(error)) {
          throw error;
        }
        return toolFailureMessage(error);
      }
    }
    case "edit": {
      try {
        const result = executeEdit(
          workspace,
          toolCall.path,
          toolCall.oldString,
          toolCall.newString,
        );
        return result.content;
      } catch (error) {
        if (!isRecoverableToolError(error)) {
          throw error;
        }
        return toolFailureMessage(error);
      }
    }
    case "write": {
      try {
        const result = executeWrite(workspace, toolCall.path, toolCall.content);
        return result.content;
      } catch (error) {
        if (!isRecoverableToolError(error)) {
          throw error;
        }
        return toolFailureMessage(error);
      }
    }
  }
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
    allowBash = false,
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
      ...(allowBash ? { allowBash: true } : {}),
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

    if (turnResult.toolCalls.length === 0) {
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
      toolCalls: turnResult.toolCalls,
    });

    for (const toolCall of turnResult.toolCalls) {
      const content = await executeToolCall({
        workspace,
        toolCall,
        signal,
        allowBash,
      });
      messages.push({
        role: "tool",
        toolCallId: toolCall.id,
        content,
      });
    }
  }

  throw new KeelError(
    "agent_tool_call_limit_exceeded",
    "Agent exceeded tool call limit",
  );
}
