import { KeelError } from "../core/error.ts";
import type { LLMEvent, LLMProvider, Usage } from "../llm/types.ts";
import { executeEdit } from "../tools/edit.ts";

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

  const stream = provider.stream({
    systemPrompt,
    messages: [{ role: "user", content: userMessage }],
    signal,
  });

  let receivedStop = false;
  let totalUsage: Usage = { inputTokens: 0, outputTokens: 0 };
  const pendingToolCalls: Extract<LLMEvent, { readonly type: "tool_call" }>[] =
    [];

  for await (const event of stream) {
    switch (event.type) {
      case "text":
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

  for (const toolCall of pendingToolCalls) {
    const result = executeEdit(
      workspace,
      toolCall.path,
      toolCall.oldString,
      toolCall.newString,
    );
    yield { type: "text", text: result.content };
  }

  yield { type: "end", usage: totalUsage };
}
