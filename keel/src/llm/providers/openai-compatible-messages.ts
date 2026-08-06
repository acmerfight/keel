import {
  openAICompatibleTools,
  toolCallArguments,
} from "../../tools/tool-call.ts";
import type { ProviderMessage, StreamOptions } from "../types.ts";

export interface OpenAICompatibleMessageOptions {
  readonly assistantReasoningContent?: "omit" | "require";
  readonly maxOutputTokensField?: "max_completion_tokens" | "max_tokens";
}

export function createChatCompletionsBody(
  model: string,
  options: StreamOptions,
  messageOptions: OpenAICompatibleMessageOptions = {},
): string {
  const toolExposure = options.toolExposure ?? { kind: "auto" };
  const tools = openAICompatibleTools(toolExposure);

  return JSON.stringify({
    model,
    stream: true,
    stream_options: { include_usage: true },
    ...(options.maxOutputTokens !== undefined
      ? {
          [messageOptions.maxOutputTokensField ?? "max_tokens"]:
            options.maxOutputTokens,
        }
      : {}),
    ...(toolExposure.kind === "none" ? {} : { tools, tool_choice: "auto" }),
    messages: [
      { role: "system", content: options.systemPrompt },
      ...options.messages.map((message) =>
        toOpenAICompatibleMessage(message, messageOptions),
      ),
    ],
  });
}

function assistantReasoningContent(
  message: Extract<ProviderMessage, { readonly role: "assistant" }>,
  options: OpenAICompatibleMessageOptions,
): string | undefined {
  if (
    options.assistantReasoningContent === undefined ||
    options.assistantReasoningContent === "omit"
  ) {
    return undefined;
  }
  const reasoningContent =
    message.providerMetadata?.openaiCompatible.reasoningContent;
  if (reasoningContent !== undefined) {
    return reasoningContent;
  }
  return "";
}

function toOpenAICompatibleMessage(
  message: ProviderMessage,
  options: OpenAICompatibleMessageOptions,
): Record<string, unknown> {
  switch (message.role) {
    case "user":
      return { role: "user", content: message.content };
    case "assistant": {
      const toolCalls = message.toolCalls.map((toolCall) => ({
        id: toolCall.id,
        type: "function",
        function: {
          name: toolCall.tool,
          arguments: JSON.stringify(toolCallArguments(toolCall)),
        },
      }));
      const reasoningContent = assistantReasoningContent(message, options);
      return {
        role: "assistant",
        content:
          toolCalls.length > 0 && message.content === ""
            ? null
            : message.content,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        ...(reasoningContent !== undefined
          ? { reasoning_content: reasoningContent }
          : {}),
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
