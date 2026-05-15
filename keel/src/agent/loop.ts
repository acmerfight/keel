import type { LLMProvider, Usage } from "../llm/types.ts";

export type AgentEvent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "end"; readonly usage: Usage };

export interface RunAgentOptions {
  readonly provider: LLMProvider;
  readonly userMessage: string;
  readonly systemPrompt: string;
}

export async function* runAgent(
  options: RunAgentOptions,
): AsyncGenerator<AgentEvent> {
  const { provider, userMessage, systemPrompt } = options;

  let totalUsage: Usage = { inputTokens: 0, outputTokens: 0 };

  const stream = provider.stream({
    systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  });

  for await (const event of stream) {
    switch (event.type) {
      case "text":
        yield { type: "text", text: event.text };
        break;
      case "stop":
        totalUsage = {
          inputTokens: totalUsage.inputTokens + event.usage.inputTokens,
          outputTokens: totalUsage.outputTokens + event.usage.outputTokens,
        };
        break;
    }
  }

  yield { type: "end", usage: totalUsage };
}
