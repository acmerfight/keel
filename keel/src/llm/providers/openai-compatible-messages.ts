import {
  openAICompatibleTools,
  toolCallArguments,
} from "../../tools/registry.ts";
import type { Message, StreamOptions } from "../types.ts";

export function createChatCompletionsBody(
  model: string,
  options: StreamOptions,
): string {
  const tools = openAICompatibleTools(options.allowBash === true);

  return JSON.stringify({
    model,
    stream: true,
    stream_options: { include_usage: true },
    ...(options.toolChoice === "none" ? {} : { tools, tool_choice: "auto" }),
    messages: [
      { role: "system", content: options.systemPrompt },
      ...options.messages.map(toOpenAICompatibleMessage),
    ],
  });
}

function toOpenAICompatibleMessage(message: Message): Record<string, unknown> {
  switch (message.role) {
    case "user":
      return { role: "user", content: message.content };
    case "assistant": {
      const toolCalls = message.toolCalls?.map((toolCall) => ({
        id: toolCall.id,
        type: "function",
        function: {
          name: toolCall.tool,
          arguments: JSON.stringify(toolCallArguments(toolCall)),
        },
      }));
      return {
        role: "assistant",
        content:
          toolCalls && toolCalls.length > 0 && message.content === ""
            ? null
            : message.content,
        ...(toolCalls && toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      };
    }
    case "tool":
      return {
        role: "tool",
        tool_call_id: message.toolCallId,
        content: message.content,
      };
  }
}
