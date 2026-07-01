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
    messages: z.array(
      z
        .object({
          role: z.string(),
          content: z.string().nullable().optional(),
        })
        .passthrough(),
    ),
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

        if (userMessage === "length-limit") {
          writeSseResponse(res, [
            sseData({ choices: [{ delta: { content: "partial qwen" } }] }),
            sseData({
              choices: [{ delta: {}, finish_reason: "length" }],
              usage: {
                prompt_tokens: 12,
                completion_tokens: 5,
                prompt_tokens_details: { cached_tokens: 2 },
              },
            }),
            "data: [DONE]\n\n",
          ]);
          return;
        }

        if (userMessage === "invalid-json") {
          writeSseResponse(res, ["data: {not json}\n\n", "data: [DONE]\n\n"]);
          return;
        }

        if (userMessage === "empty-schema-chunk") {
          writeSseResponse(res, [sseData({}), "data: [DONE]\n\n"]);
          return;
        }

        if (userMessage === "invalid-cache-usage") {
          writeSseResponse(res, [
            sseData({
              choices: [{ delta: {}, finish_reason: "stop" }],
              usage: {
                prompt_tokens: 10,
                completion_tokens: 1,
                prompt_tokens_details: { cached_tokens: 11 },
              },
            }),
            "data: [DONE]\n\n",
          ]);
          return;
        }

        if (userMessage === "negative-tool-call-index") {
          writeSseResponse(res, [
            sseData({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: -1,
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
              },
            }),
            "data: [DONE]\n\n",
          ]);
          return;
        }

        if (userMessage === "fractional-tool-call-index") {
          writeSseResponse(res, [
            sseData({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0.5,
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
              },
            }),
            "data: [DONE]\n\n",
          ]);
          return;
        }

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

        if (userMessage === "glob-tool-call") {
          writeSseResponse(res, [
            sseData({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_qwen_glob",
                        type: "function",
                        function: {
                          name: "glob",
                          arguments:
                            '{"pattern":"**/*.test.ts","path":"tests"}',
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
    expect(capturedBody?.tools?.map((tool) => tool.function.name)).toEqual([
      "read",
      "ls",
      "glob",
      "grep",
      "git_diff",
      "edit",
      "write",
      "apply_patch",
    ]);
    expect(events).toEqual([
      { type: "text", text: "Hello from Qwen." },
      {
        type: "stop",
        reason: "stop",
        usage: {
          inputTokens: 50,
          cachedInputTokens: 5,
          uncachedInputTokens: 45,
          outputTokens: 10,
        },
      },
    ]);
  });

  test(`Given Qwen replays history produced by a DeepSeek reasoning model,
    When it sends the OpenAI-compatible request,
    Then DeepSeek reasoning_content metadata is omitted`, async () => {
    // Given
    const provider = createQwenProvider({
      apiKey: "test-qwen-key",
      baseUrl,
      model: "qwen3.7-plus",
    });

    // When
    await collect(
      provider.stream({
        systemPrompt: "You are Keel.",
        messages: [
          { role: "user", content: "inspect" },
          {
            role: "assistant",
            content: "I inspected the file.",
            providerMetadata: {
              openaiCompatible: {
                reasoningContent: "DeepSeek-only reasoning.",
              },
            },
            toolCalls: [],
          },
          { role: "user", content: "continue" },
        ],
        signal: freshSignal(),
      }),
    );

    // Then
    expect(capturedBody?.messages[2]).toEqual({
      role: "assistant",
      content: "I inspected the file.",
    });
  });

  test(`Given Qwen stops because the output token limit was reached,
    When the provider reads finish_reason length,
    Then it yields partial text and a length stop reason`, async () => {
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
        messages: [{ role: "user", content: "length-limit" }],
        signal: freshSignal(),
      }),
    );

    // Then
    expect(events).toEqual([
      { type: "text", text: "partial qwen" },
      {
        type: "stop",
        reason: "length",
        usage: {
          inputTokens: 12,
          cachedInputTokens: 2,
          uncachedInputTokens: 10,
          outputTokens: 5,
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
        reason: "stop",
        usage: {
          inputTokens: 100,
          cachedInputTokens: 25,
          uncachedInputTokens: 75,
          outputTokens: 20,
        },
      },
    ]);
  });

  test(`Given Qwen requests a glob tool call,
    When Keel reads the stream,
    Then the file discovery request is parsed into a Keel tool call`, async () => {
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
        messages: [{ role: "user", content: "glob-tool-call" }],
        signal: freshSignal(),
      }),
    );

    // Then
    expect(events).toEqual([
      {
        type: "tool_call",
        id: "call_qwen_glob",
        tool: "glob",
        pattern: "**/*.test.ts",
        path: "tests",
      },
      {
        type: "stop",
        reason: "stop",
        usage: {
          inputTokens: 100,
          cachedInputTokens: 25,
          uncachedInputTokens: 75,
          outputTokens: 20,
        },
      },
    ]);
  });

  test.each([
    "negative-tool-call-index",
    "fractional-tool-call-index",
  ])(`Given Qwen emits a tool call delta with an invalid numeric index,
    When Keel validates the stream chunk,
    Then it throws a provider protocol error before accumulating the tool call`, async (message) => {
    // Given
    const provider = createQwenProvider({
      apiKey: "test-qwen-key",
      baseUrl,
      model: "qwen3.7-plus",
    });

    // When / Then
    await expect(
      collect(
        provider.stream({
          systemPrompt: "You are Keel.",
          messages: [{ role: "user", content: message }],
          signal: freshSignal(),
        }),
      ),
    ).rejects.toMatchObject({
      name: "KeelError",
      code: "provider_protocol_error",
      message: "Qwen stream chunk has invalid schema",
    });
  });

  test(`Given prior assistant tool call history includes text,
    When Qwen receives the next request,
    Then assistant content is preserved beside tool calls`, async () => {
    // Given
    const provider = createQwenProvider({
      apiKey: "test-qwen-key",
      baseUrl,
      model: "qwen3.7-plus",
    });

    // When
    await collect(
      provider.stream({
        systemPrompt: "You are Keel.",
        messages: [
          { role: "user", content: "qwen-history" },
          {
            role: "assistant",
            content: "I will inspect the README before answering.",
            toolCalls: [
              {
                id: "call_qwen_read_history",
                tool: "read",
                path: "README.md",
              },
            ],
          },
          {
            role: "tool",
            toolCallId: "call_qwen_read_history",
            content: "readme body\n",
          },
          { role: "user", content: "continue" },
        ],
        signal: freshSignal(),
      }),
    );

    // Then
    expect(capturedBody?.messages).toMatchObject([
      { role: "system", content: "You are Keel." },
      { role: "user", content: "qwen-history" },
      {
        role: "assistant",
        content: "I will inspect the README before answering.",
        tool_calls: [
          {
            id: "call_qwen_read_history",
            type: "function",
            function: {
              name: "read",
              arguments: JSON.stringify({ path: "README.md" }),
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_qwen_read_history",
        content: "readme body\n",
      },
      { role: "user", content: "continue" },
    ]);
  });

  test(`Given Qwen emits a stream chunk with invalid JSON,
    When Keel reads the stream,
    Then it throws a provider protocol error`, async () => {
    // Given
    const provider = createQwenProvider({
      apiKey: "test-qwen-key",
      baseUrl,
      model: "qwen3.7-plus",
    });

    // When / Then
    await expect(
      collect(
        provider.stream({
          systemPrompt: "You are Keel.",
          messages: [{ role: "user", content: "invalid-json" }],
          signal: freshSignal(),
        }),
      ),
    ).rejects.toMatchObject({
      name: "KeelError",
      code: "provider_protocol_error",
      message: "Qwen stream chunk has invalid JSON",
    });
  });

  test(`Given Qwen emits a stream chunk with no choices or usage,
    When Keel validates the chunk,
    Then it throws a provider protocol error`, async () => {
    // Given
    const provider = createQwenProvider({
      apiKey: "test-qwen-key",
      baseUrl,
      model: "qwen3.7-plus",
    });

    // When / Then
    await expect(
      collect(
        provider.stream({
          systemPrompt: "You are Keel.",
          messages: [{ role: "user", content: "empty-schema-chunk" }],
          signal: freshSignal(),
        }),
      ),
    ).rejects.toMatchObject({
      name: "KeelError",
      code: "provider_protocol_error",
      message: "Qwen stream chunk has invalid schema",
    });
  });

  test(`Given Qwen reports more cached tokens than prompt tokens,
    When Keel validates usage,
    Then it throws a provider protocol error before reporting cost data`, async () => {
    // Given
    const provider = createQwenProvider({
      apiKey: "test-qwen-key",
      baseUrl,
      model: "qwen3.7-plus",
    });

    // When / Then
    await expect(
      collect(
        provider.stream({
          systemPrompt: "You are Keel.",
          messages: [{ role: "user", content: "invalid-cache-usage" }],
          signal: freshSignal(),
        }),
      ),
    ).rejects.toMatchObject({
      name: "KeelError",
      code: "provider_protocol_error",
      message: "Qwen stream chunk has invalid schema",
    });
  });
});
