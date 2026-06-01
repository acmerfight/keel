import { z } from "zod";
import { KeelError, type KeelErrorCode } from "../../core/error.ts";
import type { LLMEvent, LLMProvider, StreamOptions, Usage } from "../types.ts";

const deepseekChoiceSchema = z
  .object({
    delta: z
      .object({
        content: z.string().optional(),
      })
      .passthrough()
      .optional(),
    finish_reason: z.string().nullable().optional(),
  })
  .passthrough();

const deepseekStreamChunkSchema = z
  .object({
    choices: z.array(deepseekChoiceSchema).optional(),
    usage: z
      .object({
        prompt_tokens: z.number(),
        completion_tokens: z.number(),
      })
      .passthrough()
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

export function createDeepseekProvider(config: DeepseekConfig): LLMProvider {
  const { baseUrl, model } = config;

  return {
    id: "deepseek",
    async *stream(options: StreamOptions): AsyncIterable<LLMEvent> {
      const body = JSON.stringify({
        model,
        stream: true,
        stream_options: { include_usage: true },
        messages: [
          { role: "system", content: options.systemPrompt },
          ...options.messages.map((m) => ({
            role: m.role,
            content: m.content,
          })),
        ],
      });

      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body,
        signal: options.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new KeelError(
          httpErrorCode(response.status),
          `DeepSeek API error (${response.status}): ${text}`,
        );
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("DeepSeek API returned no response body");
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let usage: Usage | null = null;
      let receivedDone = false;
      let finishReason: string | undefined;

      function* parseLine(line: string): Generator<LLMEvent> {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) return;

        const data = trimmed.slice(6);
        if (data === "[DONE]") {
          receivedDone = true;
          return;
        }

        const parsed: unknown = JSON.parse(data);
        const result = deepseekStreamChunkSchema.safeParse(parsed);
        if (!result.success) {
          throw new Error("DeepSeek stream chunk has invalid schema");
        }

        const chunk = result.data;
        const choice = chunk.choices?.[0];

        if (choice) {
          const content = choice.delta?.content;
          if (content) {
            yield { type: "text", text: content };
          }
          if (choice.finish_reason) {
            finishReason = choice.finish_reason;
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
      } finally {
        reader.releaseLock();
      }

      if (!receivedDone) {
        throw new Error("DeepSeek stream ended without [DONE] signal");
      }

      if (finishReason !== "stop") {
        throw new Error(
          `DeepSeek stream finished with reason: ${finishReason ?? "none"}`,
        );
      }

      if (usage === null) {
        throw new Error("DeepSeek stream ended without usage");
      }

      yield { type: "stop", usage };
    },
  };
}
