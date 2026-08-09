import { isAbortThrow, KeelError } from "../core/error.ts";
import type {
  LLMProvider,
  ProviderRequestConcurrency,
  ProviderRequestSlot,
  ProviderRetryCoordination,
} from "../llm/types.ts";

const DEFAULT_MAX_TREE_RETRIES = 4;
const DEFAULT_RETRY_SPACING_MS = 250;
const DEFAULT_MAX_TOTAL_RETRY_DELAY_MS = 120_000;
const MAX_CONCURRENT_PROVIDER_REQUESTS = 2;

interface PendingProviderRequest {
  readonly signal: AbortSignal;
  readonly resolve: (slot: ProviderRequestSlot) => void;
  readonly onAbort: () => void;
}

interface CreateSubagentTreeProviderOptions {
  readonly provider: LLMProvider;
  readonly now?: () => number;
  readonly maxTreeRetries?: number;
  readonly retrySpacingMs?: number;
  readonly maxTotalRetryDelayMs?: number;
}

export interface SubagentTreeProvider {
  readonly provider: LLMProvider;
  readonly blocked: () => boolean;
}

function opensTreeCircuit(error: unknown): error is KeelError & {
  readonly code: "provider_auth_failed" | "provider_rate_limited";
} {
  return (
    error instanceof KeelError &&
    (error.code === "provider_auth_failed" ||
      error.code === "provider_rate_limited")
  );
}

export function createSubagentTreeProvider(
  options: CreateSubagentTreeProviderOptions,
): SubagentTreeProvider {
  const maxTreeRetries = options.maxTreeRetries ?? DEFAULT_MAX_TREE_RETRIES;
  const retrySpacingMs = options.retrySpacingMs ?? DEFAULT_RETRY_SPACING_MS;
  const maxTotalRetryDelayMs =
    options.maxTotalRetryDelayMs ?? DEFAULT_MAX_TOTAL_RETRY_DELAY_MS;
  const circuit = new AbortController();
  let retryCount = 0;
  let totalRetryDelayMs = 0;
  let nextRetryAtMs = 0;
  let activeProviderRequests = 0;
  const pendingProviderRequests: PendingProviderRequest[] = [];

  const now = options.now ?? Date.now;
  const retryCoordination: ProviderRetryCoordination = {
    reserveRetry: ({ suggestedDelayMs }) => {
      if (retryCount >= maxTreeRetries) return null;
      const observedNow = now();
      const requestedStartMs =
        observedNow + Math.max(retrySpacingMs, suggestedDelayMs);
      const retryAtMs = Math.max(requestedStartMs, nextRetryAtMs);
      const delayMs = retryAtMs - observedNow;
      if (totalRetryDelayMs + delayMs > maxTotalRetryDelayMs) return null;
      retryCount++;
      totalRetryDelayMs += delayMs;
      nextRetryAtMs = retryAtMs + retrySpacingMs;
      return delayMs;
    },
  };
  const providerRequestSlot = (): ProviderRequestSlot => {
    activeProviderRequests++;
    let release = (): void => {
      release = () => {};
      activeProviderRequests--;
      const pending = pendingProviderRequests.shift();
      if (pending === undefined) return;
      pending.signal.removeEventListener("abort", pending.onAbort);
      pending.resolve(providerRequestSlot());
    };
    return {
      release: () => release(),
    };
  };
  const providerRequestConcurrency: ProviderRequestConcurrency = {
    acquire: (signal) => {
      if (signal.aborted) {
        return Promise.reject(
          new KeelError("provider_aborted", "provider request was aborted"),
        );
      }
      if (activeProviderRequests < MAX_CONCURRENT_PROVIDER_REQUESTS) {
        return Promise.resolve(providerRequestSlot());
      }
      return new Promise<ProviderRequestSlot>((resolve, reject) => {
        const onAbort = () => {
          const index = pendingProviderRequests.indexOf(pending);
          pendingProviderRequests.splice(index, 1);
          reject(
            new KeelError("provider_aborted", "provider request was aborted"),
          );
        };
        const pending: PendingProviderRequest = {
          signal,
          resolve,
          onAbort,
        };
        pendingProviderRequests.push(pending);
        signal.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
  const openCircuit = (error: KeelError): void => {
    circuit.abort(error);
  };
  const provider: LLMProvider = {
    ...options.provider,
    async *stream(streamOptions) {
      if (circuit.signal.aborted) throw circuit.signal.reason;
      const treeSignal = AbortSignal.any([
        streamOptions.signal,
        circuit.signal,
      ]);
      try {
        yield* options.provider.stream({
          ...streamOptions,
          signal: treeSignal,
          providerRetryCoordination: retryCoordination,
          providerRequestConcurrency,
        });
      } catch (error) {
        if (opensTreeCircuit(error)) {
          openCircuit(error);
          throw error;
        }
        if (
          circuit.signal.aborted &&
          !streamOptions.signal.aborted &&
          isAbortThrow(error, treeSignal)
        ) {
          throw circuit.signal.reason;
        }
        throw error;
      }
    },
  };

  return { provider, blocked: () => circuit.signal.aborted };
}
