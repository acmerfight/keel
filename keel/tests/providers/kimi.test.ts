import { createServer, type ServerResponse } from "node:http";
import type { Server } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";
import { createKimiProvider } from "../../src/llm/providers/kimi.ts";
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

function sseText(content: string): string {
  return sseData({ choices: [{ delta: { content } }] });
}

function sseFinishWithUsageInChoice(
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number,
): string {
  return `${sseData({
    choices: [
      {
        delta: {},
        finish_reason: "stop",
        usage: {
          prompt_tokens: inputTokens,
          completion_tokens: outputTokens,
          prompt_cache_hit_tokens: cachedInputTokens,
          prompt_cache_miss_tokens: inputTokens - cachedInputTokens,
        },
      },
    ],
  })}data: [DONE]\n\n`;
}

function sseFinishWithTopLevelUsage(
  inputTokens: number,
  outputTokens: number,
): string {
  return `${sseData({
    choices: [{ delta: {}, finish_reason: "stop" }],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
    },
  })}data: [DONE]\n\n`;
}

function sseFinishWithoutTrailingNewline(
  inputTokens: number,
  outputTokens: number,
): string {
  return `${sseData({
    choices: [{ delta: {}, finish_reason: "stop" }],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
    },
  })}data: [DONE]`;
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

function editToolCallDelta(argumentsJson: string): {
  readonly index: number;
  readonly id: string;
  readonly type: "function";
  readonly function: {
    readonly name: "edit";
    readonly arguments: string;
  };
} {
  return {
    index: 0,
    id: "call_kimi_edit",
    type: "function",
    function: { name: "edit", arguments: argumentsJson },
  };
}

function toolCallDelta(
  name: "read" | "grep" | "write" | "bash" | "unknown",
  argumentsJson: string,
): {
  readonly index: number;
  readonly id: string;
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly arguments: string;
  };
} {
  return {
    index: 0,
    id: `call_kimi_${name}`,
    type: "function",
    function: { name, arguments: argumentsJson },
  };
}

function toolCallWithoutIndex(argumentsJson: string): {
  readonly id: string;
  readonly type: "function";
  readonly function: {
    readonly name: "read";
    readonly arguments: string;
  };
} {
  return {
    id: "call_kimi_read",
    type: "function",
    function: { name: "read", arguments: argumentsJson },
  };
}

function toolCallWithoutId(argumentsJson: string): {
  readonly index: number;
  readonly type: "function";
  readonly function: {
    readonly name: "read";
    readonly arguments: string;
  };
} {
  return {
    index: 0,
    type: "function",
    function: { name: "read", arguments: argumentsJson },
  };
}

