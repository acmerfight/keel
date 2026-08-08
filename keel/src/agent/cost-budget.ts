import {
  type CostModel,
  calculateConservativeRequestCostUsd,
  calculateRequestCostBatchUsd,
  maxAffordableOutputTokens,
} from "../core/cost.ts";
import type {
  LLMProvider,
  ProviderRequestAttemptHandle,
  ProviderRequestAttemptObserver,
  StreamOptions,
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
      const estimatedInputTokens =
        options.provider.estimateInputTokens?.(streamOptions) ??
        conservativeFallbackInputTokens(streamOptions);
      if (!validInputEstimate(estimatedInputTokens)) {
        throw new CostBudgetAdmissionError({
          remainingUsd: Math.max(0, maxCostUsd - observedSpendUsd),
          estimatedInputTokens: null,
        });
      }
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
        yield event;
      }
    },
  };
  return {
    provider,
    remainingUsd,
    observedUsage: () => ({ ...observedUsage }),
    observedSpendUsd: () => observedSpendUsd,
  };
}

export function createCostBudgetedProvider(
  options: CostBudgetedProviderOptions,
): LLMProvider {
  return createSharedCostBudgetedProvider(options).provider;
}
