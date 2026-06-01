import { createServer } from "node:http";
import type { Server } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createDeepseekProvider } from "../../src/llm/providers/deepseek.ts";
import type { LLMEvent } from "../../src/llm/types.ts";

function getPort(server: Server): number {
  const addr = server.address();
  if (addr === null || typeof addr === "string") {
    throw new Error("Server not listening on a TCP port");
  }
  return addr.port;
}

function sseChunk(content: string): string {
  const chunk = JSON.stringify({
    choices: [{ delta: { content } }],
  });
  return `data: ${chunk}\n\n`;
}

function sseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function sseFinish(
  inputTokens: number,
  outputTokens: number,
  finishReason = "stop",
): string {
  const chunk = JSON.stringify({
    choices: [{ delta: {}, finish_reason: finishReason }],
    usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens },
  });
  return `data: ${chunk}\n\ndata: [DONE]\n\n`;
}

function sseFinishWithoutTrailingNewline(
  inputTokens: number,
  outputTokens: number,
): string {
  const chunk = JSON.stringify({
    choices: [{ delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens },
  });
  return `data: ${chunk}\n\ndata: [DONE]`;
}

function sseFinishWithoutUsage(): string {
  const chunk = JSON.stringify({
    choices: [{ delta: {}, finish_reason: "stop" }],
  });
  return `data: ${chunk}\n\ndata: [DONE]\n\n`;
}

async function collect(stream: AsyncIterable<LLMEvent>): Promise<LLMEvent[]> {
  const events: LLMEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

function freshSignal(): AbortSignal {
  return new AbortController().signal;
}

async function unusedLocalPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => {
    probe.listen(0, "127.0.0.1", resolve);
  });
  const port = getPort(probe);
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  return port;
}

