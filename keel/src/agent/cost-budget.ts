import {
  type CostModel,
  calculateConservativeRequestCostUsd,
  calculateRequestCostBatchUsd,
  maxAffordableOutputTokens,
} from "../core/cost.ts";
import type {
  LLMProvider,
  ProviderMessage,
  ProviderRequestAttemptHandle,
  ProviderRequestAttemptObserver,
  StreamOptions,
  ToolCall,
  Usage,
} from "../llm/types.ts";
import { modelToolExposureAccounting } from "../tools/registry.ts";

const MIN_USEFUL_OUTPUT_TOKENS = 256;
const UNKNOWN_PROVIDER_TOOL_SCHEMA_TOKEN_RESERVE = 16_384;

export class CostBudgetAdmissionError extends Error {
  readonly remainingUsd: number;
  readonly estimatedInputTokens: number | null;

  constructor(options: {
    readonly remainingUsd: number;
    readonly estimatedInputTokens: number | null;
  }) {
    super(
      options.estimatedInputTokens === null
        ? "Provider request was not sent because its input cost could not be estimated."
        : "Provider request was not sent because its conservative minimum cost exceeds the remaining session cost budget.",
    );
    this.name = "CostBudgetAdmissionError";
    this.remainingUsd = options.remainingUsd;
    this.estimatedInputTokens = options.estimatedInputTokens;
  }
}