function longToolCallId(): string {
  return `functions.read:0.${"x".repeat(80)}`;
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

const kimiRequestBodySchema = z
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

function parseKimiRequestBody(
  body: string,
): z.infer<typeof kimiRequestBodySchema> {
  return kimiRequestBodySchema.parse(JSON.parse(body));
}

describe("Kimi Provider", () => {
  let server: Server;
  let baseUrl: string;
  let capturedBody: z.infer<typeof kimiRequestBodySchema> | null = null;
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
        const parsed = parseKimiRequestBody(body);
        capturedBody = parsed;
        capturedAuthorization = req.headers.authorization;
        const userMessage = parsed.messages[1]?.content;

        if (userMessage === "auth-error") {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Invalid API key" } }));
          return;
        }

        if (userMessage === "forbidden") {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Forbidden" } }));
          return;
        }

        if (userMessage === "rate-limited") {
          res.writeHead(429, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Rate limited" } }));
          return;
        }

        if (userMessage === "server-error") {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Server error" } }));
          return;
        }

        if (userMessage === "bad-request") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Bad request" } }));
          return;
        }

        if (userMessage === "no-body") {
          res.writeHead(204);
          res.end();
          return;
        }

        if (userMessage === "truncated") {
          writeSseResponse(res, [sseText("partial")]);
          return;
        }

        if (userMessage === "length-limit") {
          writeSseResponse(res, [
            sseText("partial"),
            `${sseData({
              choices: [{ delta: {}, finish_reason: "length" }],
              usage: { prompt_tokens: 10, completion_tokens: 4 },
            })}data: [DONE]\n\n`,
          ]);
          return;
        }

        if (userMessage === "abort-during-stream") {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          res.write(sseText("partial"));
          return;
        }

        if (userMessage === "invalid-json") {
          writeSseResponse(res, ["data: {not-json}\n\n"]);
          return;
        }

        if (userMessage === "empty-schema-chunk") {
          writeSseResponse(res, [
            sseData({}),
            sseFinishWithTopLevelUsage(1, 1),
          ]);
          return;
        }

        if (userMessage === "invalid-usage") {
          writeSseResponse(res, [
            sseText("metered"),
            `${sseData({
              choices: [{ delta: {}, finish_reason: "stop" }],
              usage: { prompt_tokens: "7", completion_tokens: 3 },
            })}data: [DONE]\n\n`,
          ]);
          return;
        }

        if (userMessage === "negative-usage") {
          writeSseResponse(res, [
            sseText("metered"),
            `${sseData({
              choices: [{ delta: {}, finish_reason: "stop" }],
              usage: { prompt_tokens: 7, completion_tokens: -1 },
            })}data: [DONE]\n\n`,
          ]);
          return;
        }

        if (userMessage === "inconsistent-cache-usage") {
          writeSseResponse(res, [
            sseText("metered"),
            `${sseData({
              choices: [{ delta: {}, finish_reason: "stop" }],
              usage: {
                prompt_tokens: 10,
                completion_tokens: 3,
                prompt_cache_hit_tokens: 4,
                prompt_cache_miss_tokens: 5,
              },
            })}data: [DONE]\n\n`,
          ]);
          return;
        }

        if (userMessage === "cache-hit-over-total") {
          writeSseResponse(res, [
            sseText("metered"),
            `${sseData({
              choices: [{ delta: {}, finish_reason: "stop" }],
              usage: {
                prompt_tokens: 10,
                completion_tokens: 3,
                prompt_cache_hit_tokens: 11,
              },
            })}data: [DONE]\n\n`,
          ]);
          return;
        }

        if (userMessage === "cache-miss-over-total") {
          writeSseResponse(res, [
            sseText("metered"),
            `${sseData({
              choices: [{ delta: {}, finish_reason: "stop" }],
              usage: {
                prompt_tokens: 10,
                completion_tokens: 3,
                prompt_cache_miss_tokens: 11,
              },
            })}data: [DONE]\n\n`,
          ]);
          return;
        }

        if (userMessage === "cached-detail-over-total") {
          writeSseResponse(res, [
            sseText("metered"),
            `${sseData({
              choices: [{ delta: {}, finish_reason: "stop" }],
              usage: {
                prompt_tokens: 10,
                completion_tokens: 3,
                prompt_tokens_details: { cached_tokens: 11 },
              },
            })}data: [DONE]\n\n`,
          ]);
          return;
        }

        if (userMessage === "cache-hit-detail-mismatch") {
          writeSseResponse(res, [
            sseText("metered"),
            `${sseData({
              choices: [{ delta: {}, finish_reason: "stop" }],
              usage: {
                prompt_tokens: 10,
                completion_tokens: 3,
                prompt_cache_hit_tokens: 4,
                prompt_tokens_details: { cached_tokens: 5 },
              },
            })}data: [DONE]\n\n`,
          ]);
          return;
        }

        if (userMessage === "miss-only-usage") {
          writeSseResponse(res, [
            sseText("metered"),
            `${sseData({
              choices: [{ delta: {}, finish_reason: "stop" }],
              usage: {
                prompt_tokens: 12,
                completion_tokens: 2,
                prompt_cache_miss_tokens: 7,
              },
            })}data: [DONE]\n\n`,
          ]);
          return;
        }

        if (userMessage === "missing-finish-reason") {
          writeSseResponse(res, [
            sseText("partial"),
            `${sseData({
              choices: [{ delta: {} }],
              usage: { prompt_tokens: 10, completion_tokens: 4 },
            })}data: [DONE]\n\n`,
          ]);
          return;
        }

        if (userMessage === "missing-usage") {
          writeSseResponse(res, [
            sseText("metered"),
            `${sseData({
              choices: [{ delta: {}, finish_reason: "stop" }],
            })}data: [DONE]\n\n`,
          ]);
          return;
        }

        if (userMessage === "done-without-final-newline") {
          writeSseResponse(res, [
            sseText("complete"),
            sseFinishWithoutTrailingNewline(9, 3),
          ]);
          return;
        }

        if (userMessage === "choice-usage") {
          writeSseResponse(res, [
            sseData({
              choices: [
                {
                  delta: {
                    reasoning_content: "hidden reasoning",
                    content: null,
                  },
                },
              ],
              usage: null,
            }),
            sseText("Hello"),
            sseText(" Kimi"),
            sseFinishWithUsageInChoice(12, 4, 5),
          ]);
          return;
        }

        if (userMessage === "tool-call") {
          writeSseResponse(res, [
            sseData({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      editToolCallDelta(
                        JSON.stringify({
                          path: "note.txt",
                          oldString: "old",
                          newString: "new",
                        }),
                      ),
                    ],
                  },
                },
              ],
            }),
            sseData({
              choices: [{ delta: {}, finish_reason: "tool_calls" }],
              usage: {
                prompt_tokens: 20,
                completion_tokens: 6,
                prompt_tokens_details: { cached_tokens: 3 },
              },
            }),
            "data: [DONE]\n\n",
          ]);
          return;
        }

        if (userMessage === "long-id-tool-call") {
          writeSseResponse(res, [
            sseData({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: longToolCallId(),
                        type: "function",
                        function: {
                          name: "read",
                          arguments: JSON.stringify({ path: "note.txt" }),
                        },
                      },
                    ],
                  },
                },
              ],
            }),
            `${sseData({
              choices: [{ delta: {}, finish_reason: "tool_calls" }],
              usage: { prompt_tokens: 20, completion_tokens: 6 },
            })}data: [DONE]\n\n`,
          ]);
          return;
        }

        if (userMessage === "multiple-tool-calls") {
          writeSseResponse(res, [
            sseData({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        ...toolCallDelta(
                          "write",
                          JSON.stringify({
                            path: "later.txt",
                            content: "later\n",
                          }),
                        ),
                        index: 1,
                      },
                      toolCallDelta(
                        "read",
                        JSON.stringify({ path: "first.txt" }),
                      ),
                    ],
                  },
                },
              ],
            }),
            `${sseData({
              choices: [{ delta: {}, finish_reason: "tool_calls" }],
              usage: { prompt_tokens: 20, completion_tokens: 6 },
            })}data: [DONE]\n\n`,
          ]);
          return;
        }

        if (userMessage === "read-tool-call") {
          writeSseResponse(res, [
            sseData({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      toolCallDelta(
                        "read",
                        JSON.stringify({
                          path: "note.txt",
                          offset: 2,
                          limit: 3,
                        }),
                      ),
                    ],
                  },
                },
              ],
            }),
            `${sseData({
              choices: [{ delta: {}, finish_reason: "tool_calls" }],
              usage: { prompt_tokens: 20, completion_tokens: 6 },
            })}data: [DONE]\n\n`,
          ]);
          return;
        }

        if (userMessage === "grep-tool-call") {
          writeSseResponse(res, [
            sseData({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      toolCallDelta(
                        "grep",
                        JSON.stringify({ pattern: "hello", path: "src" }),
                      ),
                    ],
                  },
                },
              ],
            }),
            `${sseData({
              choices: [{ delta: {}, finish_reason: "tool_calls" }],
              usage: { prompt_tokens: 20, completion_tokens: 6 },
            })}data: [DONE]\n\n`,
          ]);
          return;
        }

        if (userMessage === "write-tool-call") {
          writeSseResponse(res, [
            sseData({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      toolCallDelta(
                        "write",
                        JSON.stringify({
                          path: "new.txt",
                          content: "created\n",
                        }),
                      ),
                    ],
                  },
                },
              ],
            }),
            `${sseData({
              choices: [{ delta: {}, finish_reason: "tool_calls" }],
              usage: { prompt_tokens: 20, completion_tokens: 6 },
            })}data: [DONE]\n\n`,
          ]);
          return;
        }

        if (userMessage === "bash-tool-call") {
          writeSseResponse(res, [
            sseData({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      toolCallDelta(
                        "bash",
                        JSON.stringify({
                          command: "pnpm test",
                          timeoutMs: 1000,
                        }),
                      ),
                    ],
                  },
                },
              ],
            }),
            `${sseData({
              choices: [{ delta: {}, finish_reason: "tool_calls" }],
              usage: { prompt_tokens: 20, completion_tokens: 6 },
            })}data: [DONE]\n\n`,
          ]);
          return;
        }

        if (userMessage === "tool-call-without-index") {
          writeSseResponse(res, [
            sseData({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      toolCallWithoutIndex(
                        JSON.stringify({ path: "note.txt" }),
                      ),
                    ],
                  },
                },
              ],
            }),
          ]);
          return;
        }

        if (userMessage === "tool-call-without-id") {
          writeSseResponse(res, [
            sseData({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      toolCallWithoutId(JSON.stringify({ path: "note.txt" })),
                    ],
                  },
                },
              ],
            }),
            `${sseData({
              choices: [{ delta: {}, finish_reason: "tool_calls" }],
              usage: { prompt_tokens: 20, completion_tokens: 6 },
            })}data: [DONE]\n\n`,
          ]);
          return;
        }

        if (userMessage === "tool-calls-without-tool") {
          writeSseResponse(res, [
            `${sseData({
              choices: [{ delta: {}, finish_reason: "tool_calls" }],
              usage: { prompt_tokens: 20, completion_tokens: 6 },
            })}data: [DONE]\n\n`,
          ]);
          return;
        }

        if (userMessage === "unsupported-tool") {
          writeSseResponse(res, [
            sseData({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      toolCallDelta("unknown", JSON.stringify({ ok: true })),
                    ],
                  },
                },
              ],
            }),
            `${sseData({
              choices: [{ delta: {}, finish_reason: "tool_calls" }],
              usage: { prompt_tokens: 20, completion_tokens: 6 },
            })}data: [DONE]\n\n`,
          ]);
          return;
        }

        if (userMessage === "invalid-tool-arguments") {
          writeSseResponse(res, [
            sseData({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      toolCallDelta(
                        "read",
                        JSON.stringify({ path: "note.txt", offset: 0 }),
                      ),
                    ],
                  },
                },
              ],
            }),
            `${sseData({
              choices: [{ delta: {}, finish_reason: "tool_calls" }],
              usage: { prompt_tokens: 20, completion_tokens: 6 },
            })}data: [DONE]\n\n`,
          ]);
          return;
        }

        if (userMessage === "invalid-edit-arguments") {
          writeSseResponse(res, [
            sseData({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      editToolCallDelta(
                        JSON.stringify({
                          path: "note.txt",
                          oldString: "old",
                        }),
                      ),
                    ],
                  },
                },
              ],
            }),
            `${sseData({
              choices: [{ delta: {}, finish_reason: "tool_calls" }],
              usage: { prompt_tokens: 20, completion_tokens: 6 },
            })}data: [DONE]\n\n`,
          ]);
          return;
        }

        writeSseResponse(res, [
          sseText("ok"),
          sseFinishWithTopLevelUsage(7, 2),
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

  function createProvider() {
    return createKimiProvider({
      apiKey: "test-key",
      baseUrl,
      model: "kimi-k2.6",
    });
  }

  async function streamFor(message: string): Promise<LLMEvent[]> {
    return collect(
      createProvider().stream({
        systemPrompt: "You are Keel.",
        messages: [{ role: "user", content: message }],
        signal: freshSignal(),
      }),
    );
  }

  async function expectProviderError(
    message: string,
    code: string,
  ): Promise<void> {
    await expect(streamFor(message)).rejects.toMatchObject({ code });
  }

  test(`Given a Kimi provider,
    When it streams a text response,
    Then it sends an OpenAI-compatible request and returns usage`, async () => {
    // Given
    const provider = createProvider();

    // When
    const events = await collect(
      provider.stream({
        systemPrompt: "You are Keel.",
        messages: [{ role: "user", content: "hello" }],
        signal: freshSignal(),
      }),
    );

    // Then
    expect(events).toEqual([
      { type: "text", text: "ok" },
      {
        type: "stop",
        usage: {
          inputTokens: 7,
          cachedInputTokens: 0,
          uncachedInputTokens: 7,
          outputTokens: 2,
        },
      },
    ]);
    expect(capturedAuthorization).toBe("Bearer test-key");
    expect(capturedBody).toMatchObject({
      model: "kimi-k2.6",
      stream: true,
      stream_options: { include_usage: true },
      tool_choice: "auto",
      messages: [
        { role: "system", content: "You are Keel." },
        { role: "user", content: "hello" },
      ],
    });
    expect(capturedBody?.tools?.map((tool) => tool.function.name)).toEqual([
      "read",
      "grep",
      "edit",
      "write",
    ]);
  });

  test(`Given a text-only turn,
    When tool choice is none,
    Then Kimi receives no tools or tool_choice`, async () => {
    // Given
    const provider = createProvider();

    // When
    await collect(
      provider.stream({
        systemPrompt: "Wrap up.",
        messages: [{ role: "user", content: "summarize" }],
        signal: freshSignal(),
        toolChoice: "none",
      }),
    );

    // Then
    expect(capturedBody?.tools).toBeUndefined();
    expect(capturedBody?.tool_choice).toBeUndefined();
  });

  test(`Given bash is allowed,
    When Kimi receives the tool list,
    Then the bash tool is included`, async () => {
    // Given
    const provider = createProvider();

    // When
    await collect(
      provider.stream({
        systemPrompt: "You are Keel.",
        messages: [{ role: "user", content: "hello" }],
        signal: freshSignal(),
        allowBash: true,
      }),
    );

    // Then
    expect(capturedBody?.tools?.map((tool) => tool.function.name)).toEqual([
      "read",
      "grep",
      "edit",
      "write",
      "bash",
    ]);
  });

  test(`Given prior assistant and tool messages,
    When Kimi receives the next request,
    Then tool call history is serialized in OpenAI-compatible format`, async () => {
    // Given
    const provider = createProvider();

    // When
    await collect(
      provider.stream({
        systemPrompt: "You are Keel.",
        messages: [
          { role: "user", content: "first" },
          {
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "call_read_history",
                tool: "read",
                path: "note.txt",
              },
            ],
          },
          {
            role: "tool",
            toolCallId: "call_read_history",
            content: "hello\n",
          },
          { role: "user", content: "continue" },
        ],
        signal: freshSignal(),
      }),
    );

    // Then
    expect(capturedBody?.messages).toMatchObject([
      { role: "system", content: "You are Keel." },
      { role: "user", content: "first" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_read_history",
            type: "function",
            function: {
              name: "read",
              arguments: JSON.stringify({ path: "note.txt" }),
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_read_history",
        content: "hello\n",
      },
      { role: "user", content: "continue" },
    ]);
  });

  test(`Given Kimi streams usage on the final choice,
    When the provider reads the response,
    Then it preserves cached token accounting and ignores reasoning content`, async () => {
    // Given
    const provider = createProvider();

    // When
    const events = await collect(
      provider.stream({
        systemPrompt: "You are Keel.",
        messages: [{ role: "user", content: "choice-usage" }],
        signal: freshSignal(),
      }),
    );

    // Then
    expect(events).toEqual([
      { type: "text", text: "Hello" },
      { type: "text", text: " Kimi" },
      {
        type: "stop",
        usage: {
          inputTokens: 12,
          cachedInputTokens: 5,
          uncachedInputTokens: 7,
          outputTokens: 4,
        },
      },
    ]);
  });

  test(`Given Kimi streams only cache miss tokens,
    When the provider reads the usage,
    Then it derives cached input tokens from the prompt total`, async () => {
    // When
    const events = await streamFor("miss-only-usage");

    // Then
    expect(events).toEqual([
      { type: "text", text: "metered" },
      {
        type: "stop",
        usage: {
          inputTokens: 12,
          cachedInputTokens: 5,
          uncachedInputTokens: 7,
          outputTokens: 2,
        },
      },
    ]);
  });

  test(`Given Kimi sends DONE without a trailing newline,
    When the provider drains the stream,
    Then it still completes the response`, async () => {
    // When
    const events = await streamFor("done-without-final-newline");

    // Then
    expect(events).toEqual([
      { type: "text", text: "complete" },
      {
        type: "stop",
        usage: {
          inputTokens: 9,
          cachedInputTokens: 0,
          uncachedInputTokens: 9,
          outputTokens: 3,
        },
      },
    ]);
  });

  test(`Given Kimi returns a tool call,
    When the stream finishes with tool_calls,
    Then the provider emits the parsed Keel tool call before stop`, async () => {
    // Given
    const provider = createProvider();

    // When
    const events = await collect(
      provider.stream({
        systemPrompt: "You are Keel.",
        messages: [{ role: "user", content: "tool-call" }],
        signal: freshSignal(),
      }),
    );

    // Then
    expect(events).toEqual([
      {
        type: "tool_call",
        id: "call_kimi_edit",
        tool: "edit",
        path: "note.txt",
        oldString: "old",
        newString: "new",
      },
      {
        type: "stop",
        usage: {
          inputTokens: 20,
          cachedInputTokens: 3,
          uncachedInputTokens: 17,
          outputTokens: 6,
        },
      },
    ]);
  });

  test(`Given Kimi returns an overlong tool call id,
    When Keel records and replays the tool round,
    Then the provider id is preserved exactly in following history`, async () => {
    // Given
    const provider = createProvider();
    const providerToolCallId = longToolCallId();

    // When
    const events = await collect(
      provider.stream({
        systemPrompt: "You are Keel.",
        messages: [{ role: "user", content: "long-id-tool-call" }],
        signal: freshSignal(),
      }),
    );
    await collect(
      provider.stream({
        systemPrompt: "You are Keel.",
        messages: [
          { role: "user", content: "long-id-tool-call" },
          {
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: providerToolCallId,
                tool: "read",
                path: "note.txt",
              },
            ],
          },
          {
            role: "tool",
            toolCallId: providerToolCallId,
            content: "hello\n",
          },
          { role: "user", content: "continue after long id" },
        ],
        signal: freshSignal(),
      }),
    );

    // Then
    expect(events[0]).toEqual({
      type: "tool_call",
      id: providerToolCallId,
      tool: "read",
      path: "note.txt",
    });
    expect(capturedBody?.messages).toMatchObject([
      { role: "system", content: "You are Keel." },
      { role: "user", content: "long-id-tool-call" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: providerToolCallId,
            type: "function",
            function: {
              name: "read",
              arguments: JSON.stringify({ path: "note.txt" }),
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: providerToolCallId,
        content: "hello\n",
      },
      { role: "user", content: "continue after long id" },
    ]);
  });

  test(`Given Kimi returns read, grep, write, and bash tool calls,
    When each stream finishes with tool_calls,
    Then the provider emits each parsed Keel tool shape`, async () => {
    // When
    const [readEvents, grepEvents, writeEvents, bashEvents] = await Promise.all(
      [
        streamFor("read-tool-call"),
        streamFor("grep-tool-call"),
        streamFor("write-tool-call"),
        streamFor("bash-tool-call"),
      ],
    );

    // Then
    expect(readEvents[0]).toEqual({
      type: "tool_call",
      id: "call_kimi_read",
      tool: "read",
      path: "note.txt",
      offset: 2,
      limit: 3,
    });
    expect(grepEvents[0]).toEqual({
      type: "tool_call",
      id: "call_kimi_grep",
      tool: "grep",
      pattern: "hello",
      path: "src",
    });
    expect(writeEvents[0]).toEqual({
      type: "tool_call",
      id: "call_kimi_write",
      tool: "write",
      path: "new.txt",
      content: "created\n",
    });
    expect(bashEvents[0]).toEqual({
      type: "tool_call",
      id: "call_kimi_bash",
      tool: "bash",
      command: "pnpm test",
      timeoutMs: 1000,
    });
  });

  test(`Given Kimi returns multiple tool calls out of stream order,
    When the stream finishes,
    Then the provider emits them ordered by stream index`, async () => {
    // When
    const events = await streamFor("multiple-tool-calls");

    // Then
    expect(events.slice(0, 2)).toEqual([
      {
        type: "tool_call",
        id: "call_kimi_read",
        tool: "read",
        path: "first.txt",
      },
      {
        type: "tool_call",
        id: "call_kimi_write",
        tool: "write",
        path: "later.txt",
        content: "later\n",
      },
    ]);
  });

  test(`Given Kimi rejects a request,
    When the API returns 401,
    Then the provider reports an authentication failure`, async () => {
    // Given
    const provider = createKimiProvider({
      apiKey: "bad-key",
      baseUrl,
      model: "kimi-k2.6",
    });

    // When / Then
    await expect(
      collect(
        provider.stream({
          systemPrompt: "You are Keel.",
          messages: [{ role: "user", content: "auth-error" }],
          signal: freshSignal(),
        }),
      ),
    ).rejects.toMatchObject({
      code: "provider_auth_failed",
    });
  });

  test(`Given Kimi returns HTTP failures,
    When the provider receives each status,
    Then it maps them to Keel provider errors`, async () => {
    // When / Then
    await expectProviderError("forbidden", "provider_auth_failed");
    await expectProviderError("rate-limited", "provider_rate_limited");
    await expectProviderError("server-error", "provider_server_error");
    await expectProviderError("bad-request", "provider_http_error");
    await expectProviderError("no-body", "provider_protocol_error");
  });

  test(`Given the caller aborts a Kimi request,
    When the provider attempts to stream,
    Then it throws an aborted provider error`, async () => {
    // Given
    const provider = createProvider();
    const controller = new AbortController();
    controller.abort();

    // When / Then
    await expect(
      collect(
        provider.stream({
          systemPrompt: "You are Keel.",
          messages: [{ role: "user", content: "hello" }],
          signal: controller.signal,
        }),
      ),
    ).rejects.toMatchObject({
      name: "KeelError",
      code: "provider_aborted",
      message: "Kimi request was aborted",
    });
  });

  test(`Given the caller aborts while Kimi is streaming,
    When the provider reads the next chunk,
    Then it throws an aborted provider error`, async () => {
    // Given
    const provider = createProvider();
    const controller = new AbortController();
    const iterator = provider
      .stream({
        systemPrompt: "You are Keel.",
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
      message: "Kimi request was aborted",
    });
  });

  test(`Given Kimi returns malformed or incomplete streams,
    When the provider reads them,
    Then it fails with protocol errors`, async () => {
    // When / Then
    await expectProviderError("truncated", "provider_protocol_error");
    await expectProviderError("length-limit", "provider_protocol_error");
    await expectProviderError("invalid-json", "provider_protocol_error");
    await expectProviderError("empty-schema-chunk", "provider_protocol_error");
    await expectProviderError("invalid-usage", "provider_protocol_error");
    await expectProviderError("negative-usage", "provider_protocol_error");
    await expectProviderError(
      "inconsistent-cache-usage",
      "provider_protocol_error",
    );
    await expectProviderError(
      "cache-hit-over-total",
      "provider_protocol_error",
    );
    await expectProviderError(
      "cache-miss-over-total",
      "provider_protocol_error",
    );
    await expectProviderError(
      "cached-detail-over-total",
      "provider_protocol_error",
    );
    await expectProviderError(
      "cache-hit-detail-mismatch",
      "provider_protocol_error",
    );
    await expectProviderError(
      "missing-finish-reason",
      "provider_protocol_error",
    );
    await expectProviderError("missing-usage", "provider_protocol_error");
  });

  test(`Given Kimi returns malformed tool calls,
    When the provider completes the stream,
    Then it fails with protocol errors`, async () => {
    // When / Then
    await expectProviderError(
      "tool-calls-without-tool",
      "provider_protocol_error",
    );
    await expectProviderError(
      "tool-call-without-index",
      "provider_protocol_error",
    );
    await expectProviderError(
      "tool-call-without-id",
      "provider_protocol_error",
    );
    await expectProviderError("unsupported-tool", "provider_protocol_error");
    await expectProviderError(
      "invalid-tool-arguments",
      "provider_protocol_error",
    );
    await expectProviderError(
      "invalid-edit-arguments",
      "provider_protocol_error",
    );
  });
});
