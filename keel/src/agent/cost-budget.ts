import {
  type CostModel,
  calculateConservativeRequestCostUsd,
  calculateRequestCostBatchUsd,
  maxAffordableOutputTokens,
} from "../core/cost.ts";
import type {
  LLMProvider,
  ModelToolExposure,
  ProviderContinuationLease,
  ProviderMessage,
  ProviderRequestAttemptHandle,
  ProviderRequestAttemptObserver,
  StreamOptions,
  ToolCall,
  Usage,
} from "../llm/types.ts";
import { modelToolExposureAccounting } from "../tools/registry.ts";

export const MIN_USEFUL_OUTPUT_TOKENS = 256;
const UNKNOWN_PROVIDER_TOOL_SCHEMA_TOKEN_RESERVE = 16_384;
const MAX_REQUEST_PRICING_ATTEMPTS = 8;

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

type RequestPricing =
  | {
      readonly kind: "priced";
      readonly estimatedInputTokens: number;
      readonly maxOutputTokens: number;
      readonly reservationUsd: number;
    }
  | {
      readonly kind: "rejected";
      readonly estimatedInputTokens: number | null;
    };

function priceFinalProviderRequest(options: {
  readonly provider: LLMProvider;
  readonly streamOptions: StreamOptions;
  readonly remainingUsd: number;
  readonly model: CostModel;
  readonly modelMaxOutputTokens?: number;
}): RequestPricing {
  let estimatedInputTokens = estimateProviderInputTokens(
    options.provider,
    options.streamOptions,
  );
  if (estimatedInputTokens === null) {
    return { kind: "rejected", estimatedInputTokens: null };
  }

  for (let attempt = 0; attempt < MAX_REQUEST_PRICING_ATTEMPTS; attempt++) {
    const affordableMaxOutputTokens = maxAffordableOutputTokens({
      remainingUsd: options.remainingUsd,
      inputTokens: estimatedInputTokens,
      model: options.model,
      ...(options.modelMaxOutputTokens !== undefined
        ? { modelMaxOutputTokens: options.modelMaxOutputTokens }
        : {}),
    });
    if (affordableMaxOutputTokens === null) {
      return { kind: "rejected", estimatedInputTokens };
    }
    const maxOutputTokens = effectiveMaxOutputTokens(
      options.streamOptions,
      affordableMaxOutputTokens,
    );
    if (maxOutputTokens < MIN_USEFUL_OUTPUT_TOKENS) {
      return { kind: "rejected", estimatedInputTokens };
    }
    const finalStreamOptions =
      maxOutputTokens === Number.MAX_SAFE_INTEGER
        ? options.streamOptions
        : { ...options.streamOptions, maxOutputTokens };
    const finalEstimatedInputTokens = estimateProviderInputTokens(
      options.provider,
      finalStreamOptions,
    );
    if (finalEstimatedInputTokens === null) {
      return { kind: "rejected", estimatedInputTokens: null };
    }
    const reservationUsd = calculateConservativeRequestCostUsd(
      finalEstimatedInputTokens,
      maxOutputTokens,
      options.model,
    );
    if (reservationUsd <= options.remainingUsd) {
      return {
        kind: "priced",
        estimatedInputTokens: finalEstimatedInputTokens,
        maxOutputTokens,
        reservationUsd,
      };
    }
    estimatedInputTokens = finalEstimatedInputTokens;
  }

  /* v8 ignore next -- a deterministic provider estimator converges as the output ceiling shrinks; retain a bounded fail-closed result for nonconforming oscillating estimators. */
  return { kind: "rejected", estimatedInputTokens };
}

interface CostBudgetedProviderOptions {
  readonly provider: LLMProvider;
  readonly model: CostModel;
  readonly maxCostUsd: number;
  readonly modelMaxOutputTokens?: number;
  readonly sharedAccount?: SharedCostBudgetAccount;
}

interface SharedCostBudgetReservation {
  readonly settle: (spentUsd: number) => void;
  readonly release: () => void;
}

export interface SharedCostBudgetAccount {
  readonly remainingUsd: () => number;
  readonly observedSpendUsd: () => number;
  readonly reserve: (amountUsd: number) => SharedCostBudgetReservation | null;
}

export function createSharedCostBudgetAccount(
  maxCostUsd: number,
): SharedCostBudgetAccount {
  let observedSpendUsd = 0;
  let reservedUsd = 0;
  const remainingUsd = (): number =>
    Math.max(0, maxCostUsd - observedSpendUsd - reservedUsd);
  return {
    remainingUsd,
    observedSpendUsd: () => observedSpendUsd,
    reserve: (amountUsd) => {
      if (!Number.isFinite(amountUsd) || amountUsd < 0) return null;
      if (amountUsd > remainingUsd()) return null;
      reservedUsd += amountUsd;
      let active = true;
      const release = (): void => {
        if (!active) return;
        active = false;
        reservedUsd -= amountUsd;
      };
      return {
        settle: (spentUsd) => {
          if (!active) return;
          release();
          observedSpendUsd += spentUsd;
        },
        release,
      };
    },
  };
}

