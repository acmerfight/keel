import {
  isAbortThrow,
  KeelError,
  type KeelErrorCode,
  type RecoverableToolErrorCode,
} from "../../core/error.ts";
import type {
  LLMEvent,
  ProviderRequestAttemptHandle,
  ProviderRequestAttemptObserver,
  ProviderRequestConcurrency,
  ProviderRequestRetryDecision,
  ProviderRequestSlot,
  ProviderRetryCoordination,
} from "../types.ts";

export interface ProviderRetryConfig {
  readonly maxRetries?: number;
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly jitterRatio?: number;
  readonly maxRetryAfterMs?: number;
  readonly maxTotalDelayMs?: number;
}

export interface ProviderLivenessConfig {
  readonly firstResponseTimeoutMs: number;
  readonly streamInactivityTimeoutMs: number;
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
  readonly liveness?: ProviderLivenessConfig;
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

export function coordinatedRetryDecision(
  decision: RetryDecision | null,
  coordination: ProviderRetryCoordination | undefined,
): RetryDecision | null {
  if (decision === null || coordination === undefined) return decision;
  const delayMs = coordination.reserveRetry({
    reason: decision.reason,
    suggestedDelayMs: decision.delayMs,
  });
  return delayMs === null ? null : { ...decision, delayMs };
}

const DEFAULT_PROVIDER_RETRY_CONFIG: ResolvedProviderRetryConfig = {
  maxRetries: 4,
  initialDelayMs: 500,
  maxDelayMs: 8_000,
  jitterRatio: 1,
  maxRetryAfterMs: 60_000,
  maxTotalDelayMs: 120_000,
};

const DEFAULT_PROVIDER_LIVENESS_CONFIG: ProviderLivenessConfig = {
  firstResponseTimeoutMs: 120_000,
  streamInactivityTimeoutMs: 120_000,
};

export function resolveProviderLivenessConfig(
  liveness: ProviderLivenessConfig | undefined,
): ProviderLivenessConfig {
  return liveness ?? DEFAULT_PROVIDER_LIVENESS_CONFIG;
}

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
    /range of input length should be \[1,\s*\d+\]/i,
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

export interface ProviderInactivityControl {
  readonly timeoutMs: number;
  readonly abort: () => void;
  readonly timedOut: () => boolean;
}

export async function readWithProviderInactivityDeadline(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  activityDeadline: number,
  liveness: ProviderInactivityControl,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  const deadline = Promise.withResolvers<never>();
  const timer = setTimeout(
    () => {
      liveness.abort();
      deadline.reject(new Error("provider inactivity deadline reached"));
    },
    Math.max(0, activityDeadline - Date.now()),
  );
  try {
    return await Promise.race([reader.read(), deadline.promise]);
  } finally {
    clearTimeout(timer);
  }
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
  #timeoutRetryCount = 0;

  constructor(retry: ProviderRetryConfig | undefined) {
    this.#retry = resolveRetryConfig(retry);
  }

  transportDecision(
    reason: Exclude<KeelErrorCode, RecoverableToolErrorCode>,
  ): RetryDecision | null {
    if (
      (reason === "first_response_timeout" ||
        reason === "stream_inactivity_timeout") &&
      this.#timeoutRetryCount >= 1
    ) {
      return null;
    }
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
    if (
      decision.reason === "first_response_timeout" ||
      decision.reason === "stream_inactivity_timeout"
    ) {
      this.#timeoutRetryCount++;
    }
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

function providerRequestRetryDecision(
  providerName: string,
  reason: KeelErrorCode,
  attempt: number,
  maxRetries: number,
  delayMs: number,
): ProviderRequestRetryDecision {
  return {
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

export function requestRetryDecisionForReport(
  providerName: string,
  decision: RetryDecision,
): ProviderRequestRetryDecision {
  return providerRequestRetryDecision(
    providerName,
    decision.reason,
    decision.attemptIndex,
    decision.maxRetries,
    decision.delayMs,
  );
}

export interface ChatCompletionsResponse {
  readonly response: Response;
  readonly attempt: ProviderRequestAttemptHandle | null;
  readonly abortForStreamInactivity: () => void;
  readonly streamInactivityTimedOut: () => boolean;
  readonly close: () => void;
}

const unboundedProviderRequestSlot: ProviderRequestSlot = {
  release: () => {},
};

type RequestTermination =
  | "active"
  | "caller_abort"
  | "first_response_timeout"
  | "stream_inactivity_timeout"
  | "closed";

interface ProviderRequestControl {
  readonly signal: AbortSignal;
  readonly responseReceived: () => void;
  readonly abortForStreamInactivity: () => void;
  readonly termination: () => RequestTermination;
  readonly close: () => void;
}

function createProviderRequestControl(
  callerSignal: AbortSignal,
  firstResponseTimeoutMs: number,
): ProviderRequestControl {
  const controller = new AbortController();
  let termination: RequestTermination = "active";
  let firstResponseTimer: ReturnType<typeof setTimeout> | null = null;

  const clearFirstResponseTimer = (): void => {
    clearTimeout(firstResponseTimer ?? undefined);
    firstResponseTimer = null;
  };
  const abort = (
    reason: Extract<
      RequestTermination,
      "caller_abort" | "first_response_timeout" | "stream_inactivity_timeout"
    >,
  ): void => {
    /* v8 ignore next -- late terminal paths are intentionally ignored after the first cause wins. */
    if (termination !== "active") return;
    termination = reason;
    clearFirstResponseTimer();
    controller.abort();
  };
  const onCallerAbort = (): void => abort("caller_abort");
  callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  if (callerSignal.aborted) {
    abort("caller_abort");
  } else {
    firstResponseTimer = setTimeout(
      () => abort("first_response_timeout"),
      firstResponseTimeoutMs,
    );
  }

  return {
    signal: controller.signal,
    responseReceived: clearFirstResponseTimer,
    abortForStreamInactivity: () => abort("stream_inactivity_timeout"),
    termination: () => termination,
    close: () => {
      clearFirstResponseTimer();
      callerSignal.removeEventListener("abort", onCallerAbort);
      if (termination === "active") {
        termination = "closed";
      }
    },
  };
}

type FirstResponseFailure =
  | {
      readonly outcome: "aborted";
      readonly error: KeelError;
    }
  | {
      readonly outcome: "retryable_error";
      readonly reason: "first_response_timeout" | "provider_network_error";
      readonly error: KeelError;
    };

function firstResponseFailure(
  control: ProviderRequestControl,
  error: unknown,
  callerSignal: AbortSignal,
  providerName: string,
): FirstResponseFailure {
  if (control.termination() === "first_response_timeout") {
    return {
      outcome: "retryable_error",
      reason: "first_response_timeout",
      error: new KeelError(
        "first_response_timeout",
        `${providerName} request timed out before response headers`,
      ),
    };
  }
  if (isAbortThrow(error, callerSignal)) {
    return {
      outcome: "aborted",
      error: new KeelError(
        "provider_aborted",
        `${providerName} request was aborted`,
      ),
    };
  }
  return {
    outcome: "retryable_error",
    reason: "provider_network_error",
    error: new KeelError(
      "provider_network_error",
      `${providerName} request failed before response`,
    ),
  };
}

async function readTerminalResponseBody(
  response: Response,
  callerSignal: AbortSignal,
  control: ProviderRequestControl,
  inactivityTimeoutMs: number,
  providerName: string,
): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return "";

  const decoder = new TextDecoder();
  const liveness: ProviderInactivityControl = {
    timeoutMs: inactivityTimeoutMs,
    abort: control.abortForStreamInactivity,
    timedOut: () => control.termination() === "stream_inactivity_timeout",
  };
  let text = "";
  let activityDeadline = Date.now() + liveness.timeoutMs;
  let reachedEof = false;
  try {
    for (;;) {
      const { done, value } = await readWithProviderInactivityDeadline(
        reader,
        activityDeadline,
        liveness,
      );
      if (done) {
        reachedEof = true;
        break;
      }
      text += decoder.decode(value, { stream: true });
      activityDeadline = Date.now() + liveness.timeoutMs;
    }
    return text + decoder.decode();
  } catch (error) {
    if (liveness.timedOut()) {
      throw new KeelError(
        "stream_inactivity_timeout",
        `${providerName} response body timed out waiting for activity`,
      );
    }
    throw transportError(
      error,
      callerSignal,
      providerName,
      `${providerName} response body failed before streaming`,
    );
  } finally {
    if (!reachedEof) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
}

export async function* requestChatCompletions(
  config: ProviderConfig,
  requestBody: () => string,
  signal: AbortSignal,
  providerName: string,
  retry: ProviderRetryController,
  providerRequestAttempts: ProviderRequestAttemptObserver | null,
  retryCoordination: ProviderRetryCoordination | undefined,
  requestConcurrency: ProviderRequestConcurrency | undefined,
): AsyncGenerator<LLMEvent, ChatCompletionsResponse> {
  const liveness = resolveProviderLivenessConfig(config.liveness);
  for (;;) {
    const body = requestBody();
    const providerRequestSlot =
      requestConcurrency === undefined
        ? unboundedProviderRequestSlot
        : await requestConcurrency.acquire(signal);
    let providerRequestSlotReleased = false;
    const releaseProviderRequestSlot = (): void => {
      if (providerRequestSlotReleased) return;
      providerRequestSlotReleased = true;
      providerRequestSlot.release();
    };
    let attempt: ProviderRequestAttemptHandle | null;
    try {
      attempt = providerRequestAttempts?.begin() ?? null;
    } catch (error) {
      releaseProviderRequestSlot();
      throw error;
    }
    const requestControl = createProviderRequestControl(
      signal,
      liveness.firstResponseTimeoutMs,
    );
    let response: Response;
    try {
      response = await fetch(chatCompletionsUrl(config.baseUrl), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body,
        signal: requestControl.signal,
      });
      requestControl.responseReceived();
    } catch (error) {
      const failure = firstResponseFailure(
        requestControl,
        error,
        signal,
        providerName,
      );
      if (failure.outcome === "aborted") {
        attempt?.finish({ outcome: "aborted" });
        requestControl.close();
        releaseProviderRequestSlot();
        throw failure.error;
      }
      const decision = coordinatedRetryDecision(
        retry.transportDecision(failure.reason),
        retryCoordination,
      );
      if (decision === null) {
        attempt?.finish({
          outcome: "terminal_error",
          errorCode: failure.reason,
        });
        requestControl.close();
        releaseProviderRequestSlot();
        throw failure.error;
      }
      attempt?.finish({
        outcome: "retryable_error",
        retryDecision: requestRetryDecisionForReport(providerName, decision),
      });
      requestControl.close();
      releaseProviderRequestSlot();
      yield* waitForProviderRetry(retry, providerName, signal, decision);
      continue;
    }

    if (response.ok) {
      return {
        response,
        attempt,
        abortForStreamInactivity: requestControl.abortForStreamInactivity,
        streamInactivityTimedOut: () =>
          requestControl.termination() === "stream_inactivity_timeout",
        close: () => {
          requestControl.close();
          releaseProviderRequestSlot();
        },
      };
    }

    const retryDecision = coordinatedRetryDecision(
      retry.responseDecision(response),
      retryCoordination,
    );
    if (retryDecision !== null) {
      await discardResponseBody(response);
      attempt?.finish({
        outcome: "retryable_error",
        retryDecision: requestRetryDecisionForReport(
          providerName,
          retryDecision,
        ),
      });
      requestControl.close();
      releaseProviderRequestSlot();
      yield* waitForProviderRetry(retry, providerName, signal, retryDecision);
      continue;
    }

    let text: string;
    try {
      text = await readTerminalResponseBody(
        response,
        signal,
        requestControl,
        liveness.streamInactivityTimeoutMs,
        providerName,
      );
    } catch (error) {
      const keelError = transportError(
        error,
        signal,
        providerName,
        `${providerName} response body failed before streaming`,
      );
      attempt?.finish(
        /* v8 ignore next -- abort can race before or during response-body reading; provider conformance covers the same aborted physical-attempt result. */
        keelError.code === "provider_aborted"
          ? { outcome: "aborted" }
          : { outcome: "terminal_error", errorCode: keelError.code },
      );
      requestControl.close();
      releaseProviderRequestSlot();
      throw keelError;
    }
    const code = isContextOverflowHttpError(response.status, text)
      ? "provider_context_overflow"
      : httpErrorCode(response.status);
    attempt?.finish(
      code === "provider_context_overflow"
        ? { outcome: "context_overflow" }
        : { outcome: "terminal_error", errorCode: code },
    );
    requestControl.close();
    releaseProviderRequestSlot();
    throw new KeelError(
      code,
      `${providerName} API error (${response.status}): ${text}`,
    );
  }
}
