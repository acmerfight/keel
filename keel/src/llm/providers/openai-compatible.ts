import { KeelError } from "../../core/error.ts";
import type { LLMEvent, LLMProvider } from "../types.ts";
import { createChatCompletionsBody } from "./openai-compatible-messages.ts";
import {
  type ProviderConfig,
  ProviderRetryController,
  requestChatCompletions,
  waitForProviderRetry,
} from "./openai-compatible-retry.ts";
import {
  createStreamState,
  finalStreamEvents,
  getResponseReader,
  isMissingDoneSignalError,
  type OpenAICompatibleChunk,
  type OpenAICompatibleStreamConfig,
  readSseEvents,
} from "./openai-compatible-sse.ts";

export type { ProviderRetryConfig } from "./openai-compatible-retry.ts";
export type {
  OpenAICompatibleChunk,
  OpenAICompatibleStreamState,
} from "./openai-compatible-sse.ts";

interface OpenAICompatibleProviderConfig<Chunk extends OpenAICompatibleChunk>
  extends OpenAICompatibleStreamConfig<Chunk> {
  readonly id: string;
  readonly config: ProviderConfig;
}

function isRetryablePreOutputStreamError(
  error: KeelError,
): error is KeelError & {
  readonly code: "provider_network_error" | "provider_protocol_error";
} {
  if (error.code === "provider_network_error") {
    return true;
  }
  return isMissingDoneSignalError(error);
}

export function createOpenAICompatibleProvider<
  Chunk extends OpenAICompatibleChunk,
>(providerConfig: OpenAICompatibleProviderConfig<Chunk>): LLMProvider {
  return {
    id: providerConfig.id,
    async *stream(options): AsyncIterable<LLMEvent> {
      const body = createChatCompletionsBody(
        providerConfig.config.model,
        options,
      );
      const retry = new ProviderRetryController(providerConfig.config.retry);

      for (;;) {
        let emittedAssistantOutput = false;
        const response = yield* requestChatCompletions(
          providerConfig.config,
          body,
          options.signal,
          providerConfig.providerName,
          retry,
        );
        try {
          const reader = getResponseReader(
            response,
            providerConfig.providerName,
          );
          const state = createStreamState();

          for await (const event of readSseEvents(
            reader,
            options.signal,
            state,
            providerConfig,
          )) {
            emittedAssistantOutput = true;
            yield event;
          }
          for (const event of finalStreamEvents(
            state,
            providerConfig.providerName,
          )) {
            if (event.type === "tool_call") {
              emittedAssistantOutput = true;
            }
            yield event;
          }
          return;
        } catch (error) {
          /* v8 ignore next 3: supported stream helpers normalize expected failures to KeelError; preserve unexpected bugs. */
          if (!(error instanceof KeelError)) {
            throw error;
          }
          if (
            emittedAssistantOutput ||
            !isRetryablePreOutputStreamError(error)
          ) {
            throw error;
          }
          const decision = retry.transportDecision(error.code);
          if (decision === null) {
            throw error;
          }
          yield* waitForProviderRetry(
            retry,
            providerConfig.providerName,
            options.signal,
            decision,
          );
        }
      }
    },
  };
}
