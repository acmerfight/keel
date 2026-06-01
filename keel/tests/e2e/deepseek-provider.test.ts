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

async function collect(stream: AsyncIterable<LLMEvent>): Promise<LLMEvent[]> {
  const events: LLMEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
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

  test(`Given the API returns an HTTP error,
    When provider attempts to stream,
    Then it throws with status and message`, async () => {
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
        }),
      ),
    ).rejects.toThrow(/DeepSeek API error \(401\)/);
  });

  test(`Given the stream ends without [DONE] signal,
    When provider finishes reading,
    Then it throws an error`, async () => {
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
        }),
      ),
    ).rejects.toThrow("DeepSeek stream ended without [DONE] signal");
  });

  test(`Given the model hits max tokens,
    When finish_reason is "length",
    Then provider throws instead of yielding stop`, async () => {
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
        }),
      ),
    ).rejects.toThrow("DeepSeek stream finished with reason: length");
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
      }),
    );

    // Then
    const parsed = JSON.parse(capturedBody);
    expect(parsed.stream_options).toEqual({ include_usage: true });

    captureServer.close();
  });
});