describe("DeepSeek Provider", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = req.url ?? "";

      if (url === "/v1/chat/completions") {
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          const parsed = JSON.parse(body);

          if (parsed.messages?.[1]?.content === "trigger-error") {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: { message: "Invalid API key" } }));
            return;
          }

          if (parsed.messages?.[1]?.content === "forbidden") {
            res.writeHead(403, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: { message: "Forbidden" } }));
            return;
          }

          if (parsed.messages?.[1]?.content === "rate-limited") {
            res.writeHead(429, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: { message: "Rate limited" } }));
            return;
          }

          if (parsed.messages?.[1]?.content === "server-error") {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: { message: "Server error" } }));
            return;
          }

          if (parsed.messages?.[1]?.content === "bad-request") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: { message: "Bad request" } }));
            return;
          }

          if (parsed.messages?.[1]?.content === "no-body") {
            res.writeHead(204);
            res.end();
            return;
          }

          if (parsed.messages?.[1]?.content === "truncated") {
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            });
            res.write(sseChunk("partial"));
            res.end();
            return;
          }

          if (parsed.messages?.[1]?.content === "length-limit") {
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            });
            res.write(sseChunk("partial output"));
            res.write(sseFinish(10, 4096, "length"));
            res.end();
            return;
          }

          if (parsed.messages?.[1]?.content === "invalid-json") {
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            });
            res.write("data: {not-json}\n\n");
            res.write(sseFinish(1, 1));
            res.end();
            return;
          }

          if (parsed.messages?.[1]?.content === "invalid-choices") {
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            });
            res.write(sseData({ choices: null }));
            res.write(sseFinish(1, 1));
            res.end();
            return;
          }

          if (parsed.messages?.[1]?.content === "invalid-usage") {
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            });
            res.write(sseChunk("metered output"));
            res.write(
              sseData({
                choices: [{ delta: {}, finish_reason: "stop" }],
                usage: { prompt_tokens: "7", completion_tokens: 3 },
              }),
            );
            res.write("data: [DONE]\n\n");
            res.end();
            return;
          }

          if (
            parsed.messages?.[1]?.content === "usage-null-before-final-usage"
          ) {
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            });
            res.write(
              sseData({
                choices: [{ delta: { content: "metered" } }],
                usage: null,
              }),
            );
            res.write(sseFinish(8, 4));
            res.end();
            return;
          }

          if (parsed.messages?.[1]?.content === "done-without-final-newline") {
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            });
            res.write(sseChunk("complete"));
            res.write(sseFinishWithoutTrailingNewline(7, 3));
            res.end();
            return;
          }

          if (parsed.messages?.[1]?.content === "missing-usage") {
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            });
            res.write(sseChunk("metered output"));
            res.write(sseFinishWithoutUsage());
            res.end();
            return;
          }

          if (parsed.messages?.[1]?.content === "abort-during-stream") {
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            });
            res.write(sseChunk("partial"));
            return;
          }

          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          res.write(sseChunk("Hello"));
          res.write(sseChunk(" world"));
          res.write(sseFinish(10, 5));
          res.end();
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    baseUrl = `http://127.0.0.1:${getPort(server)}`;
  });

  afterAll(() => {
    server.close();
  });

  test(`Given a DeepSeek-compatible API,
    When provider streams a response,
    Then text chunks and usage are correctly parsed`, async () => {
    // Given
    const provider = createDeepseekProvider({
      apiKey: "test-key",
      baseUrl,
      model: "deepseek-v4-flash",
    });

    // When
    const events = await collect(
      provider.stream({
        systemPrompt: "You are helpful.",
        messages: [{ role: "user", content: "hi" }],
        signal: freshSignal(),
      }),
    );

    // Then
    const textEvents = events.filter((e) => e.type === "text");
    expect(textEvents.map((e) => e.text).join("")).toBe("Hello world");

    const stopEvent = events.find((e) => e.type === "stop");
    expect(stopEvent).toEqual({
      type: "stop",
      usage: { inputTokens: 10, outputTokens: 5 },
    });
  });

  test(`Given the API rejects authentication,
    When provider attempts to stream,
    Then it throws an auth error with status and message`, async () => {
    // Given
    const provider = createDeepseekProvider({
      apiKey: "bad-key",
      baseUrl,
      model: "deepseek-v4-flash",
    });

    // When / Then
    await expect(
      collect(
        provider.stream({
          systemPrompt: "You are helpful.",
          messages: [{ role: "user", content: "trigger-error" }],
          signal: freshSignal(),
        }),
      ),
    ).rejects.toMatchObject({
      name: "KeelError",
      code: "provider_auth_failed",
      message: expect.stringMatching(/DeepSeek API error \(401\)/),
    });
  });

  test(`Given the API rejects authorization,
    When provider attempts to stream,
    Then it throws an auth error with status and message`, async () => {
    // Given
    const provider = createDeepseekProvider({
      apiKey: "test-key",
      baseUrl,
      model: "deepseek-v4-flash",
    });

    // When / Then
    await expect(
      collect(
        provider.stream({
          systemPrompt: "You are helpful.",
          messages: [{ role: "user", content: "forbidden" }],
          signal: freshSignal(),
        }),
      ),
    ).rejects.toMatchObject({
      name: "KeelError",
      code: "provider_auth_failed",
      message: expect.stringMatching(/DeepSeek API error \(403\)/),
    });
  });

  test(`Given the API rate limits the request,
    When provider attempts to stream,
    Then it throws a rate limit error with status and message`, async () => {
    // Given
    const provider = createDeepseekProvider({
      apiKey: "test-key",
      baseUrl,
      model: "deepseek-v4-flash",
    });

    // When / Then
    await expect(
      collect(
        provider.stream({
          systemPrompt: "You are helpful.",
          messages: [{ role: "user", content: "rate-limited" }],
          signal: freshSignal(),
        }),
      ),
    ).rejects.toMatchObject({
      name: "KeelError",
      code: "provider_rate_limited",
      message: expect.stringMatching(/DeepSeek API error \(429\)/),
    });
  });

  test(`Given the API returns a server error,
    When provider attempts to stream,
    Then it throws a provider server error with status and message`, async () => {
    // Given
    const provider = createDeepseekProvider({
      apiKey: "test-key",
      baseUrl,
      model: "deepseek-v4-flash",
    });

    // When / Then
    await expect(
      collect(
        provider.stream({
          systemPrompt: "You are helpful.",
          messages: [{ role: "user", content: "server-error" }],
          signal: freshSignal(),
        }),
      ),
    ).rejects.toMatchObject({
      name: "KeelError",
      code: "provider_server_error",
      message: expect.stringMatching(/DeepSeek API error \(500\)/),
    });
  });

  test(`Given the API returns another HTTP error,
    When provider attempts to stream,
    Then it throws a provider HTTP error with status and message`, async () => {
    // Given
    const provider = createDeepseekProvider({
      apiKey: "test-key",
      baseUrl,
      model: "deepseek-v4-flash",
    });

    // When / Then
    await expect(
      collect(
        provider.stream({
          systemPrompt: "You are helpful.",
          messages: [{ role: "user", content: "bad-request" }],
          signal: freshSignal(),
        }),
      ),
    ).rejects.toMatchObject({
      name: "KeelError",
      code: "provider_http_error",
      message: expect.stringMatching(/DeepSeek API error \(400\)/),
    });
  });

  test(`Given the API returns success without a response body,
    When provider attempts to stream,
    Then it throws a protocol error`, async () => {
    // Given
    const provider = createDeepseekProvider({
      apiKey: "test-key",
      baseUrl,
      model: "deepseek-v4-flash",
    });

    // When / Then
    await expect(
      collect(
        provider.stream({
          systemPrompt: "You are helpful.",
          messages: [{ role: "user", content: "no-body" }],
          signal: freshSignal(),
        }),
      ),
    ).rejects.toMatchObject({
      name: "KeelError",
      code: "provider_protocol_error",
      message: "DeepSeek API returned no response body",
    });
  });

  test(`Given the stream ends without [DONE] signal,
    When provider finishes reading,
    Then it throws a protocol error`, async () => {
    // Given
    const provider = createDeepseekProvider({
      apiKey: "test-key",
      baseUrl,
      model: "deepseek-v4-flash",
    });

    // When / Then
    await expect(
      collect(
        provider.stream({
          systemPrompt: "You are helpful.",
          messages: [{ role: "user", content: "truncated" }],
          signal: freshSignal(),
        }),
      ),
    ).rejects.toMatchObject({
      name: "KeelError",
      code: "provider_protocol_error",
      message: "DeepSeek stream ended without [DONE] signal",
    });
  });

  test(`Given the model hits max tokens,
    When finish_reason is "length",
    Then provider throws a protocol error instead of yielding stop`, async () => {
    // Given
    const provider = createDeepseekProvider({
      apiKey: "test-key",
      baseUrl,
      model: "deepseek-v4-flash",
    });

    // When / Then
    await expect(
      collect(
        provider.stream({
          systemPrompt: "You are helpful.",
          messages: [{ role: "user", content: "length-limit" }],
          signal: freshSignal(),
        }),
      ),
    ).rejects.toMatchObject({
      name: "KeelError",
      code: "provider_protocol_error",
      message: "DeepSeek stream finished with reason: length",
    });
  });

  test(`Given a stream chunk contains invalid JSON,
    When provider reads the chunk,
    Then it throws a protocol error`, async () => {
    // Given
    const provider = createDeepseekProvider({
      apiKey: "test-key",
      baseUrl,
      model: "deepseek-v4-flash",
    });

    // When / Then
    await expect(
      collect(
        provider.stream({
          systemPrompt: "You are helpful.",
          messages: [{ role: "user", content: "invalid-json" }],
          signal: freshSignal(),
        }),
      ),
    ).rejects.toMatchObject({
      name: "KeelError",
      code: "provider_protocol_error",
      message: "DeepSeek stream chunk has invalid JSON",
    });
  });

  test(`Given a stream chunk has invalid choices,
    When provider reads the chunk,
    Then it throws a protocol error`, async () => {
    // Given
    const provider = createDeepseekProvider({
      apiKey: "test-key",
      baseUrl,
      model: "deepseek-v4-flash",
    });

    // When / Then
    await expect(
      collect(
        provider.stream({
          systemPrompt: "You are helpful.",
          messages: [{ role: "user", content: "invalid-choices" }],
          signal: freshSignal(),
        }),
      ),
    ).rejects.toMatchObject({
      name: "KeelError",
      code: "provider_protocol_error",
      message: "DeepSeek stream chunk has invalid schema",
    });
  });

  test(`Given a stream chunk has invalid usage tokens,
    When provider reads the chunk,
    Then it throws a protocol error`, async () => {
    // Given
    const provider = createDeepseekProvider({
      apiKey: "test-key",
      baseUrl,
      model: "deepseek-v4-flash",
    });

    // When / Then
    await expect(
      collect(
        provider.stream({
          systemPrompt: "You are helpful.",
          messages: [{ role: "user", content: "invalid-usage" }],
          signal: freshSignal(),
        }),
      ),
    ).rejects.toMatchObject({
      name: "KeelError",
      code: "provider_protocol_error",
      message: "DeepSeek stream chunk has invalid schema",
    });
  });

  test(`Given a stream chunk contains null usage before final usage,
    When provider reads the stream,
    Then it ignores null usage and reports the final usage`, async () => {
    // Given
    const provider = createDeepseekProvider({
      apiKey: "test-key",
      baseUrl,
      model: "deepseek-v4-flash",
    });

    // When
    const events = await collect(
      provider.stream({
        systemPrompt: "You are helpful.",
        messages: [{ role: "user", content: "usage-null-before-final-usage" }],
        signal: freshSignal(),
      }),
    );

    // Then
    const textEvents = events.filter((e) => e.type === "text");
    expect(textEvents.map((e) => e.text).join("")).toBe("metered");

    const stopEvent = events.find((e) => e.type === "stop");
    expect(stopEvent).toEqual({
      type: "stop",
      usage: { inputTokens: 8, outputTokens: 4 },
    });
  });

  test(`Given the final DONE line has no trailing newline,
    When provider finishes reading,
    Then it still parses the final signal and usage`, async () => {
    // Given
    const provider = createDeepseekProvider({
      apiKey: "test-key",
      baseUrl,
      model: "deepseek-v4-flash",
    });

    // When
    const events = await collect(
      provider.stream({
        systemPrompt: "You are helpful.",
        messages: [{ role: "user", content: "done-without-final-newline" }],
        signal: freshSignal(),
      }),
    );

    // Then
    const textEvents = events.filter((e) => e.type === "text");
    expect(textEvents.map((e) => e.text).join("")).toBe("complete");

    const stopEvent = events.find((e) => e.type === "stop");
    expect(stopEvent).toEqual({
      type: "stop",
      usage: { inputTokens: 7, outputTokens: 3 },
    });
  });

  test(`Given the stream ends without usage,
    When provider finishes reading,
    Then it throws a protocol error instead of reporting zero tokens`, async () => {
    // Given
    const provider = createDeepseekProvider({
      apiKey: "test-key",
      baseUrl,
      model: "deepseek-v4-flash",
    });

    // When / Then
    await expect(
      collect(
        provider.stream({
          systemPrompt: "You are helpful.",
          messages: [{ role: "user", content: "missing-usage" }],
          signal: freshSignal(),
        }),
      ),
    ).rejects.toMatchObject({
      name: "KeelError",
      code: "provider_protocol_error",
      message: "DeepSeek stream ended without usage",
    });
  });

  test(`Given the caller aborts the request,
    When provider attempts to stream,
    Then it throws an aborted provider error`, async () => {
    // Given
    const provider = createDeepseekProvider({
      apiKey: "test-key",
      baseUrl,
      model: "deepseek-v4-flash",
    });
    const controller = new AbortController();
    controller.abort();

    // When / Then
    await expect(
      collect(
        provider.stream({
          systemPrompt: "You are helpful.",
          messages: [{ role: "user", content: "hi" }],
          signal: controller.signal,
        }),
      ),
    ).rejects.toMatchObject({
      name: "KeelError",
      code: "provider_aborted",
      message: "DeepSeek request was aborted",
    });
  });

  test(`Given the provider cannot connect to the API,
    When provider attempts to stream,
    Then it throws a provider network error`, async () => {
    // Given
    const port = await unusedLocalPort();
    const provider = createDeepseekProvider({
      apiKey: "test-key",
      baseUrl: `http://127.0.0.1:${port}`,
      model: "deepseek-v4-flash",
    });

    // When / Then
    await expect(
      collect(
        provider.stream({
          systemPrompt: "You are helpful.",
          messages: [{ role: "user", content: "hi" }],
          signal: freshSignal(),
        }),
      ),
    ).rejects.toMatchObject({
      name: "KeelError",
      code: "provider_network_error",
      message: "DeepSeek request failed before response",
    });
  });

  test(`Given the caller aborts while streaming,
    When provider reads the next chunk,
    Then it throws an aborted provider error`, async () => {
    // Given
    const provider = createDeepseekProvider({
      apiKey: "test-key",
      baseUrl,
      model: "deepseek-v4-flash",
    });
    const controller = new AbortController();
    const iterator = provider
      .stream({
        systemPrompt: "You are helpful.",
        messages: [{ role: "user", content: "abort-during-stream" }],
        signal: controller.signal,
      })
      [Symbol.asyncIterator]();

    // When
    const first = await iterator.next();
    controller.abort();

    // Then
    expect(first).toEqual({
      done: false,
      value: { type: "text", text: "partial" },
    });
    await expect(iterator.next()).rejects.toMatchObject({
      name: "KeelError",
      code: "provider_aborted",
      message: "DeepSeek request was aborted",
    });
  });

  test(`Given a streaming request,
    When provider sends the body,
    Then it includes stream_options with include_usage`, async () => {
    // Given
    let capturedBody = "";
    const captureServer = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        capturedBody = body;
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(sseChunk("ok"));
        res.write(sseFinish(1, 1));
        res.end();
      });
    });
    await new Promise<void>((resolve) => {
      captureServer.listen(0, "127.0.0.1", resolve);
    });
    const provider = createDeepseekProvider({
      apiKey: "test-key",
      baseUrl: `http://127.0.0.1:${getPort(captureServer)}`,
      model: "deepseek-v4-flash",
    });

    // When
    await collect(
      provider.stream({
        systemPrompt: "sys",
        messages: [{ role: "user", content: "hi" }],
        signal: freshSignal(),
      }),
    );

    // Then
    const parsed = JSON.parse(capturedBody);
    expect(parsed.stream_options).toEqual({ include_usage: true });

    captureServer.close();
  });
});
