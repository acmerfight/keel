import { z } from "zod";
import { KeelError, type KeelErrorCode } from "../../core/error.ts";
import type { LLMEvent, LLMProvider, StreamOptions, Usage } from "../types.ts";

const editTool = {
  type: "function",
  function: {
    name: "edit",
    description: "Replace one exact string in a workspace file.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative file path to edit.",
        },
        oldString: {
          type: "string",
          description: "Exact text to replace. Must appear exactly once.",
        },
        newString: {
          type: "string",
          description: "Replacement text.",
        },
      },
      required: ["path", "oldString", "newString"],
      additionalProperties: false,
    },
  },
};

const editToolArgumentsSchema = z
  .object({
    path: z.string(),
    oldString: z.string(),
    newString: z.string(),
  })
  .strict();

const deepseekToolCallSchema = z
  .object({
    index: z.number().optional(),
    function: z
      .object({
        name: z.string().optional(),
        arguments: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const deepseekChoiceSchema = z
  .object({
    delta: z
      .object({
        // DeepSeek emits content: null while streaming reasoning_content.
        content: z.string().nullable().optional(),
        tool_calls: z.array(deepseekToolCallSchema).optional(),
      })
      .passthrough()
      .optional(),
    finish_reason: z.string().nullable().optional(),
  })
  .passthrough();

const deepseekStreamChunkSchema = z
  .object({
    choices: z.array(deepseekChoiceSchema).optional(),
    // Some OpenAI-compatible streams emit usage: null on non-final chunks.
    // Accept it here; the stream still requires real usage before stop.
    usage: z
      .object({
        prompt_tokens: z.number(),
        completion_tokens: z.number(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough()
  .refine((chunk) => chunk.choices !== undefined || chunk.usage !== undefined);

export interface DeepseekConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
}

function httpErrorCode(status: number): KeelErrorCode {
  if (status === 401 || status === 403) return "provider_auth_failed";
  if (status === 429) return "provider_rate_limited";
  if (status >= 500) return "provider_server_error";
  return "provider_http_error";
}

function isAbortError(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  return error instanceof Error && error.name === "AbortError";
}

function transportError(
  error: unknown,
  signal: AbortSignal,
  message: string,
): KeelError {
  if (error instanceof KeelError) return error;
  if (isAbortError(error, signal)) {
    return new KeelError("provider_aborted", "DeepSeek request was aborted");
  }
  return new KeelError("provider_network_error", message);
}

export function createDeepseekProvider(config: DeepseekConfig): LLMProvider {
  const { baseUrl, model } = config;

  return {
    id: "deepseek",
    async *stream(options: StreamOptions): AsyncIterable<LLMEvent> {
      const body = JSON.stringify({
        model,
        stream: true,
        stream_options: { include_usage: true },
        tools: [editTool],
        tool_choice: "auto",
        messages: [
          { role: "system", content: options.systemPrompt },
          ...options.messages.map((m) => ({
            role: m.role,
            content: m.content,
          })),
        ],
      });

      let response: Response;
      try {
        response = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.apiKey}`,
          },
          body,
          signal: options.signal,
        });
      } catch (error) {
        throw transportError(
          error,
          options.signal,
          "DeepSeek request failed before response",
        );
      }

      if (!response.ok) {
        const text = await response.text();
        throw new KeelError(
          httpErrorCode(response.status),
          `DeepSeek API error (${response.status}): ${text}`,
        );
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new KeelError(
          "provider_protocol_error",
          "DeepSeek API returned no response body",
        );
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let usage: Usage | null = null;
      let receivedDone = false;
      let finishReason: string | undefined;
      let toolCallName: string | null = null;
      let toolCallArguments = "";
      let pendingToolCall: Extract<
        LLMEvent,
        { readonly type: "tool_call" }
      > | null = null;

      function parseEditToolCall(): Extract<
        LLMEvent,
        { readonly type: "tool_call" }
      > {
        if (toolCallName !== "edit") {
          throw new KeelError(
            "provider_protocol_error",
            `DeepSeek returned unsupported tool call: ${toolCallName ?? "none"}`,
          );
        }

        let parsedArguments: unknown;
        try {
          parsedArguments = JSON.parse(toolCallArguments);
        } catch {
          throw new KeelError(
            "provider_protocol_error",
            "DeepSeek edit tool call has invalid JSON arguments",
          );
        }

        const result = editToolArgumentsSchema.safeParse(parsedArguments);
        if (!result.success) {
          throw new KeelError(
            "provider_protocol_error",
            "DeepSeek edit tool call has invalid arguments",
          );
        }

        return {
          type: "tool_call",
          tool: "edit",
          path: result.data.path,
          oldString: result.data.oldString,
          newString: result.data.newString,
        };
      }

      function* parseLine(line: string): Generator<LLMEvent> {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) return;

        const data = trimmed.slice(6);
        if (data === "[DONE]") {
          receivedDone = true;
          return;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          throw new KeelError(
            "provider_protocol_error",
            "DeepSeek stream chunk has invalid JSON",
          );
        }
        const result = deepseekStreamChunkSchema.safeParse(parsed);
        if (!result.success) {
          throw new KeelError(
            "provider_protocol_error",
            "DeepSeek stream chunk has invalid schema",
          );
        }

        const chunk = result.data;
        const choice = chunk.choices?.[0];

        if (choice) {
          const content = choice.delta?.content;
          if (content) {
            yield { type: "text", text: content };
          }
          const toolCalls = choice.delta?.tool_calls ?? [];
          if (toolCalls.length > 1) {
            throw new KeelError(
              "provider_protocol_error",
              "DeepSeek returned more than one tool call",
            );
          }
          const toolCall = toolCalls[0];
          if (toolCall) {
            if (toolCall.index !== 0) {
              throw new KeelError(
                "provider_protocol_error",
                `DeepSeek returned unsupported tool call index: ${toolCall.index ?? "none"}`,
              );
            }
            const toolFunction = toolCall.function;
            if (toolFunction?.name) {
              toolCallName = toolFunction.name;
            }
            if (toolFunction?.arguments) {
              toolCallArguments += toolFunction.arguments;
            }
          }
          if (choice.finish_reason) {
            finishReason = choice.finish_reason;
            if (choice.finish_reason === "tool_calls") {
              if (pendingToolCall !== null) {
                throw new KeelError(
                  "provider_protocol_error",
                  "DeepSeek returned more than one tool call",
                );
              }
              pendingToolCall = parseEditToolCall();
            }
          }
        }

        if (chunk.usage) {
          usage = {
            inputTokens: chunk.usage.prompt_tokens,
            outputTokens: chunk.usage.completion_tokens,
          };
        }
      }

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            for (const event of parseLine(line)) {
              yield event;
            }
          }
        }

        buffer += decoder.decode();
        if (buffer.trim() !== "") {
          for (const event of parseLine(buffer)) {
            yield event;
          }
        }
      } catch (error) {
        throw transportError(error, options.signal, "DeepSeek stream failed");
      } finally {
        reader.releaseLock();
      }

      if (!receivedDone) {
        throw new KeelError(
          "provider_protocol_error",
          "DeepSeek stream ended without [DONE] signal",
        );
      }

      if (finishReason === "tool_calls") {
        if (pendingToolCall === null) {
          throw new KeelError(
            "provider_protocol_error",
            "DeepSeek stream finished with tool_calls but no tool call",
          );
        }
      } else if (finishReason !== "stop") {
        throw new KeelError(
          "provider_protocol_error",
          `DeepSeek stream finished with reason: ${finishReason ?? "none"}`,
        );
      }

      if (usage === null) {
        throw new KeelError(
          "provider_protocol_error",
          "DeepSeek stream ended without usage",
        );
      }

      if (pendingToolCall !== null) {
        yield pendingToolCall;
      }
      yield { type: "stop", usage };
    },
  };
}
