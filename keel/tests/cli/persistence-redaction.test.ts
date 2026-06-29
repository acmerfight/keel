import { describe, expect, test } from "vitest";
import { redactTextForPersistence } from "../../src/cli/persistence-redaction.ts";

describe("CLI Persistence Redaction", () => {
  test(`Given a persisted transcript line ends with the word Bearer,
    When redaction scans the provider-visible text,
    Then it preserves the line break and the next benign word`, () => {
    // Given
    const text = "Use the word Bearer\nauthorization is required for access.";

    // When
    const redacted = redactTextForPersistence(text);

    // Then
    expect(redacted).toBe(text);
  });

  test(`Given a persisted transcript contains a bearer token on one line,
    When redaction scans the provider-visible text,
    Then it redacts the token without changing surrounding lines`, () => {
    // Given
    const text = "before\nAuthorization: Bearer live-secret-token-270\nafter";

    // When
    const redacted = redactTextForPersistence(text);

    // Then
    expect(redacted).toBe(
      "before\nAuthorization: Bearer [REDACTED_SECRET]\nafter",
    );
  });
});
