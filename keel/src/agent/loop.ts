import { type CostModel, calculateCostUsd } from "../core/cost.ts";
import type { KeelErrorCode, RecoverableToolErrorCode } from "../core/error.ts";
import { KeelError } from "../core/error.ts";
import type { LLMProvider, Message, ToolCall, Usage } from "../llm/types.ts";
import { executeBash } from "../tools/bash.ts";
import { executeEdit } from "../tools/edit.ts";
import { executeGrep } from "../tools/grep.ts";
import { executeRead } from "../tools/read.ts";
import { executeWrite } from "../tools/write.ts";
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

export type AgentEvent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "tool_start"; readonly toolCall: ToolCall }
  | {
      readonly type: "tool_end";
      readonly toolCall: ToolCall;
      readonly ok: boolean;
    }
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
  readonly stopPolicy?: AgentStopPolicy;
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

interface ToolExecution {
  readonly content: string;
  readonly ok: boolean;
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
    case "tool_invalid_pattern":
    case "tool_not_file":
    case "tool_not_directory":
    case "tool_old_string_not_found":
    case "tool_old_string_not_unique":
    case "tool_path_ignored":
    case "tool_path_outside_workspace":
    case "tool_read_offset_out_of_range":
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
}

async function* streamAgentTurn(
  options: StreamTurnOptions,
): AsyncGenerator<AgentEvent, AgentTurn> {
  const { provider, systemPrompt, messages, signal, allowBash } = options;
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

  for await (const event of stream) {
    switch (event.type) {
      case "text":
        assistantText.push(event.text);
        yield { type: "text", text: event.text };
        break;
      case "tool_call": {
        const { type: _llmEventType, ...toolCall } = event;
        pendingToolCalls.push(toolCall);
        break;
      }
      case "stop":
        usage = event.usage;
        break;
    }
  }

  return finishAgentTurn(assistantText, pendingToolCalls, usage);
}

async function executeToolCall(
  options: ExecuteToolCallOptions,
): Promise<ToolExecution> {
  const { workspace, toolCall, signal, allowBash } = options;
  switch (toolCall.tool) {
    case "grep": {
      try {
        const result = await executeGrep(workspace, toolCall.pattern, {
          ...(toolCall.path !== undefined ? { path: toolCall.path } : {}),
          signal,
        });
        return { content: result.content, ok: true };
      } catch (error) {
        if (!isRecoverableToolError(error)) {
          throw error;
        }
        return { content: toolFailureMessage(error), ok: false };
      }
    }
    case "read": {
      try {
        const result = executeRead(workspace, toolCall.path, {
          offset: toolCall.offset,
          limit: toolCall.limit,
        });
        return { content: result.content, ok: true };
      } catch (error) {
        if (!isRecoverableToolError(error)) {
          throw error;
        }
        return { content: toolFailureMessage(error), ok: false };
      }
    }
    case "bash": {
      if (!allowBash) {
        return {
          content:
            "Tool failed: bash failed: shell commands are disabled. Re-run with --allow-bash to enable them.",
          ok: false,
        };
      }

      try {
        const result = await executeBash(workspace, toolCall.command, {
          signal,
          ...(toolCall.timeoutMs !== undefined
            ? { timeoutMs: toolCall.timeoutMs }
            : {}),
        });
        return { content: result.content, ok: true };
      } catch (error) {
        if (!isRecoverableToolError(error)) {
          throw error;
        }
        return { content: toolFailureMessage(error), ok: false };
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
        return { content: result.content, ok: true };
      } catch (error) {
        if (!isRecoverableToolError(error)) {
          throw error;
        }
        return { content: toolFailureMessage(error), ok: false };
      }
    }
    case "write": {
      try {
        const result = executeWrite(workspace, toolCall.path, toolCall.content);
        return { content: result.content, ok: true };
      } catch (error) {
        if (!isRecoverableToolError(error)) {
          throw error;
        }
        return { content: toolFailureMessage(error), ok: false };
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
    stopPolicy = defaultStopPolicy(),
  } = options;
  const messages: Message[] = [{ role: "user", content: userMessage }];
  const priorToolCalls: ToolCall[] = [];
  let totalUsage: Usage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    uncachedInputTokens: 0,
    outputTokens: 0,
  };

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

  for (let completedTurns = 1; ; completedTurns++) {
    const turnResult = yield* streamAgentTurn({
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
      yield {
        type: "end",
        usage: totalUsage,
        ...(cost !== undefined ? { cost } : {}),
      };
      return;
    }

    if (decision.type === "summarize") {
      // The over-limit turn's tool calls are dropped and never executed, so
      // the assistant message that requested them (and would expect tool
      // results) must not enter the transcript. Its streamed text already
      // reached the user, so keep that text as a plain assistant message.
      const wrapUpTurn = yield* streamAgentTurn({
        provider,
        systemPrompt,
        messages: [
          ...messages,
          ...(turnResult.text === ""
            ? []
            : [{ role: "assistant", content: turnResult.text } as const]),
          { role: "user", content: WRAP_UP_INSTRUCTION },
        ],
        signal,
        allowBash,
        toolChoice: "none",
      });
      if (wrapUpTurn.text === "") {
        yield { type: "text", text: MISSING_SUMMARY_NOTICE };
      }
      totalUsage = addUsage(totalUsage, wrapUpTurn.usage);
      const finalCost = reportCost(totalUsage);
      yield {
        type: "end",
        usage: totalUsage,
        ...(finalCost !== undefined ? { cost: finalCost } : {}),
      };
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
    priorToolCalls.push(...turnResult.toolCalls);

    for (const toolCall of turnResult.toolCalls) {
      yield { type: "tool_start", toolCall };
      const execution = await executeToolCall({
        workspace,
        toolCall,
        signal,
        allowBash,
      });
      yield { type: "tool_end", toolCall, ok: execution.ok };
      messages.push({
        role: "tool",
        toolCallId: toolCall.id,
        content: execution.content,
      });
    }
  }
}
