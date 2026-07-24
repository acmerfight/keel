import { KeelError } from "../../core/error.ts";
import type {
  LLMEvent,
  LLMProvider,
  ProviderRequestAttemptFinish,
} from "../types.ts";
import {
  createChatCompletionsBody,
  type OpenAICompatibleMessageOptions,
} from "./openai-compatible-messages.ts";
import {
  type ProviderConfig,
  ProviderRetryController,
  requestChatCompletions,
  requestRetryDecisionForReport,
  resolveProviderLivenessConfig,
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

export type {
  ProviderLivenessConfig,
  ProviderRetryConfig,
} from "./openai-compatible-retry.ts";
export type {
  OpenAICompatibleChunk,
  OpenAICompatibleStreamState,
} from "./openai-compatible-sse.ts";

interface OpenAICompatibleProviderConfig<Chunk extends OpenAICompatibleChunk>
  extends OpenAICompatibleStreamConfig<Chunk> {
  readonly id: string;
  readonly config: ProviderConfig;
  readonly messageOptions?: OpenAICompatibleMessageOptions;
}

function isRetryablePreOutputStreamError(
  error: KeelError,
): error is KeelError & {
  readonly code:
    | "provider_network_error"
    | "provider_protocol_error"
    | "stream_inactivity_timeout";
} {
  if (
    error.code === "provider_network_error" ||
    error.code === "stream_inactivity_timeout"
  ) {
    return true;
  }
  return isMissingDoneSignalError(error);
}

function terminalAttemptOutcome(
  error: KeelError,
): "terminal_error" | "aborted" {
  return error.code === "provider_aborted" ? "aborted" : "terminal_error";
}

export function createOpenAICompatibleProvider<
  Chunk extends OpenAICompatibleChunk,
>(providerConfig: OpenAICompatibleProviderConfig<Chunk>): LLMProvider {
  return {
    id: providerConfig.id,
    estimateInputTokens(options): number {
      // All enrolled providers use byte-based tokenizers. Counting the complete
      // serialized request bytes intentionally over-reserves protocol fields,
      // JSON escaping, and tool schemas instead of underpricing prompt text.
      return new TextEncoder().encode(
        createChatCompletionsBody(
          providerConfig.config.model,
          options,
          providerConfig.messageOptions,
        ),
      ).length;
    },
    async *stream(options): AsyncIterable<LLMEvent> {
      const body = (): string =>
        createChatCompletionsBody(
          providerConfig.config.model,
          {
            ...options,
            systemPrompt:
              options.requestSystemPrompt?.() ?? options.systemPrompt,
          },
          providerConfig.messageOptions,
        );
      const retry = new ProviderRetryController(providerConfig.config.retry);
      const liveness = resolveProviderLivenessConfig(
        providerConfig.config.liveness,
      );

      for (;;) {
        let emittedAssistantOutput = false;
        const response = yield* requestChatCompletions(
          providerConfig.config,
          body,
          options.signal,
          providerConfig.providerName,
          retry,
          options.providerRequestAttempts ?? null,
        );
        let attemptFinished = false;
        const finishAttempt = (result: ProviderRequestAttemptFinish): void => {
          if (response.attempt === null || attemptFinished) {
            return;
          }
          attemptFinished = true;
          response.attempt.finish(result);
        };
        const state = createStreamState();
        try {
          const reader = getResponseReader(
            response.response,
            providerConfig.providerName,
          );

          for await (const event of readSseEvents(
            reader,
            options.signal,
            state,
            providerConfig,
            {
              timeoutMs: liveness.streamInactivityTimeoutMs,
              abort: response.abortForStreamInactivity,
              timedOut: response.streamInactivityTimedOut,
            },
          )) {
            emittedAssistantOutput = true;
            yield event;
          }
          const finalStream = finalStreamEvents(
            state,
            providerConfig.providerName,
          );
          finishAttempt({
            outcome: "completed",
            usage: finalStream.usage,
          });
          for (const event of finalStream.events) {
            if (event.type === "tool_call") {
              emittedAssistantOutput = true;
            }
            yield event;
          }
          return;
        } catch (error) {
          if (!(error instanceof KeelError)) {
            finishAttempt({
              outcome: "terminal_error",
              errorCode: "provider_unexpected_error",
            });
            throw error;
          }
          if (
            emittedAssistantOutput ||
            (error.code === "stream_inactivity_timeout" &&
              state.hasAssistantOutput) ||
            !isRetryablePreOutputStreamError(error)
          ) {
            const outcome = terminalAttemptOutcome(error);
            finishAttempt(
              outcome === "aborted"
                ? { outcome }
                : { outcome, errorCode: error.code },
            );
            throw error;
          }
          const decision = retry.transportDecision(error.code);
          if (decision === null) {
            finishAttempt({
              outcome: "terminal_error",
              errorCode: error.code,
            });
            throw error;
          }
          finishAttempt({
            outcome: "retryable_error",
            retryDecision: requestRetryDecisionForReport(
              providerConfig.providerName,
              decision,
            ),
          });
          yield* waitForProviderRetry(
            retry,
            providerConfig.providerName,
            options.signal,
            decision,
          );
        } finally {
          response.close();
          finishAttempt(
            options.signal.aborted
              ? { outcome: "aborted" }
              : {
                  outcome: "terminal_error",
                  errorCode: "provider_consumer_closed",
                },
          );
        }
      }
    },
  };
}
