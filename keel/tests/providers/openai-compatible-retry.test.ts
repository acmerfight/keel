import { createServer } from "node:http";
import { describe, expect, test } from "vitest";
import { KeelError } from "../../src/core/error.ts";
import { createOpenAICompatibleProvider } from "../../src/llm/providers/openai-compatible.ts";
import { transportError } from "../../src/llm/providers/openai-compatible-retry.ts";
import type { LLMEvent } from "../../src/llm/types.ts";
import {
  close,
  getPort,
  listen,
} from "../../src/testing/provider-sse-fixtures.ts";

class AbortCodeError extends Error {
  readonly code = "ABORT_ERR";
}

describe("OpenAI-Compatible Retry", () => {
  test(`Given a pre-output protocol error has the same message as a missing DONE signal,
    When the provider classifies stream replay eligibility,
    Then it does not retry without the structured missing-DONE marker`, async () => {
    // Given
    let requests = 0;
    const server = createServer((req, res) => {
      requests++;
      req.resume();
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.end('data: {"choices":[{"delta":{"content":"ignored"}}]}\n\n');
    });
    await listen(server);

    try {
      const provider = createOpenAICompatibleProvider({
        id: "test-provider",
        providerName: "TestProvider",
        config: {
          apiKey: "test-key",
          baseUrl: `http://127.0.0.1:${getPort(server)}`,
          model: "test-model",
          retry: {
            maxRetries: 1,
            initialDelayMs: 0,
            maxDelayMs: 0,
            jitterRatio: 0,
          },
        },
        parseChunk: () => {
          throw new KeelError(
            "provider_protocol_error",
            "TestProvider stream ended without [DONE] signal",
          );
        },
        captureUsage: () => {},
      });
      const events: LLMEvent[] = [];

      // When / Then
      await expect(
        (async () => {
          for await (const event of provider.stream({
            systemPrompt: "You are helpful.",
            messages: [{ role: "user", content: "hi" }],
            signal: new AbortController().signal,
          })) {
            events.push(event);
          }
        })(),
      ).rejects.toMatchObject({
        name: "KeelError",
        code: "provider_protocol_error",
        message: "TestProvider stream ended without [DONE] signal",
      });
      expect(events).toEqual([]);
      expect(requests).toBe(1);
    } finally {
      await close(server);
    }
  });

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
