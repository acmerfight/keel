import type {
  ProviderRequestAttemptHandle,
  ProviderRequestAttemptObserver,
} from "../llm/types.ts";

export function combineProviderRequestAttemptObservers(
  observers: readonly (ProviderRequestAttemptObserver | undefined)[],
): ProviderRequestAttemptObserver | undefined {
  const active = observers.filter(
    (observer): observer is ProviderRequestAttemptObserver =>
      observer !== undefined,
  );
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];
  return {
    begin: (): ProviderRequestAttemptHandle => {
      const handles: ProviderRequestAttemptHandle[] = [];
      try {
        for (const observer of active) {
          handles.push(observer.begin());
        }
      } catch (error) {
        for (const handle of handles) {
          handle.finish({
            outcome: "terminal_error",
            errorCode: "provider_unexpected_error",
          });
        }
        throw error;
      }
      return {
        finish: (result) => {
          let firstError: unknown;
          for (const handle of handles) {
            try {
              handle.finish(result);
            } catch (error) {
              firstError ??= error;
            }
          }
          if (firstError !== undefined) throw firstError;
        },
      };
    },
  };
}
