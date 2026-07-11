import {
  type CostModel,
  calculateConservativeRequestCostUsd,
  calculateRequestCostBatchUsd,
  maxAffordableOutputTokens,
} from "../core/cost.ts";
import type { LLMProvider, StreamOptions } from "../llm/types.ts";

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
      allowBash: options.allowBash === true,
      toolChoice: options.toolChoice ?? "auto",
    }),
  ).length;
  return (
    serializedBytes +
    (options.toolChoice === "none"
      ? 0
      : UNKNOWN_PROVIDER_TOOL_SCHEMA_TOKEN_RESERVE)
  );
}

function admittedStreamOptions(
  options: StreamOptions,
  maxOutputTokens: number,
  beforeRequestAttempt: () => void,
): StreamOptions {
  if (maxOutputTokens === Number.MAX_SAFE_INTEGER) {
    return { ...options, beforeRequestAttempt };
  }
  return { ...options, maxOutputTokens, beforeRequestAttempt };
}

export function createCostBudgetedProvider(options: {
  readonly provider: LLMProvider;
  readonly model: CostModel;
  readonly maxCostUsd: number;
  readonly modelMaxOutputTokens?: number;
}): LLMProvider {
  const maxCostUsd = options.maxCostUsd;

  let observedSpendUsd = 0;
  let reservedAttemptSpendUsd = 0;
  let currentAttemptReservationUsd = 0;
  return {
    id: options.provider.id,
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
      const requestReservationUsd = calculateConservativeRequestCostUsd(
        estimatedInputTokens,
        maxOutputTokens,
        options.model,
      );

      for await (const event of options.provider.stream(
        admittedStreamOptions(streamOptions, maxOutputTokens, () => {
          streamOptions.beforeRequestAttempt?.();
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
        }),
      )) {
        if (event.type === "stop") {
          reservedAttemptSpendUsd -= currentAttemptReservationUsd;
          currentAttemptReservationUsd = 0;
          observedSpendUsd += calculateRequestCostBatchUsd(
            { requests: [{ usage: event.usage }] },
            options.model,
          );
        }
        yield event;
      }
    },
  };
}
