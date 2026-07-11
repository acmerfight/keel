import {
  isAbortThrow,
  KeelError,
  type KeelErrorCode,
  type RecoverableToolErrorCode,
} from "../../core/error.ts";
import type { LLMEvent } from "../types.ts";

export interface ProviderRetryConfig {
  readonly maxRetries?: number;
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly jitterRatio?: number;
  readonly maxRetryAfterMs?: number;
  readonly maxTotalDelayMs?: number;
}

interface ResolvedProviderRetryConfig {
  readonly maxRetries: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitterRatio: number;
  readonly maxRetryAfterMs: number;
  readonly maxTotalDelayMs: number;
}

export interface ProviderConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly retry?: ProviderRetryConfig;
}

type RetryDelay =
  | { readonly type: "delay"; readonly ms: number }
  | { readonly type: "skip" };

type ProviderRetryEvent = Extract<
  LLMEvent,
  { readonly type: "provider_retry" }
>;

interface RetryDecision {
  readonly reason: Exclude<KeelErrorCode, RecoverableToolErrorCode>;
  readonly delayMs: number;
  readonly attemptIndex: number;
  readonly maxRetries: number;
}

const DEFAULT_PROVIDER_RETRY_CONFIG: ResolvedProviderRetryConfig = {
  maxRetries: 4,
  initialDelayMs: 500,
  maxDelayMs: 8_000,
  jitterRatio: 1,
  maxRetryAfterMs: 60_000,
  maxTotalDelayMs: 120_000,
};

function resolveRetryConfig(
  retry: ProviderRetryConfig | undefined,
): ResolvedProviderRetryConfig {
  if (retry === undefined) {
    return DEFAULT_PROVIDER_RETRY_CONFIG;
  }
  return {
    maxRetries: retry.maxRetries ?? DEFAULT_PROVIDER_RETRY_CONFIG.maxRetries,
    initialDelayMs:
      retry.initialDelayMs ?? DEFAULT_PROVIDER_RETRY_CONFIG.initialDelayMs,
    maxDelayMs: retry.maxDelayMs ?? DEFAULT_PROVIDER_RETRY_CONFIG.maxDelayMs,
    jitterRatio: Math.max(
      0,
      Math.min(
        retry.jitterRatio ?? DEFAULT_PROVIDER_RETRY_CONFIG.jitterRatio,
        1,
      ),
    ),
    maxRetryAfterMs:
      retry.maxRetryAfterMs ?? DEFAULT_PROVIDER_RETRY_CONFIG.maxRetryAfterMs,
    maxTotalDelayMs:
      retry.maxTotalDelayMs ?? DEFAULT_PROVIDER_RETRY_CONFIG.maxTotalDelayMs,
  };
}

function httpErrorCode(
  status: number,
): Exclude<KeelErrorCode, RecoverableToolErrorCode> {
  if (status === 401 || status === 403) return "provider_auth_failed";
  if (status === 429) return "provider_rate_limited";
  if (status >= 500) return "provider_server_error";
  return "provider_http_error";
}

function isContextOverflowHttpError(status: number, body: string): boolean {
  if (status === 413) {
    return true;
  }
  if (status !== 400) {
    return false;
  }
  return [
    /prompt is too long/i,
    /input is too long for requested model/i,
    /exceeds the context window/i,
    /input token count.*exceeds the maximum/i,
    /maximum prompt length is \d+/i,
    /reduce the length of the messages/i,
    /maximum context length is \d+ tokens/i,
    /exceeds the available context size/i,
    /greater than the context length/i,
    /context window exceeds limit/i,
    /exceeded model token limit/i,
    /context[_ ]length[_ ]exceeded/i,
    /request entity too large/i,
    /input length.*exceeds.*context length/i,
    /prompt too long; exceeded (?:max )?context length/i,
    /too large for model with \d+ maximum context length/i,
    /model_context_window_exceeded/i,
  ].some((pattern) => pattern.test(body));
}

