import { KeelError } from "../core/error.ts";
import type { LLMProvider, Message, ToolCall, Usage } from "../llm/types.ts";
import { executeEdit } from "../tools/edit.ts";
import { executeRead } from "../tools/read.ts";

export type AgentEvent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "end"; readonly usage: Usage };

export interface RunAgentOptions {
  readonly workspace: string;
  readonly provider: LLMProvider;
  readonly userMessage: string;
  readonly systemPrompt: string;
  readonly signal: AbortSignal;
}

interface AgentTurn {
  readonly text: string;
  readonly toolCall: ToolCall | null;
  readonly usage: Usage;
}

function addUsage(left: Usage, right: Usage): Usage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
  };
}

function finishAgentTurn(
  assistantText: readonly string[],
  pendingToolCalls: readonly ToolCall[],
  usage: Usage | null,
): AgentTurn {
  if (!usage) {
    throw new KeelError(
      "agent_missing_stop",
      "LLM stream ended without stop event",
    );
  }

  const [toolCall, extraToolCall] = pendingToolCalls;
  if (extraToolCall) {
    throw new KeelError(
      "agent_unsupported_tool_calls",
      "Keel does not support multiple tool calls in one turn",
    );
  }

  return {
    text: assistantText.join(""),
    toolCall: toolCall ?? null,
    usage,
  };
}

export async function* runAgent(
  options: RunAgentOptions,
): AsyncGenerator<AgentEvent> {
  const { workspace, provider, userMessage, systemPrompt, signal } = options;
  const messages: Message[] = [{ role: "user", content: userMessage }];
  let totalUsage: Usage = { inputTokens: 0, outputTokens: 0 };

  for (let turn = 0; turn < 8; turn++) {
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

    const toolCall = turnResult.toolCall;
    if (!toolCall) {
      yield { type: "end", usage: totalUsage };
      return;
    }

    messages.push({
      role: "assistant",
      content: turnResult.text,
      toolCalls: [toolCall],
    });

    switch (toolCall.tool) {
      case "read": {
        const result = executeRead(workspace, toolCall.path, {
          offset: toolCall.offset,
          limit: toolCall.limit,
        });
        messages.push({
          role: "tool",
          toolCallId: toolCall.id,
          content: result.content,
        });
        break;
      }
      case "edit": {
        const result = executeEdit(
          workspace,
          toolCall.path,
          toolCall.oldString,
          toolCall.newString,
        );
        messages.push({
          role: "tool",
          toolCallId: toolCall.id,
          content: result.content,
        });
        yield { type: "text", text: result.content };
        yield { type: "end", usage: totalUsage };
        return;
      }
    }
  }

  throw new KeelError("agent_missing_stop", "Agent exceeded tool call limit");
}
