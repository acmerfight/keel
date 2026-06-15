import { createServer, type ServerResponse } from "node:http";
import type { Server } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";
import { createQwenProvider } from "../../src/llm/providers/qwen.ts";
import type { LLMEvent } from "../../src/llm/types.ts";

function getPort(server: Server): number {
  const addr = server.address();
  if (addr === null || typeof addr === "string") {
    throw new Error("Server not listening on a TCP port");
  }
  return addr.port;
}

function sseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function writeSseResponse(
  res: ServerResponse,
  chunks: readonly string[],
): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  for (const chunk of chunks) {
    res.write(chunk);
  }
  res.end();
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

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

const qwenRequestBodySchema = z
  .object({
    model: z.string(),
    stream: z.literal(true),
    stream_options: z.object({ include_usage: z.literal(true) }),
    tool_choice: z.string().optional(),
    tools: z
      .array(
        z
          .object({
            function: z.object({ name: z.string() }).passthrough(),
          })
          .passthrough(),
      )
      .optional(),
    messages: z.array(z.object({ role: z.string() }).passthrough()),
  })
  .passthrough();

function parseQwenRequestBody(
  body: string,
): z.infer<typeof qwenRequestBodySchema> {
  return qwenRequestBodySchema.parse(JSON.parse(body));
}

describe("Qwen Provider", () => {
  let server: Server;
  let baseUrl: string;
  let capturedBody: z.infer<typeof qwenRequestBodySchema> | null = null;
  let capturedAuthorization: string | undefined;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url !== "/chat/completions") {
        res.writeHead(404);
        res.end();
        return;
      }

      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const parsed = parseQwenRequestBody(body);
        capturedBody = parsed;
        capturedAuthorization = req.headers.authorization;
        const userMessage = parsed.messages[1]?.content;

        if (userMessage === "use tool") {
          writeSseResponse(res, [
            sseData({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_qwen_read",
                        type: "function",
                        function: {
                          name: "read",
                          arguments: '{"path":"README.md"}',
                        },
                      },
                    ],
                  },
                },
              ],
            }),
            sseData({
              choices: [{ delta: {}, finish_reason: "tool_calls" }],
              usage: {
                prompt_tokens: 100,
                completion_tokens: 20,
                prompt_tokens_details: { cached_tokens: 25 },
              },
            }),
            "data: [DONE]\n\n",
          ]);
          return;
        }

        writeSseResponse(res, [
          sseData({
            choices: [
              {
                delta: {
                  reasoning_content: "internal thinking",
                  content: null,
                },
              },
            ],
          }),
          sseData({ choices: [{ delta: { content: "Hello from Qwen." } }] }),
          sseData({
            choices: [{ delta: {}, finish_reason: "stop" }],
          }),
          sseData({
            choices: [],
            usage: {
              prompt_tokens: 50,
              completion_tokens: 10,
              completion_tokens_details: {
                reasoning_tokens: 7,
                text_tokens: 10,
              },
              prompt_tokens_details: {
                cached_tokens: 5,
                text_tokens: 50,
              },
            },
          }),
          "data: [DONE]\n\n",
        ]);
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    baseUrl = `http://127.0.0.1:${getPort(server)}`;
  });

  afterAll(async () => {
    await closeServer(server);
  });

  test(`Given Qwen streams reasoning and final top-level usage,
    When Keel reads the stream,
    Then text and cached-token usage are normalized`, async () => {
    // Given
    const provider = createQwenProvider({
      apiKey: "test-qwen-key",
      baseUrl,
      model: "qwen3.7-plus",
    });

    // When
    const events = await collect(
      provider.stream({
        systemPrompt: "You are Keel.",
        messages: [{ role: "user", content: "hello" }],
        signal: freshSignal(),
      }),
    );

    // Then
    expect(capturedAuthorization).toBe("Bearer test-qwen-key");
    expect(capturedBody?.model).toBe("qwen3.7-plus");
    expect(capturedBody?.tool_choice).toBe("auto");
    expect(events).toEqual([
      { type: "text", text: "Hello from Qwen." },
      {
        type: "stop",
        usage: {
          inputTokens: 50,
          cachedInputTokens: 5,
          uncachedInputTokens: 45,
          outputTokens: 10,
        },
      },
    ]);
  });

  test(`Given Qwen requests a tool call,
    When Keel reads the stream,
    Then the tool call id and usage are preserved`, async () => {
    // Given
    const provider = createQwenProvider({
      apiKey: "test-qwen-key",
      baseUrl,
      model: "qwen3.7-plus",
    });

    // When
    const events = await collect(
      provider.stream({
        systemPrompt: "You are Keel.",
        messages: [{ role: "user", content: "use tool" }],
        signal: freshSignal(),
      }),
    );

    // Then
    expect(events).toEqual([
      {
        type: "tool_call",
        id: "call_qwen_read",
        tool: "read",
        path: "README.md",
      },
      {
        type: "stop",
        usage: {
          inputTokens: 100,
          cachedInputTokens: 25,
          uncachedInputTokens: 75,
          outputTokens: 20,
        },
      },
    ]);
  });
});
