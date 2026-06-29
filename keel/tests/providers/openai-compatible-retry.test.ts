import { describe, expect, test } from "vitest";
import { transportError } from "../../src/llm/providers/openai-compatible-retry.ts";

class AbortCodeError extends Error {
  readonly code = "ABORT_ERR";
}

describe("OpenAI-Compatible Retry", () => {
  test(`Given a transport throw carries the Node abort error code,
    When the provider retry layer classifies the failure,
    Then it reports an aborted provider request`, () => {
    // Given
    const signal = new AbortController().signal;
    const error = new AbortCodeError("operation aborted");

    // When
    const classified = transportError(
      error,
      signal,
      "TestProvider",
      "TestProvider request failed before response",
    );

    // Then
    expect(classified).toMatchObject({
      name: "KeelError",
      code: "provider_aborted",
      message: "TestProvider request was aborted",
    });
  });
});
