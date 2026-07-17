import { describe, expect, test } from "vitest";
import { errorMessage, isAbortThrow, KeelError } from "../../src/core/error.ts";

class AbortCodeError extends Error {
  readonly code = "ABORT_ERR";
}

const normalizedAbortCodes: readonly ("provider_aborted" | "tool_aborted")[] = [
  "provider_aborted",
  "tool_aborted",
];

describe("Error Messages", () => {
  test(`Given an Error instance,
    When Keel formats the message,
    Then it returns the message without the error name`, () => {
    // Given
    const error = new SyntaxError("invalid JSON");

    // When
    const message = errorMessage(error);

    // Then
    expect(message).toBe("invalid JSON");
  });

  test(`Given a non-Error throw value,
    When Keel formats the message,
    Then it preserves the string representation`, () => {
    // Given
    const error = "plain failure";

    // When
    const message = errorMessage(error);

    // Then
    expect(message).toBe("plain failure");
  });
});

describe("Abort Throws", () => {
  test(`Given an AbortError,
    When Keel checks whether the throw is cancellation,
    Then it treats the throw as an abort`, () => {
    // Given
    const error = new Error("operation aborted");
    error.name = "AbortError";

    // When
    const isAbort = isAbortThrow(error);

    // Then
    expect(isAbort).toBe(true);
  });

  test(`Given a Node abort error code,
    When Keel checks whether the throw is cancellation,
    Then it treats the throw as an abort`, () => {
    // Given
    const error = new AbortCodeError("operation aborted");

    // When
    const isAbort = isAbortThrow(error);

    // Then
    expect(isAbort).toBe(true);
  });

  test.each(normalizedAbortCodes)(`Given a normalized %s Keel error,
    When Keel checks whether the throw is cancellation,
    Then it preserves the abort classification across runtime boundaries`, (code) => {
    expect(isAbortThrow(new KeelError(code, "operation aborted"))).toBe(true);
  });

  test(`Given an aborted signal,
    When Keel checks whether any throw belongs to that signal,
    Then it treats the throw as an abort`, () => {
    // Given
    const abortController = new AbortController();
    abortController.abort();
    const error = new Error("network failed while aborting");

    // When
    const isAbort = isAbortThrow(error, abortController.signal);

    // Then
    expect(isAbort).toBe(true);
  });

  test(`Given an ordinary error and live signal,
    When Keel checks whether the throw is cancellation,
    Then it does not treat the throw as an abort`, () => {
    // Given
    const error = new Error("network failed");
    const signal = new AbortController().signal;

    // When
    const isAbort = isAbortThrow(error, signal);

    // Then
    expect(isAbort).toBe(false);
  });
});
