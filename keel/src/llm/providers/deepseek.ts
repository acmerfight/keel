import type { LLMEvent, LLMProvider, StreamOptions } from "../types.ts";

export interface DeepseekConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
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
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`DeepSeek API error (${response.status}): ${text}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("DeepSeek API returned no response body");
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let inputTokens = 0;
      let outputTokens = 0;
      let receivedDone = false;
      let finishReason: string | undefined;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed?.startsWith("data: ")) continue;

            const data = trimmed.slice(6);
            if (data === "[DONE]") {
              receivedDone = true;
              continue;
            }

            const chunk = JSON.parse(data);
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
              inputTokens = chunk.usage.prompt_tokens ?? 0;
              outputTokens = chunk.usage.completion_tokens ?? 0;
            }
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

      yield { type: "stop", usage: { inputTokens, outputTokens } };
    },
  };
}