export function transportError(
  error: unknown,
  signal: AbortSignal,
  providerName: string,
  message: string,
): KeelError {
  if (error instanceof KeelError) return error;
  if (isAbortThrow(error, signal)) {
    return new KeelError(
      "provider_aborted",
      `${providerName} request was aborted`,
    );
  }
  return new KeelError("provider_network_error", message);
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function chatCompletionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/u, "")}/chat/completions`;
}

function parseRetryAfterMs(headers: Headers, nowMs: number): number | null {
  const retryAfterMs = headers.get("retry-after-ms");
  if (retryAfterMs !== null) {
    const parsed = Number.parseFloat(retryAfterMs);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }

  const retryAfter = headers.get("retry-after");
  if (retryAfter === null) return null;

  const seconds = Number.parseFloat(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1_000;
  }

  const dateMs = Date.parse(retryAfter);
  if (Number.isNaN(dateMs)) return null;
  return Math.max(0, dateMs - nowMs);
}

function retryDelayMs(
  attemptIndex: number,
  headers: Headers | null,
  retry: ResolvedProviderRetryConfig,
): RetryDelay {
  const retryAfterMs =
    headers === null ? null : parseRetryAfterMs(headers, Date.now());
  if (retryAfterMs !== null) {
    if (retryAfterMs <= retry.maxRetryAfterMs) {
      return { type: "delay", ms: retryAfterMs };
    }
    return { type: "skip" };
  }

  return {
    type: "delay",
    ms: exponentialRetryDelayMs(attemptIndex, retry),
  };
}

function exponentialRetryDelayMs(
  attemptIndex: number,
  retry: ResolvedProviderRetryConfig,
): number {
  const exponentialDelay = Math.min(
    retry.initialDelayMs * 2 ** attemptIndex,
    retry.maxDelayMs,
  );
  const minimumDelay = exponentialDelay * (1 - retry.jitterRatio);
  const jitterRange = exponentialDelay - minimumDelay;
  return Math.max(0, minimumDelay + Math.random() * jitterRange);
}

function sleepWithAbort(
  delayMs: number,
  signal: AbortSignal,
  providerName: string,
): Promise<void> {
  /* v8 ignore next 5: protects the small window before the abort listener is registered. */
  if (signal.aborted) {
    throw new KeelError(
      "provider_aborted",
      `${providerName} request was aborted`,
    );
  }
  if (delayMs <= 0) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(
        new KeelError(
          "provider_aborted",
          `${providerName} request was aborted`,
        ),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
    /* v8 ignore next 3: cancellation cleanup is best effort before retrying. */
  } catch {
    // Best effort only; the retry decision must not depend on error body IO.
  }
}

interface RetryResponseDecision {
  readonly reason: Exclude<KeelErrorCode, RecoverableToolErrorCode>;
  readonly delayMs: number;
}

function fitsRetryDelayBudget(
  totalRetryDelayMs: number,
  delayMs: number,
  retry: ResolvedProviderRetryConfig,
): boolean {
  return totalRetryDelayMs + delayMs <= retry.maxTotalDelayMs;
}

function retryResponseDecision(
  response: Response,
  attempt: number,
  retry: ResolvedProviderRetryConfig,
  totalRetryDelayMs: number,
): RetryResponseDecision | null {
  if (attempt >= retry.maxRetries || !isRetryableStatus(response.status)) {
    return null;
  }

  const delay = retryDelayMs(attempt, response.headers, retry);
  if (delay.type === "skip") {
    return null;
  }
  if (!fitsRetryDelayBudget(totalRetryDelayMs, delay.ms, retry)) {
    return null;
  }

  return {
    reason: httpErrorCode(response.status),
    delayMs: delay.ms,
  };
}

export class ProviderRetryController {
  #retry: ResolvedProviderRetryConfig;
  #attemptCount = 0;
  #totalRetryDelayMs = 0;

  constructor(retry: ProviderRetryConfig | undefined) {
    this.#retry = resolveRetryConfig(retry);
  }

  transportDecision(
    reason: Exclude<KeelErrorCode, RecoverableToolErrorCode>,
  ): RetryDecision | null {
    if (this.#attemptCount >= this.#retry.maxRetries) {
      return null;
    }

    const delayMs = exponentialRetryDelayMs(this.#attemptCount, this.#retry);
    if (!fitsRetryDelayBudget(this.#totalRetryDelayMs, delayMs, this.#retry)) {
      return null;
    }

    return {
      reason,
      delayMs,
      attemptIndex: this.#attemptCount,
      maxRetries: this.#retry.maxRetries,
    };
  }

  responseDecision(response: Response): RetryDecision | null {
    const decision = retryResponseDecision(
      response,
      this.#attemptCount,
      this.#retry,
      this.#totalRetryDelayMs,
    );
    if (decision === null) {
      return null;
    }

    return {
      ...decision,
      attemptIndex: this.#attemptCount,
      maxRetries: this.#retry.maxRetries,
    };
  }

  recordRetry(decision: RetryDecision): void {
    this.#attemptCount = decision.attemptIndex + 1;
    this.#totalRetryDelayMs += decision.delayMs;
  }
}

function providerRetryEvent(
  providerName: string,
  reason: KeelErrorCode,
  attempt: number,
  maxRetries: number,
  delayMs: number,
): ProviderRetryEvent {
  return {
    type: "provider_retry",
    provider: providerName,
    reason,
    attempt: attempt + 1,
    maxRetries,
    delayMs,
  };
}

export async function* waitForProviderRetry(
  retry: ProviderRetryController,
  providerName: string,
  signal: AbortSignal,
  decision: RetryDecision,
): AsyncGenerator<LLMEvent> {
  yield providerRetryEvent(
    providerName,
    decision.reason,
    decision.attemptIndex,
    decision.maxRetries,
    decision.delayMs,
  );
  retry.recordRetry(decision);
  await sleepWithAbort(decision.delayMs, signal, providerName);
}

export async function* requestChatCompletions(
  config: ProviderConfig,
  body: string,
  signal: AbortSignal,
  providerName: string,
  retry: ProviderRetryController = new ProviderRetryController(config.retry),
  beforeRequestAttempt?: () => void,
): AsyncGenerator<LLMEvent, Response> {
  for (;;) {
    beforeRequestAttempt?.();
    let response: Response;
    try {
      response = await fetch(chatCompletionsUrl(config.baseUrl), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body,
        signal,
      });
    } catch (error) {
      const keelError = transportError(
        error,
        signal,
        providerName,
        `${providerName} request failed before response`,
      );
      if (keelError.code !== "provider_network_error") {
        throw keelError;
      }
      const decision = retry.transportDecision(keelError.code);
      if (decision === null) {
        throw keelError;
      }
      yield* waitForProviderRetry(retry, providerName, signal, decision);
      continue;
    }

    if (response.ok) {
      return response;
    }

    const retryDecision = retry.responseDecision(response);
    if (retryDecision !== null) {
      await discardResponseBody(response);
      yield* waitForProviderRetry(retry, providerName, signal, retryDecision);
      continue;
    }

    const text = await response.text();
    throw new KeelError(
      isContextOverflowHttpError(response.status, text)
        ? "provider_context_overflow"
        : httpErrorCode(response.status),
      `${providerName} API error (${response.status}): ${text}`,
    );
  }
}