function validInputEstimate(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function conservativeFallbackInputTokens(options: StreamOptions): number {
  const serializedBytes = new TextEncoder().encode(
    JSON.stringify({
      systemPrompt: options.systemPrompt,
      messages: options.messages,
      ...modelToolExposureAccounting(options.toolExposure),
    }),
  ).length;
  return (
    serializedBytes +
    (options.toolExposure?.kind === "none"
      ? 0
      : UNKNOWN_PROVIDER_TOOL_SCHEMA_TOKEN_RESERVE)
  );
}

export function estimateProviderInputTokens(
  provider: LLMProvider,
  options: StreamOptions,
): number | null {
  const estimate =
    provider.estimateInputTokens?.(options) ??
    conservativeFallbackInputTokens(options);
  return validInputEstimate(estimate) ? estimate : null;
}

function admittedStreamOptions(
  options: StreamOptions,
  maxOutputTokens: number,
  providerRequestAttempts: ProviderRequestAttemptObserver,
): StreamOptions {
  const admittedMaxOutputTokens = effectiveMaxOutputTokens(
    options,
    maxOutputTokens,
  );
  if (admittedMaxOutputTokens === Number.MAX_SAFE_INTEGER) {
    return { ...options, providerRequestAttempts };
  }
  return {
    ...options,
    maxOutputTokens: admittedMaxOutputTokens,
    providerRequestAttempts,
  };
}

function effectiveMaxOutputTokens(
  options: StreamOptions,
  affordableMaxOutputTokens: number,
): number {
  return Math.min(
    options.maxOutputTokens ?? Number.MAX_SAFE_INTEGER,
    affordableMaxOutputTokens,
  );
}

interface CostBudgetedProviderOptions {
  readonly provider: LLMProvider;
  readonly model: CostModel;
  readonly maxCostUsd: number;
  readonly modelMaxOutputTokens?: number;
}

export interface SharedCostBudgetedProvider {
  readonly provider: LLMProvider;
  readonly remainingUsd: () => number;
  readonly observedUsage: () => Usage;
  readonly observedSpendUsd: () => number;
  readonly leaseContinuation: (input: {
    readonly additionalMessages: readonly ProviderMessage[];
    readonly maxOutputTokens: number;
    readonly minimumChildInputTokens: number;
  }) => ContinuationBudgetLease;
}

type ContinuationBudgetLease =
  | {
      readonly kind: "granted";
      readonly reservedUsd: number;
      readonly childMaxCostUsd: number;
      readonly estimatedContinuationInputTokens: number;
    }
  | {
      readonly kind: "rejected";
      readonly reason:
        | "missing_baseline"
        | "invalid_estimate"
        | "insufficient_budget";
    };

interface ContinuationBaseline {
  readonly streamOptions: StreamOptions;
  readonly assistantMessage: Extract<
    ProviderMessage,
    { readonly role: "assistant" }
  >;
}

function assistantMessageFromStream(input: {
  readonly text: readonly string[];
  readonly reasoning: readonly string[];
  readonly toolCalls: readonly ToolCall[];
}): Extract<ProviderMessage, { readonly role: "assistant" }> {
  const reasoningContent = input.reasoning.join("");
  return {
    role: "assistant",
    content: input.text.join(""),
    toolCalls: [...input.toolCalls],
    ...(reasoningContent === ""
      ? {}
      : {
          providerMetadata: {
            openaiCompatible: { reasoningContent },
          },
        }),
  };
}

export function createSharedCostBudgetedProvider(
  options: CostBudgetedProviderOptions,
): SharedCostBudgetedProvider {
  const maxCostUsd = options.maxCostUsd;

  let observedSpendUsd = 0;
  let observedUsage: Usage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    uncachedInputTokens: 0,
    outputTokens: 0,
  };
  let reservedAttemptSpendUsd = 0;
  let currentAttemptReservationUsd = 0;
  let latestEstimatedInputTokens: number | null = null;
  let continuationBaseline: ContinuationBaseline | null = null;
  const remainingUsd = (): number =>
    Math.max(0, maxCostUsd - observedSpendUsd - reservedAttemptSpendUsd);
  const provider: LLMProvider = {
    id: options.provider.id,
    ...(options.provider.abortSignalSupport === true
      ? { abortSignalSupport: true }
      : {}),
    ...(options.provider.estimateInputTokens !== undefined
      ? { estimateInputTokens: options.provider.estimateInputTokens }
      : {}),
    async *stream(streamOptions) {
      const estimatedInputTokens = estimateProviderInputTokens(
        options.provider,
        streamOptions,
      );
      if (estimatedInputTokens === null) {
        throw new CostBudgetAdmissionError({
          remainingUsd: Math.max(0, maxCostUsd - observedSpendUsd),
          estimatedInputTokens: null,
        });
      }
      latestEstimatedInputTokens = estimatedInputTokens;
      continuationBaseline = null;
      const assistantText: string[] = [];
      const assistantReasoning: string[] = [];
      const assistantToolCalls: ToolCall[] = [];
      const authorizeRequestAttempt = (): number => {
        const remainingUsd = Math.max(
          0,
          maxCostUsd - observedSpendUsd - reservedAttemptSpendUsd,
        );
        const maxOutputTokens = maxAffordableOutputTokens({
          remainingUsd,
          inputTokens: estimatedInputTokens,
          model: options.model,
          ...(options.modelMaxOutputTokens !== undefined
            ? { modelMaxOutputTokens: options.modelMaxOutputTokens }
            : {}),
        });
        if (
          remainingUsd <= 0 ||
          maxOutputTokens === null ||
          maxOutputTokens < MIN_USEFUL_OUTPUT_TOKENS
        ) {
          throw new CostBudgetAdmissionError({
            remainingUsd,
            estimatedInputTokens,
          });
        }
        return maxOutputTokens;
      };
      const maxOutputTokens = authorizeRequestAttempt();
      const admittedMaxOutputTokens = effectiveMaxOutputTokens(
        streamOptions,
        maxOutputTokens,
      );
      const requestReservationUsd = calculateConservativeRequestCostUsd(
        estimatedInputTokens,
        admittedMaxOutputTokens,
        options.model,
      );
      const reserveAttempt = (): void => {
        const remainingUsd = Math.max(
          0,
          maxCostUsd - observedSpendUsd - reservedAttemptSpendUsd,
        );
        if (requestReservationUsd > remainingUsd) {
          throw new CostBudgetAdmissionError({
            remainingUsd,
            estimatedInputTokens,
          });
        }
        reservedAttemptSpendUsd += requestReservationUsd;
        currentAttemptReservationUsd = requestReservationUsd;
      };
      const releaseCompletedAttempt = (): void => {
        reservedAttemptSpendUsd -= currentAttemptReservationUsd;
        currentAttemptReservationUsd = 0;
      };
      const providerRequestAttempts: ProviderRequestAttemptObserver = {
        begin: (): ProviderRequestAttemptHandle => {
          reserveAttempt();
          const attempt =
            streamOptions.providerRequestAttempts?.begin() ?? null;
          return {
            finish: (result) => {
              if (result.outcome === "completed") {
                releaseCompletedAttempt();
                observedUsage = {
                  inputTokens:
                    observedUsage.inputTokens + result.usage.inputTokens,
                  cachedInputTokens:
                    observedUsage.cachedInputTokens +
                    result.usage.cachedInputTokens,
                  uncachedInputTokens:
                    observedUsage.uncachedInputTokens +
                    result.usage.uncachedInputTokens,
                  outputTokens:
                    observedUsage.outputTokens + result.usage.outputTokens,
                };
                observedSpendUsd += calculateRequestCostBatchUsd(
                  { requests: [{ usage: result.usage }] },
                  options.model,
                );
              }
              attempt?.finish(result);
            },
          };
        },
      };

      for await (const event of options.provider.stream(
        admittedStreamOptions(
          streamOptions,
          maxOutputTokens,
          providerRequestAttempts,
        ),
      )) {
        switch (event.type) {
          case "text":
            assistantText.push(event.text);
            break;
          case "reasoning":
            assistantReasoning.push(event.text);
            break;
          case "tool_call": {
            const { type: _type, ...toolCall } = event;
            assistantToolCalls.push(toolCall);
            break;
          }
          case "stop":
            continuationBaseline = {
              streamOptions: {
                ...streamOptions,
                messages: [...streamOptions.messages],
              },
              assistantMessage: assistantMessageFromStream({
                text: assistantText,
                reasoning: assistantReasoning,
                toolCalls: assistantToolCalls,
              }),
            };
            break;
          /* v8 ignore next 2 -- retry notifications carry no assistant payload, so preserving them requires no budget-baseline state change. */
          case "provider_retry":
            break;
        }
        yield event;
      }
    },
  };
  return {
    provider,
    remainingUsd,
    observedUsage: () => ({ ...observedUsage }),
    observedSpendUsd: () => observedSpendUsd,
    leaseContinuation: (input) => {
      if (
        latestEstimatedInputTokens === null ||
        continuationBaseline === null
      ) {
        return { kind: "rejected", reason: "missing_baseline" };
      }
      const estimatedContinuationInputTokens = estimateProviderInputTokens(
        options.provider,
        {
          ...continuationBaseline.streamOptions,
          messages: [
            ...continuationBaseline.streamOptions.messages,
            continuationBaseline.assistantMessage,
            ...input.additionalMessages,
          ],
          maxOutputTokens: input.maxOutputTokens,
        },
      );
      if (estimatedContinuationInputTokens === null) {
        return { kind: "rejected", reason: "invalid_estimate" };
      }
      const reservedUsd = calculateConservativeRequestCostUsd(
        estimatedContinuationInputTokens,
        input.maxOutputTokens,
        options.model,
      );
      const childMaxCostUsd = remainingUsd() - reservedUsd;
      const minimumChildCostUsd = calculateConservativeRequestCostUsd(
        input.minimumChildInputTokens,
        MIN_USEFUL_OUTPUT_TOKENS,
        options.model,
      );
      if (
        childMaxCostUsd < minimumChildCostUsd ||
        input.maxOutputTokens < MIN_USEFUL_OUTPUT_TOKENS
      ) {
        return { kind: "rejected", reason: "insufficient_budget" };
      }
      return {
        kind: "granted",
        reservedUsd,
        childMaxCostUsd,
        estimatedContinuationInputTokens,
      };
    },
  };
}

export function createCostBudgetedProvider(
  options: CostBudgetedProviderOptions,
): LLMProvider {
  return createSharedCostBudgetedProvider(options).provider;
}
