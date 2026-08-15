import { describe, expect, test, vi } from "vitest";
import { combineProviderRequestAttemptObservers } from "../../src/agent/provider-request-attempts.ts";
import type {
  ProviderRequestAttemptFinish,
  ProviderRequestAttemptObserver,
} from "../../src/llm/types.ts";

const COMPLETED: ProviderRequestAttemptFinish = {
  outcome: "completed",
  usage: {
    inputTokens: 1,
    cachedInputTokens: 0,
    uncachedInputTokens: 1,
    outputTokens: 1,
  },
};

describe("provider request attempt observer composition", () => {
  test(`Given zero or one provider attempt observer,
    When observers are combined,
    Then composition preserves the empty and identity cases`, () => {
    const observer: ProviderRequestAttemptObserver = {
      begin: () => ({ finish: () => {} }),
    };

    expect(combineProviderRequestAttemptObservers([])).toBeUndefined();
    expect(combineProviderRequestAttemptObservers([undefined, observer])).toBe(
      observer,
    );
  });

  test(`Given multiple provider attempt observers,
    When one physical request finishes,
    Then every observer receives the same settlement`, () => {
    const firstFinish = vi.fn();
    const secondFinish = vi.fn();
    const combined = combineProviderRequestAttemptObservers([
      { begin: () => ({ finish: firstFinish }) },
      { begin: () => ({ finish: secondFinish }) },
    ]);
    if (combined === undefined) throw new Error("missing combined observer");

    combined.begin().finish(COMPLETED);

    expect(firstFinish).toHaveBeenCalledWith(COMPLETED);
    expect(secondFinish).toHaveBeenCalledWith(COMPLETED);
  });

  test(`Given a later observer cannot begin a physical request,
    When composition unwinds the partial start,
    Then every opened observer is terminally settled before the error escapes`, () => {
    const firstFinish = vi.fn();
    const beginError = new Error("begin failed");
    const combined = combineProviderRequestAttemptObservers([
      { begin: () => ({ finish: firstFinish }) },
      {
        begin: () => {
          throw beginError;
        },
      },
    ]);
    if (combined === undefined) throw new Error("missing combined observer");

    expect(() => combined.begin()).toThrow(beginError);
    expect(firstFinish).toHaveBeenCalledWith({
      outcome: "terminal_error",
      errorCode: "provider_unexpected_error",
    });
  });

  test(`Given multiple observer finishes throw,
    When the combined request settles,
    Then all finishes run and the first error is rethrown`, () => {
    const firstError = new Error("first finish failed");
    const finalFinish = vi.fn();
    const combined = combineProviderRequestAttemptObservers([
      {
        begin: () => ({
          finish: () => {
            throw firstError;
          },
        }),
      },
      {
        begin: () => ({
          finish: () => {
            throw new Error("second finish failed");
          },
        }),
      },
      { begin: () => ({ finish: finalFinish }) },
    ]);
    if (combined === undefined) throw new Error("missing combined observer");

    expect(() => combined.begin().finish(COMPLETED)).toThrow(firstError);
    expect(finalFinish).toHaveBeenCalledWith(COMPLETED);
  });
});
