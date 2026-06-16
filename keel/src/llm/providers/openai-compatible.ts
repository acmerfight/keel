import type { LLMEvent, LLMProvider } from "../types.ts";
import { createChatCompletionsBody } from "./openai-compatible-messages.ts";
import {
  type ProviderConfig,
  requestChatCompletions,
} from "./openai-compatible-retry.ts";
import {
  createStreamState,
  finalStreamEvents,
  getResponseReader,
  type OpenAICompatibleStreamConfig,
  readSseEvents,
} from "./openai-compatible-sse.ts";

export type { ProviderRetryConfig } from "./openai-compatible-retry.ts";
export type {
  OpenAICompatibleChoice,
  OpenAICompatibleChunk,
  OpenAICompatibleStreamState,
} from "./openai-compatible-sse.ts";

interface OpenAICompatibleProviderConfig extends OpenAICompatibleStreamConfig {
  readonly id: string;
  readonly config: ProviderConfig;
}

export function createOpenAICompatibleProvider(
  providerConfig: OpenAICompatibleProviderConfig,
): LLMProvider {
  return {
    id: providerConfig.id,
    async *stream(options): AsyncIterable<LLMEvent> {
      const body = createChatCompletionsBody(
        providerConfig.config.model,
        options,
      );
      const response = yield* requestChatCompletions(
        providerConfig.config,
        body,
        options.signal,
        providerConfig.providerName,
      );
      const reader = getResponseReader(response, providerConfig.providerName);
      const state = createStreamState();

      yield* readSseEvents(reader, options.signal, state, providerConfig);
      for (const event of finalStreamEvents(
        state,
        providerConfig.providerName,
      )) {
        yield event;
      }
    },
  };
}
