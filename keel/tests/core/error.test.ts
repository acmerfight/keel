import { describe, expect, test } from "vitest";
import { errorMessage } from "../../src/core/error.ts";

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