export interface SharedCostBudgetedProvider {
  readonly provider: LLMProvider;
  readonly remainingUsd: () => number;
  readonly observedUsage: () => Usage;
  readonly observedSpendUsd: () => number;
  readonly leaseContinuation: (input: {
    readonly additionalMessages: readonly ProviderMessage[];
    readonly maxOutputTokens: number;
    readonly minimumAdditionalRequestCostUsd: number;
  }) => ContinuationBudgetLease;
}

type ContinuationBudgetLease =
  | {
      readonly kind: "granted";
      readonly reservedUsd: number;
      readonly additionalRequestBudgetUsd: number;
      readonly estimatedContinuationInputTokens: number;
      readonly continuation: ProviderContinuationLease;
      readonly release: () => void;
    }
  | {
      readonly kind: "rejected";
      readonly reason:
        | "active_lease"
        | "missing_baseline"
        | "invalid_estimate"
        | "insufficient_budget";
      readonly release?: never;
    };

interface ContinuationBaseline {
  readonly streamOptions: StreamOptions & {
    readonly toolExposure: ModelToolExposure;
  };
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
  let latestEstimatedInputTokens: number | null = null;
  let continuationBaseline: ContinuationBaseline | null = null;
  let activeContinuationReservation: {
    readonly id: number;
    readonly reservedUsd: number;
    readonly shared: SharedCostBudgetReservation | null;
  } | null = null;
  let nextContinuationReservationId = 0;
  let requestedContinuationReservationId: number | null = null;
  const localRemainingUsd = (): number =>
    Math.max(
      0,
      maxCostUsd -
        observedSpendUsd -
        reservedAttemptSpendUsd -
        (activeContinuationReservation?.reservedUsd ?? 0),
    );
  const remainingUsd = (): number =>
    Math.min(
      localRemainingUsd(),
      options.sharedAccount?.remainingUsd() ?? Number.POSITIVE_INFINITY,
    );
  const continuationRemainingUsd = (reservedUsd: number): number =>
    Math.min(
      localRemainingUsd() + reservedUsd,
      options.sharedAccount === undefined
        ? Number.POSITIVE_INFINITY
        : options.sharedAccount.remainingUsd() + reservedUsd,
    );
  const provider: LLMProvider = {
    id: options.provider.id,
    ...(options.provider.abortSignalSupport === true
      ? { abortSignalSupport: true }
      : {}),
    ...(options.provider.estimateInputTokens !== undefined
      ? { estimateInputTokens: options.provider.estimateInputTokens }
      : {}),
    async *stream(streamOptions) {
      const requestedReservationId = requestedContinuationReservationId;
      requestedContinuationReservationId = null;
      let continuationReservation =
        requestedReservationId !== null &&
        activeContinuationReservation?.id === requestedReservationId
          ? activeContinuationReservation
          : null;
      if (requestedReservationId !== null && continuationReservation === null) {
        throw new CostBudgetAdmissionError({
          remainingUsd: remainingUsd(),
          estimatedInputTokens: null,
        });
      }
      const availableUsd =
        continuationReservation === null
          ? remainingUsd()
          : continuationRemainingUsd(continuationReservation.reservedUsd);
      const pricing = priceFinalProviderRequest({
        provider: options.provider,
        streamOptions,
        remainingUsd: availableUsd,
        model: options.model,
        ...(options.modelMaxOutputTokens !== undefined
          ? { modelMaxOutputTokens: options.modelMaxOutputTokens }
          : {}),
      });
      if (pricing.kind === "rejected") {
        throw new CostBudgetAdmissionError({
          remainingUsd: availableUsd,
          estimatedInputTokens: pricing.estimatedInputTokens,
        });
      }
      const estimatedInputTokens = pricing.estimatedInputTokens;
      latestEstimatedInputTokens = estimatedInputTokens;
      continuationBaseline = null;
      const assistantText: string[] = [];
      const assistantReasoning: string[] = [];
      const assistantToolCalls: ToolCall[] = [];
      const requestReservationUsd = pricing.reservationUsd;
      const reserveAttempt = (): SharedCostBudgetReservation | null => {
        if (continuationReservation !== null) {
          const reservation = continuationReservation;
          continuationReservation = null;
          if (
            activeContinuationReservation?.id !== reservation.id ||
            requestReservationUsd > reservation.reservedUsd
          ) {
            throw new CostBudgetAdmissionError({
              remainingUsd: continuationRemainingUsd(reservation.reservedUsd),
              estimatedInputTokens,
            });
          }
          activeContinuationReservation = null;
          reservedAttemptSpendUsd += requestReservationUsd;
          return reservation.shared;
        }
        const availableUsd = remainingUsd();
        if (requestReservationUsd > availableUsd) {
          throw new CostBudgetAdmissionError({
            remainingUsd: availableUsd,
            estimatedInputTokens,
          });
        }
        const sharedReservation =
          options.sharedAccount?.reserve(requestReservationUsd) ?? null;
        if (options.sharedAccount !== undefined && sharedReservation === null) {
          throw new CostBudgetAdmissionError({
            remainingUsd: options.sharedAccount.remainingUsd(),
            estimatedInputTokens,
          });
        }
        reservedAttemptSpendUsd += requestReservationUsd;
        return sharedReservation;
      };
      const providerRequestAttempts: ProviderRequestAttemptObserver = {
        begin: (): ProviderRequestAttemptHandle => {
          const sharedReservation = reserveAttempt();
          const attempt =
            streamOptions.providerRequestAttempts?.begin() ?? null;
          return {
            finish: (result) => {
              if (result.outcome === "completed") {
                reservedAttemptSpendUsd -= requestReservationUsd;
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
                const requestCostUsd = calculateRequestCostBatchUsd(
                  { requests: [{ usage: result.usage }] },
                  options.model,
                );
                observedSpendUsd += requestCostUsd;
                sharedReservation?.settle(requestCostUsd);
              }
              attempt?.finish(result);
            },
          };
        },
      };

      for await (const event of options.provider.stream(
        admittedStreamOptions(
          streamOptions,
          pricing.maxOutputTokens,
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
            continuationBaseline =
              streamOptions.toolExposure === undefined
                ? null
                : {
                    streamOptions: {
                      ...streamOptions,
                      messages: [...streamOptions.messages],
                      toolExposure: streamOptions.toolExposure,
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
      if (activeContinuationReservation !== null) {
        return { kind: "rejected", reason: "active_lease" };
      }
      if (
        latestEstimatedInputTokens === null ||
        continuationBaseline === null
      ) {
        return { kind: "rejected", reason: "missing_baseline" };
      }
      const {
        requestSystemPrompt: baselineRequestSystemPrompt,
        ...baselineStreamOptions
      } = continuationBaseline.streamOptions;
      const continuationRequestShape: StreamOptions & {
        readonly toolExposure: ModelToolExposure;
      } = {
        ...baselineStreamOptions,
        systemPrompt:
          baselineRequestSystemPrompt?.() ?? baselineStreamOptions.systemPrompt,
      };
      const estimatedContinuationInputTokens = estimateProviderInputTokens(
        options.provider,
        {
          ...continuationRequestShape,
          messages: [
            ...continuationRequestShape.messages,
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
      const additionalRequestBudgetUsd = remainingUsd() - reservedUsd;
      if (
        additionalRequestBudgetUsd < input.minimumAdditionalRequestCostUsd ||
        input.maxOutputTokens < MIN_USEFUL_OUTPUT_TOKENS
      ) {
        return { kind: "rejected", reason: "insufficient_budget" };
      }
      const reservationId = nextContinuationReservationId++;
      const shared = options.sharedAccount?.reserve(reservedUsd) ?? null;
      if (options.sharedAccount !== undefined && shared === null) {
        return { kind: "rejected", reason: "insufficient_budget" };
      }
      activeContinuationReservation = {
        id: reservationId,
        reservedUsd,
        shared,
      };
      const continuationProvider: LLMProvider = {
        ...provider,
        async *stream(streamOptions) {
          if (requestedContinuationReservationId !== null) {
            throw new CostBudgetAdmissionError({
              remainingUsd: remainingUsd(),
              estimatedInputTokens: null,
            });
          }
          requestedContinuationReservationId = reservationId;
          try {
            const {
              requestSystemPrompt: _unpricedRequestSystemPrompt,
              systemPrompt: _unpricedSystemPrompt,
              toolExposure: _unpricedToolExposure,
              ...currentRequest
            } = streamOptions;
            yield* provider.stream({
              ...currentRequest,
              systemPrompt: continuationRequestShape.systemPrompt,
              toolExposure: continuationRequestShape.toolExposure,
              maxOutputTokens: effectiveMaxOutputTokens(
                streamOptions,
                input.maxOutputTokens,
              ),
            });
          } finally {
            if (requestedContinuationReservationId === reservationId) {
              requestedContinuationReservationId = null;
            }
          }
        },
      };
      const release = (): void => {
        if (activeContinuationReservation?.id === reservationId) {
          activeContinuationReservation.shared?.release();
          activeContinuationReservation = null;
        }
      };
      return {
        kind: "granted",
        reservedUsd,
        additionalRequestBudgetUsd,
        estimatedContinuationInputTokens,
        continuation: {
          provider: continuationProvider,
          requestShape: {
            systemPrompt: continuationRequestShape.systemPrompt,
            toolExposure: continuationRequestShape.toolExposure,
          },
          release,
        },
        release,
      };
    },
  };
}

export function createCostBudgetedProvider(
  options: CostBudgetedProviderOptions,
): LLMProvider {
  return createSharedCostBudgetedProvider(options).provider;
}
