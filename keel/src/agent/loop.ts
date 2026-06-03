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

    let receivedStop = false;
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
          receivedStop = true;
          totalUsage = {
            inputTokens: totalUsage.inputTokens + event.usage.inputTokens,
            outputTokens: totalUsage.outputTokens + event.usage.outputTokens,
          };
          break;
      }
    }

    if (!receivedStop) {
      throw new KeelError(
        "agent_missing_stop",
        "LLM stream ended without stop event",
      );
    }

    if (pendingToolCalls.length === 0) {
      yield { type: "end", usage: totalUsage };
      return;
    }

    messages.push({
      role: "assistant",
      content: assistantText.join(""),
      toolCalls: pendingToolCalls,
    });

    for (const toolCall of pendingToolCalls) {
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
  }

  throw new KeelError("agent_missing_stop", "Agent exceeded tool call limit");
}
