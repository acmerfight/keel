import { createServer, type ServerResponse } from "node:http";
import type { Server } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";
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
  cachedInputTokens = 0,
): string {
  const uncachedInputTokens = inputTokens - cachedInputTokens;
  const chunk = JSON.stringify({
    choices: [{ delta: {}, finish_reason: finishReason }],
    usage: {
      prompt_tokens: inputTokens,
      prompt_cache_hit_tokens: cachedInputTokens,
      prompt_cache_miss_tokens: uncachedInputTokens,
      completion_tokens: outputTokens,
    },
  });
  return `data: ${chunk}\n\ndata: [DONE]\n\n`;
}

function sseFinishWithoutTrailingNewline(
  inputTokens: number,
  outputTokens: number,
): string {
  const chunk = JSON.stringify({
    choices: [{ delta: {}, finish_reason: "stop" }],
    usage: {
      prompt_tokens: inputTokens,
      prompt_cache_hit_tokens: 0,
      prompt_cache_miss_tokens: inputTokens,
      completion_tokens: outputTokens,
    },
  });
  return `data: ${chunk}\n\ndata: [DONE]`;
}

function sseFinishWithoutUsage(): string {
  const chunk = JSON.stringify({
    choices: [{ delta: {}, finish_reason: "stop" }],
  });
  return `data: ${chunk}\n\ndata: [DONE]\n\n`;
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

function editToolCallDelta(
  index: number,
  argumentsJson?: string,
): {
  readonly index: number;
  readonly id: string;
  readonly type: "function";
  readonly function: {
    readonly name: "edit";
    readonly arguments?: string;
  };
} {
  const toolFunction: {
    readonly name: "edit";
    arguments?: string;
  } = { name: "edit" };
  if (argumentsJson !== undefined) {
    toolFunction.arguments = argumentsJson;
  }

  return {
    index,
    id: `call_edit_${index}`,
    type: "function",
    function: toolFunction,
  };
}

function readToolCallDelta(argumentsJson: string): {
  readonly index: number;
  readonly id: string;
  readonly type: "function";
  readonly function: {
    readonly name: "read";
    readonly arguments: string;
  };
} {
  return {
    index: 0,
    id: "call_read_0",
    type: "function",
    function: {
      name: "read",
      arguments: argumentsJson,
    },
  };
}

function grepToolCallDelta(argumentsJson: string): {
  readonly index: number;
  readonly id: string;
  readonly type: "function";
  readonly function: {
    readonly name: "grep";
    readonly arguments: string;
  };
} {
  return {
    index: 0,
    id: "call_grep_0",
    type: "function",
    function: {
      name: "grep",
      arguments: argumentsJson,
    },
  };
}

function writeToolCallDelta(argumentsJson: string): {
  readonly index: number;
  readonly id: string;
  readonly type: "function";
  readonly function: {
    readonly name: "write";
    readonly arguments: string;
  };
} {
  return {
    index: 0,
    id: "call_write_0",
    type: "function",
    function: {
      name: "write",
      arguments: argumentsJson,
    },
  };
}

function bashToolCallDelta(argumentsJson: string): {
  readonly index: number;
  readonly id: string;
  readonly type: "function";
  readonly function: {
    readonly name: "bash";
    readonly arguments: string;
  };
} {
  return {
    index: 0,
    id: "call_bash_0",
    type: "function",
    function: {
      name: "bash",
      arguments: argumentsJson,
    },
  };
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

function objectProperty(value: unknown, property: string): unknown {
  if (typeof value !== "object" || value === null) {
    throw new Error(`Expected object before reading ${property}`);
  }
  return Reflect.get(value, property);
}

function arrayElement(values: unknown, index: number): unknown {
  if (!Array.isArray(values)) {
    throw new Error(`Expected array before reading index ${index}`);
  }
  return values[index];
}

function expectJsonString(
  value: unknown,
  expected: Record<string, unknown>,
): void {
  if (typeof value !== "string") {
    throw new Error("Expected JSON string");
  }
  expect(JSON.parse(value)).toEqual(expected);
}

const deepseekRequestBodySchema = z
  .object({
    stream_options: z
      .object({
        include_usage: z.boolean(),
      })
      .optional(),
    tools: z
      .array(
        z
          .object({
            function: z
              .object({
                name: z.string(),
                description: z.string().optional(),
                parameters: z
                  .object({
                    properties: z.record(z.string(), z.unknown()),
                  })
                  .passthrough(),
              })
              .passthrough(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

const stringToolParameterSchema = z
  .object({
    type: z.literal("string"),
  })
  .passthrough();

const bashToolParametersSchema = z
  .object({
    properties: z
      .object({
        command: stringToolParameterSchema,
      })
      .passthrough(),
  })
  .passthrough();

const grepToolParametersSchema = z
  .object({
    properties: z
      .object({
        pattern: stringToolParameterSchema,
      })
      .passthrough(),
  })
  .passthrough();

const writeToolParametersSchema = z
  .object({
    properties: z
      .object({
        path: stringToolParameterSchema,
        content: stringToolParameterSchema,
      })
      .passthrough(),
  })
  .passthrough();

function parseDeepseekRequestBody(
  body: string,
): z.infer<typeof deepseekRequestBodySchema> {
  return deepseekRequestBodySchema.parse(JSON.parse(body));
}

async function unusedLocalPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => {
    probe.listen(0, "127.0.0.1", resolve);
  });
  const port = getPort(probe);
  await closeServer(probe);
  return port;
}

describe("DeepSeek Provider", () => {
  let server: Server;
  let baseUrl: string;
  let capturedMessages: unknown;
  let transientRateLimitRequests = 0;
  let transientServerErrorRequests = 0;
  let authRetryRequests = 0;
  let hangingRateLimitRequests = 0;
  let longRetryAfterRequests = 0;
  let transientTimeoutRequests = 0;
  let transientConflictRequests = 0;
  let invalidRetryAfterRequests = 0;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = req.url ?? "";

      if (url === "/chat/completions") {
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          const parsed = JSON.parse(body);
          if (parsed.messages?.[1]?.content === "serialize-history") {
            capturedMessages = parsed.messages;
          }

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

          if (parsed.messages?.[1]?.content === "auth-never-retry") {
            authRetryRequests++;
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: { message: "Invalid API key" } }));
            return;
          }

          if (parsed.messages?.[1]?.content === "rate-limited") {
            res.writeHead(429, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: { message: "Rate limited" } }));
            return;
          }

          if (parsed.messages?.[1]?.content === "transient-rate-limit") {
            transientRateLimitRequests++;
            if (transientRateLimitRequests === 1) {
              res.writeHead(429, {
                "Content-Type": "application/json",
                "Retry-After": "0",
              });
              res.end(JSON.stringify({ error: { message: "Rate limited" } }));
              return;
            }
          }

          if (parsed.messages?.[1]?.content === "hanging-rate-limit-body") {
            hangingRateLimitRequests++;
            if (hangingRateLimitRequests === 1) {
              res.writeHead(429, {
                "Content-Type": "application/json",
                "Retry-After": "0",
              });
              res.write(JSON.stringify({ error: { message: "Rate limited" } }));
              return;
            }
          }

          if (parsed.messages?.[1]?.content === "long-retry-after") {
            longRetryAfterRequests++;
            res.writeHead(429, {
              "Content-Type": "application/json",
              "Retry-After": "120",
            });
            res.end(JSON.stringify({ error: { message: "Rate limited" } }));
            return;
          }

          if (parsed.messages?.[1]?.content === "transient-timeout") {
            transientTimeoutRequests++;
            if (transientTimeoutRequests === 1) {
              res.writeHead(408, {
                "Content-Type": "application/json",
                "retry-after-ms": "0",
              });
              res.end(JSON.stringify({ error: { message: "Timeout" } }));
              return;
            }
          }

          if (parsed.messages?.[1]?.content === "transient-conflict") {
            transientConflictRequests++;
            if (transientConflictRequests === 1) {
              res.writeHead(409, {
                "Content-Type": "application/json",
                "Retry-After": new Date(0).toUTCString(),
              });
              res.end(JSON.stringify({ error: { message: "Conflict" } }));
              return;
            }
          }

          if (parsed.messages?.[1]?.content === "invalid-retry-after") {
            invalidRetryAfterRequests++;
            if (invalidRetryAfterRequests === 1) {
              res.writeHead(429, {
                "Content-Type": "application/json",
                "retry-after-ms": "-1",
                "Retry-After": "not-a-date",
              });
              res.end(JSON.stringify({ error: { message: "Rate limited" } }));
              return;
            }
          }

          if (parsed.messages?.[1]?.content === "server-error") {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: { message: "Server error" } }));
            return;
          }

          if (parsed.messages?.[1]?.content === "transient-server-error") {
            transientServerErrorRequests++;
            if (transientServerErrorRequests === 1) {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: { message: "Server error" } }));
              return;
            }
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

          if (parsed.messages?.[1]?.content === "empty-schema-chunk") {
            writeSseResponse(res, [sseData({}), sseFinish(1, 1)]);
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

          if (parsed.messages?.[1]?.content === "inconsistent-cache-usage") {
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            });
            res.write(sseChunk("metered output"));
            res.write(
              sseData({
                choices: [{ delta: {}, finish_reason: "stop" }],
                usage: {
                  prompt_tokens: 10,
                  prompt_cache_hit_tokens: 4,
                  prompt_cache_miss_tokens: 5,
                  completion_tokens: 3,
                },
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

          if (parsed.messages?.[1]?.content === "cached-usage") {
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            });
            res.write(sseChunk("cached"));
            res.write(sseFinish(10, 5, "stop", 4));
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

          if (parsed.messages?.[1]?.content === "missing-finish-reason") {
            writeSseResponse(res, [
              sseChunk("partial output"),
              sseData({
                choices: [{ delta: {} }],
                usage: {
                  prompt_tokens: 10,
                  prompt_cache_hit_tokens: 0,
                  prompt_cache_miss_tokens: 10,
                  completion_tokens: 4,
                },
              }),
              "data: [DONE]\n\n",
            ]);
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

          if (parsed.messages?.[1]?.content === "multiple-tool-calls") {
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            });
            res.write(
              sseData({
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        editToolCallDelta(
                          0,
                          JSON.stringify({
                            path: "one.txt",
                            oldString: "old",
                            newString: "new",
                          }),
                        ),
                        editToolCallDelta(
                          1,
                          JSON.stringify({
                            path: "two.txt",
                            oldString: "old",
                            newString: "new",
                          }),
                        ),
                      ],
                    },
                    finish_reason: null,
                  },
                ],
                usage: null,
              }),
            );
            res.write(
              sseData({
                choices: [{ delta: {}, finish_reason: "tool_calls" }],
                usage: {
                  prompt_tokens: 30,
                  prompt_cache_hit_tokens: 0,
                  prompt_cache_miss_tokens: 30,
                  completion_tokens: 8,
                },
              }),
            );
            res.write("data: [DONE]\n\n");
            res.end();
            return;
          }

          if (parsed.messages?.[1]?.content === "read-window-tool-call") {
            writeSseResponse(res, [
              sseData({
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        readToolCallDelta(
                          JSON.stringify({
                            path: "large.txt",
                            offset: 607,
                            limit: 20,
                          }),
                        ),
                      ],
                    },
                    finish_reason: null,
                  },
                ],
                usage: null,
              }),
              sseData({
                choices: [{ delta: {}, finish_reason: "tool_calls" }],
                usage: {
                  prompt_tokens: 30,
                  prompt_cache_hit_tokens: 0,
                  prompt_cache_miss_tokens: 30,
                  completion_tokens: 8,
                },
              }),
              "data: [DONE]\n\n",
            ]);
            return;
          }

          if (parsed.messages?.[1]?.content === "read-basic-tool-call") {
            writeSseResponse(res, [
              sseData({
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        readToolCallDelta(
                          JSON.stringify({
                            path: "note.txt",
                          }),
                        ),
                      ],
                    },
                    finish_reason: null,
                  },
                ],
                usage: null,
              }),
              sseData({
                choices: [{ delta: {}, finish_reason: "tool_calls" }],
                usage: {
                  prompt_tokens: 24,
                  prompt_cache_hit_tokens: 0,
                  prompt_cache_miss_tokens: 24,
                  completion_tokens: 6,
                },
              }),
              "data: [DONE]\n\n",
            ]);
            return;
          }

          if (parsed.messages?.[1]?.content === "grep-tool-call") {
            writeSseResponse(res, [
              sseData({
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        grepToolCallDelta(
                          JSON.stringify({
                            pattern: "handleSubmit",
                            path: "src",
                          }),
                        ),
                      ],
                    },
                    finish_reason: null,
                  },
                ],
                usage: null,
              }),
              sseData({
                choices: [{ delta: {}, finish_reason: "tool_calls" }],
                usage: {
                  prompt_tokens: 26,
                  prompt_cache_hit_tokens: 0,
                  prompt_cache_miss_tokens: 26,
                  completion_tokens: 7,
                },
              }),
              "data: [DONE]\n\n",
            ]);
            return;
          }

          if (parsed.messages?.[1]?.content === "write-tool-call") {
            writeSseResponse(res, [
              sseData({
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        writeToolCallDelta(
                          JSON.stringify({
                            path: "config.json",
                            content: '{"created":true}\n',
                          }),
                        ),
                      ],
                    },
                    finish_reason: null,
                  },
                ],
                usage: null,
              }),
              sseData({
                choices: [{ delta: {}, finish_reason: "tool_calls" }],
                usage: {
                  prompt_tokens: 28,
                  prompt_cache_hit_tokens: 0,
                  prompt_cache_miss_tokens: 28,
                  completion_tokens: 7,
                },
              }),
              "data: [DONE]\n\n",
            ]);
            return;
          }

          if (parsed.messages?.[1]?.content === "empty-grep-pattern") {
            writeSseResponse(res, [
              sseData({
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        grepToolCallDelta(
                          JSON.stringify({
                            pattern: "",
                          }),
                        ),
                      ],
                    },
                    finish_reason: null,
                  },
                ],
                usage: null,
              }),
              sseData({
                choices: [{ delta: {}, finish_reason: "tool_calls" }],
                usage: {
                  prompt_tokens: 25,
                  prompt_cache_hit_tokens: 0,
                  prompt_cache_miss_tokens: 25,
                  completion_tokens: 6,
                },
              }),
              "data: [DONE]\n\n",
            ]);
            return;
          }

          if (parsed.messages?.[1]?.content === "bash-tool-call") {
            writeSseResponse(res, [
              sseData({
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        bashToolCallDelta(
                          JSON.stringify({
                            command: "pnpm test",
                            timeoutMs: 1000,
                          }),
                        ),
                      ],
                    },
                    finish_reason: null,
                  },
                ],
                usage: null,
              }),
              sseData({
                choices: [{ delta: {}, finish_reason: "tool_calls" }],
                usage: {
                  prompt_tokens: 27,
                  prompt_cache_hit_tokens: 0,
                  prompt_cache_miss_tokens: 27,
                  completion_tokens: 7,
                },
              }),
              "data: [DONE]\n\n",
            ]);
            return;
          }

          if (parsed.messages?.[1]?.content === "nonzero-tool-call-index") {
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            });
            res.write(
              sseData({
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        editToolCallDelta(
                          1,
                          JSON.stringify({
                            path: "note.txt",
                            oldString: "old",
                            newString: "new",
                          }),
                        ),
                      ],
                    },
                    finish_reason: null,
                  },
                ],
                usage: null,
              }),
            );
            res.write(
              sseData({
                choices: [{ delta: {}, finish_reason: "tool_calls" }],
                usage: {
                  prompt_tokens: 30,
                  prompt_cache_hit_tokens: 0,
                  prompt_cache_miss_tokens: 30,
                  completion_tokens: 8,
                },
              }),
            );
            res.write("data: [DONE]\n\n");
            res.end();
            return;
          }

          if (parsed.messages?.[1]?.content === "missing-tool-arguments") {
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            });
            res.write(
              sseData({
                choices: [
                  {
                    delta: {
                      tool_calls: [editToolCallDelta(0)],
                    },
                    finish_reason: null,
                  },
                ],
                usage: null,
              }),
            );
            res.write(
              sseData({
                choices: [{ delta: {}, finish_reason: "tool_calls" }],
                usage: {
                  prompt_tokens: 30,
                  prompt_cache_hit_tokens: 0,
                  prompt_cache_miss_tokens: 30,
                  completion_tokens: 8,
                },
              }),
            );
            res.write("data: [DONE]\n\n");
            res.end();
            return;
          }

          if (parsed.messages?.[1]?.content === "missing-tool-call-index") {
            writeSseResponse(res, [
              sseData({
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          id: "call_read_0",
                          type: "function",
                          function: {
                            name: "read",
                            arguments: JSON.stringify({ path: "note.txt" }),
                          },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
                usage: null,
              }),
              sseFinish(1, 1, "tool_calls"),
            ]);
            return;
          }

          if (parsed.messages?.[1]?.content === "empty-tool-arguments") {
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            });
            res.write(
              sseData({
                choices: [
                  {
                    delta: {
                      tool_calls: [editToolCallDelta(0, "")],
                    },
                    finish_reason: null,
                  },
                ],
                usage: null,
              }),
            );
            res.write(
              sseData({
                choices: [{ delta: {}, finish_reason: "tool_calls" }],
                usage: {
                  prompt_tokens: 30,
                  prompt_cache_hit_tokens: 0,
                  prompt_cache_miss_tokens: 30,
                  completion_tokens: 8,
                },
              }),
            );
            res.write("data: [DONE]\n\n");
            res.end();
            return;
          }

          if (parsed.messages?.[1]?.content === "invalid-json-arguments") {
            writeSseResponse(res, [
              sseData({
                choices: [
                  {
                    delta: {
                      tool_calls: [readToolCallDelta('{"path": "note.txt"')],
                    },
                    finish_reason: null,
                  },
                ],
                usage: null,
              }),
              sseFinish(1, 1, "tool_calls"),
            ]);
            return;
          }

          if (parsed.messages?.[1]?.content === "missing-tool-call-id") {
            writeSseResponse(res, [
              sseData({
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          type: "function",
                          function: {
                            name: "edit",
                            arguments: JSON.stringify({
                              path: "note.txt",
                              oldString: "old",
                              newString: "new",
                            }),
                          },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
                usage: null,
              }),
              sseData({
                choices: [{ delta: {}, finish_reason: "tool_calls" }],
                usage: {
                  prompt_tokens: 30,
                  prompt_cache_hit_tokens: 0,
                  prompt_cache_miss_tokens: 30,
                  completion_tokens: 8,
                },
              }),
              "data: [DONE]\n\n",
            ]);
            return;
          }

          if (parsed.messages?.[1]?.content === "unsupported-tool-name") {
            writeSseResponse(res, [
              sseData({
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          id: "call_delete_0",
                          index: 0,
                          type: "function",
                          function: {
                            name: "delete",
                            arguments: JSON.stringify({ path: "note.txt" }),
                          },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
                usage: null,
              }),
              sseData({
                choices: [{ delta: {}, finish_reason: "tool_calls" }],
                usage: {
                  prompt_tokens: 30,
                  prompt_cache_hit_tokens: 0,
                  prompt_cache_miss_tokens: 30,
                  completion_tokens: 8,
                },
              }),
              "data: [DONE]\n\n",
            ]);
            return;
          }

          if (parsed.messages?.[1]?.content === "invalid-read-arguments") {
            writeSseResponse(res, [
              sseData({
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        readToolCallDelta(
                          JSON.stringify({ path: "note.txt", offset: 0 }),
                        ),
                      ],
                    },
                    finish_reason: null,
                  },
                ],
                usage: null,
              }),
              sseData({
                choices: [{ delta: {}, finish_reason: "tool_calls" }],
                usage: {
                  prompt_tokens: 30,
                  prompt_cache_hit_tokens: 0,
                  prompt_cache_miss_tokens: 30,
                  completion_tokens: 8,
                },
              }),
              "data: [DONE]\n\n",
            ]);
            return;
          }

          if (parsed.messages?.[1]?.content === "invalid-grep-arguments") {
            writeSseResponse(res, [
              sseData({
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        grepToolCallDelta(JSON.stringify({ path: "src" })),
                      ],
                    },
                    finish_reason: null,
                  },
                ],
                usage: null,
              }),
              sseData({
                choices: [{ delta: {}, finish_reason: "tool_calls" }],
                usage: {
                  prompt_tokens: 30,
                  prompt_cache_hit_tokens: 0,
                  prompt_cache_miss_tokens: 30,
                  completion_tokens: 8,
                },
              }),
              "data: [DONE]\n\n",
            ]);
            return;
          }

          if (parsed.messages?.[1]?.content === "invalid-bash-arguments") {
            writeSseResponse(res, [
              sseData({
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        bashToolCallDelta(JSON.stringify({ timeoutMs: 1000 })),
                      ],
                    },
                    finish_reason: null,
                  },
                ],
                usage: null,
              }),
              sseData({
                choices: [{ delta: {}, finish_reason: "tool_calls" }],
                usage: {
                  prompt_tokens: 30,
                  prompt_cache_hit_tokens: 0,
                  prompt_cache_miss_tokens: 30,
                  completion_tokens: 8,
                },
              }),
              "data: [DONE]\n\n",
            ]);
            return;
          }

          if (parsed.messages?.[1]?.content === "invalid-write-arguments") {
            writeSseResponse(res, [
              sseData({
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        writeToolCallDelta(
                          JSON.stringify({ path: "config.json" }),
                        ),
                      ],
                    },
                    finish_reason: null,
                  },
                ],
                usage: null,
              }),
              sseData({
                choices: [{ delta: {}, finish_reason: "tool_calls" }],
                usage: {
                  prompt_tokens: 30,
                  prompt_cache_hit_tokens: 0,
                  prompt_cache_miss_tokens: 30,
                  completion_tokens: 8,
                },
              }),
              "data: [DONE]\n\n",
            ]);
            return;
          }

          if (parsed.messages?.[1]?.content === "invalid-edit-arguments") {
            writeSseResponse(res, [
              sseData({
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        editToolCallDelta(
                          0,
                          JSON.stringify({
                            path: "note.txt",
                            oldString: "old",
                          }),
                        ),
                      ],
                    },
                    finish_reason: null,
                  },
                ],
                usage: null,
              }),
              sseData({
                choices: [{ delta: {}, finish_reason: "tool_calls" }],
                usage: {
                  prompt_tokens: 30,
                  prompt_cache_hit_tokens: 0,
                  prompt_cache_miss_tokens: 30,
                  completion_tokens: 8,
                },
              }),
              "data: [DONE]\n\n",
            ]);
            return;
          }

          if (parsed.messages?.[1]?.content === "tool-calls-without-delta") {
            writeSseResponse(res, [
              sseData({
                choices: [{ delta: {}, finish_reason: "tool_calls" }],
                usage: {
                  prompt_tokens: 30,
                  prompt_cache_hit_tokens: 0,
                  prompt_cache_miss_tokens: 30,
                  completion_tokens: 8,
                },
              }),
              "data: [DONE]\n\n",
            ]);
            return;
          }

          if (parsed.messages?.[1]?.content === "reasoning-with-null-content") {
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            });
            res.write(
              sseData({
                choices: [
                  {
                    index: 0,
                    delta: {
                      role: "assistant",
                      content: null,
                      reasoning_content: "",
                    },
                    finish_reason: null,
                  },
                ],
                usage: null,
              }),
            );
            res.write(
              sseData({
                choices: [
                  {
                    index: 0,
                    delta: { content: null, reasoning_content: "thinking..." },
                    finish_reason: null,
                  },
                ],
                usage: null,
              }),
            );
            res.write(
              sseData({
                choices: [
                  {
                    index: 0,
                    delta: { content: "Hello!", reasoning_content: null },
                    finish_reason: null,
                  },
                ],
                usage: null,
              }),
            );
            res.write(
              sseData({
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                usage: {
                  prompt_tokens: 12,
                  prompt_cache_hit_tokens: 0,
                  prompt_cache_miss_tokens: 12,
                  completion_tokens: 6,
                },
              }),
            );
            res.write("data: [DONE]\n\n");
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

  afterAll(async () => {
    await closeServer(server);
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
      usage: {
        inputTokens: 10,
        cachedInputTokens: 0,
        uncachedInputTokens: 10,
        outputTokens: 5,
      },
    });
  });

  test(`Given a DeepSeek-compatible API reports cached and uncached prompt usage,
    When provider streams a response,
    Then usage preserves the exact cache split`, async () => {
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
        messages: [{ role: "user", content: "cached-usage" }],
        signal: freshSignal(),
      }),
    );

    // Then
    const textEvents = events.filter((e) => e.type === "text");
    expect(textEvents.map((e) => e.text).join("")).toBe("cached");

    const stopEvent = events.find((e) => e.type === "stop");
    expect(stopEvent).toEqual({
      type: "stop",
      usage: {
        inputTokens: 10,
        cachedInputTokens: 4,
        uncachedInputTokens: 6,
        outputTokens: 5,
      },
    });
  });

  test(`Given prior assistant and tool messages,
    When provider sends the next request,
    Then it serializes the conversation history in DeepSeek format`, async () => {
    // Given
    capturedMessages = undefined;
    const provider = createDeepseekProvider({
      apiKey: "test-key",
      baseUrl,
      model: "deepseek-v4-flash",
    });

    // When
    await collect(
      provider.stream({
        systemPrompt: "You are helpful.",
        messages: [
          { role: "user", content: "serialize-history" },
          { role: "assistant", content: "plain answer" },
          {
            role: "assistant",
            content: "I need to inspect the readme.",
            toolCalls: [
              {
                id: "read_0",
                tool: "read",
                path: "README.md",
              },
            ],
          },
          {
            role: "tool",
            toolCallId: "read_0",
            content: "readme body\n",
          },
          {
            role: "assistant",
            content: "I need to inspect a file window.",
            toolCalls: [
              {
                id: "read_1",
                tool: "read",
                path: "src/index.ts",
                offset: 2,
                limit: 3,
              },
            ],
          },
          {
            role: "tool",
            toolCallId: "read_1",
            content: "file body\n",
          },
          {
            role: "assistant",
            content: "I need to search the workspace.",
            toolCalls: [
              {
                id: "grep_1",
                tool: "grep",
                pattern: "handleSubmit",
                path: "src",
              },
            ],
          },
          {
            role: "tool",
            toolCallId: "grep_1",
            content: "src/index.ts:1:handleSubmit()\n",
          },
          {
            role: "assistant",
            content: "I can now edit.",
            toolCalls: [
              {
                id: "edit_1",
                tool: "edit",
                path: "src/index.ts",
                oldString: "old",
                newString: "new",
              },
            ],
          },
          {
            role: "tool",
            toolCallId: "edit_1",
            content: "edited\n",
          },
          {
            role: "assistant",
            content: "I can now create a file.",
            toolCalls: [
              {
                id: "write_1",
                tool: "write",
                path: "src/generated.ts",
                content: "export const generated = true;\n",
              },
            ],
          },
          {
            role: "tool",
            toolCallId: "write_1",
            content: "Wrote src/generated.ts",
          },
          {
            role: "assistant",
            content: "I need to run the test command.",
            toolCalls: [
              {
                id: "bash_1",
                tool: "bash",
                command: "pnpm test",
                timeoutMs: 1000,
              },
            ],
          },
          {
            role: "tool",
            toolCallId: "bash_1",
            content: "Exit code: 0\n\nstdout:\nok\n",
          },
        ],
        signal: freshSignal(),
        allowBash: true,
      }),
    );

    // Then
    expect(capturedMessages).toEqual([
      { role: "system", content: "You are helpful." },
      { role: "user", content: "serialize-history" },
      { role: "assistant", content: "plain answer" },
      {
        role: "assistant",
        content: "I need to inspect the readme.",
        tool_calls: [
          {
            id: "read_0",
            type: "function",
            function: {
              name: "read",
              arguments: expect.any(String),
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "read_0",
        content: "readme body\n",
      },
      {
        role: "assistant",
        content: "I need to inspect a file window.",
        tool_calls: [
          {
            id: "read_1",
            type: "function",
            function: {
              name: "read",
              arguments: expect.any(String),
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "read_1",
        content: "file body\n",
      },
      {
        role: "assistant",
        content: "I need to search the workspace.",
        tool_calls: [
          {
            id: "grep_1",
            type: "function",
            function: {
              name: "grep",
              arguments: expect.any(String),
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "grep_1",
        content: "src/index.ts:1:handleSubmit()\n",
      },
      {
        role: "assistant",
        content: "I can now edit.",
        tool_calls: [
          {
            id: "edit_1",
            type: "function",
            function: {
              name: "edit",
              arguments: expect.any(String),
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "edit_1",
        content: "edited\n",
      },
      {
        role: "assistant",
        content: "I can now create a file.",
        tool_calls: [
          {
            id: "write_1",
            type: "function",
            function: {
              name: "write",
              arguments: expect.any(String),
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "write_1",
        content: "Wrote src/generated.ts",
      },
      {
        role: "assistant",
        content: "I need to run the test command.",
        tool_calls: [
          {
            id: "bash_1",
            type: "function",
            function: {
              name: "bash",
              arguments: expect.any(String),
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "bash_1",
        content: "Exit code: 0\n\nstdout:\nok\n",
      },
    ]);
    const toolCalls = objectProperty(
      arrayElement(capturedMessages, 3),
      "tool_calls",
    );
    const windowedToolCalls = objectProperty(
      arrayElement(capturedMessages, 5),
      "tool_calls",
    );
    expectJsonString(
      objectProperty(
        objectProperty(arrayElement(toolCalls, 0), "function"),
        "arguments",
      ),
      {
        path: "README.md",
      },
    );
    expectJsonString(
      objectProperty(
        objectProperty(arrayElement(windowedToolCalls, 0), "function"),
        "arguments",
      ),
      {
        path: "src/index.ts",
        offset: 2,
        limit: 3,
      },
    );
    const editToolCalls = objectProperty(
      arrayElement(capturedMessages, 9),
      "tool_calls",
    );
    const grepToolCalls = objectProperty(
      arrayElement(capturedMessages, 7),
      "tool_calls",
    );
    expectJsonString(
      objectProperty(
        objectProperty(arrayElement(grepToolCalls, 0), "function"),
        "arguments",
      ),
      {
        pattern: "handleSubmit",
        path: "src",
      },
    );
    expectJsonString(
      objectProperty(
        objectProperty(arrayElement(editToolCalls, 0), "function"),
        "arguments",
      ),
      {
        path: "src/index.ts",
        oldString: "old",
        newString: "new",
      },
    );
    const writeToolCalls = objectProperty(
      arrayElement(capturedMessages, 11),
      "tool_calls",
    );
    expectJsonString(
      objectProperty(
        objectProperty(arrayElement(writeToolCalls, 0), "function"),
        "arguments",
      ),
      {
        path: "src/generated.ts",
        content: "export const generated = true;\n",
      },
    );
    const bashToolCalls = objectProperty(
      arrayElement(capturedMessages, 13),
      "tool_calls",
    );
    expectJsonString(
      objectProperty(
        objectProperty(arrayElement(bashToolCalls, 0), "function"),
        "arguments",
      ),
      {
        command: "pnpm test",
        timeoutMs: 1000,
      },
    );
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
      retry: { maxRetries: 0 },
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

  test(`Given the API rate limits a request once,
    When provider streams the response,
    Then it retries with backoff and returns the successful stream`, async () => {
    // Given
    transientRateLimitRequests = 0;
    const provider = createDeepseekProvider({
      apiKey: "test-key",
      baseUrl,
      model: "deepseek-v4-flash",
      retry: { maxRetries: 1, initialDelayMs: 0, maxDelayMs: 0 },
    });

    // When
    const events = await collect(
      provider.stream({
        systemPrompt: "You are helpful.",
        messages: [{ role: "user", content: "transient-rate-limit" }],
        signal: freshSignal(),
      }),
    );

    // Then
    expect(transientRateLimitRequests).toBe(2);
    const textEvents = events.filter((e) => e.type === "text");
    expect(textEvents.map((e) => e.text).join("")).toBe("Hello world");
  });

  test(`Given a retryable response body does not finish,
    When provider streams the response,
    Then retry does not wait for the error body`, async () => {
    // Given
    hangingRateLimitRequests = 0;
    const provider = createDeepseekProvider({
      apiKey: "test-key",
      baseUrl,
      model: "deepseek-v4-flash",
      retry: { maxRetries: 1, initialDelayMs: 0, maxDelayMs: 0 },
    });

    // When
    const events = await collect(
      provider.stream({
        systemPrompt: "You are helpful.",
        messages: [{ role: "user", content: "hanging-rate-limit-body" }],
        signal: freshSignal(),
      }),
    );

    // Then
    expect(hangingRateLimitRequests).toBe(2);
    const textEvents = events.filter((e) => e.type === "text");
    expect(textEvents.map((e) => e.text).join("")).toBe("Hello world");
  });

  test(`Given the API asks to retry after the configured wait ceiling,
    When provider attempts to stream,
    Then it does not retry earlier than the provider allows`, async () => {
    // Given
    longRetryAfterRequests = 0;
    const provider = createDeepseekProvider({
      apiKey: "test-key",
      baseUrl,
      model: "deepseek-v4-flash",
      retry: { maxRetries: 1, maxRetryAfterMs: 1_000 },
    });

    // When / Then
    await expect(
      collect(
        provider.stream({
          systemPrompt: "You are helpful.",
          messages: [{ role: "user", content: "long-retry-after" }],
          signal: freshSignal(),
        }),
      ),
    ).rejects.toMatchObject({
      name: "KeelError",
      code: "provider_rate_limited",
      message: expect.stringMatching(/DeepSeek API error \(429\)/),
    });
    expect(longRetryAfterRequests).toBe(1);
  });

  test(`Given the API times out a request once,
    When provider streams the response,
    Then it retries after retry-after-ms and returns the successful stream`, async () => {
    // Given
    transientTimeoutRequests = 0;
    const provider = createDeepseekProvider({
      apiKey: "test-key",
      baseUrl,
      model: "deepseek-v4-flash",
      retry: { maxRetries: 1, initialDelayMs: 100, maxDelayMs: 100 },
    });

    // When
    const events = await collect(
      provider.stream({
        systemPrompt: "You are helpful.",
        messages: [{ role: "user", content: "transient-timeout" }],
        signal: freshSignal(),
      }),
    );

    // Then
    expect(transientTimeoutRequests).toBe(2);
    const textEvents = events.filter((e) => e.type === "text");
    expect(textEvents.map((e) => e.text).join("")).toBe("Hello world");
  });

  test(`Given the API conflicts a request once,
    When provider streams the response,
    Then it retries after a retry-after date and returns the successful stream`, async () => {
    // Given
    transientConflictRequests = 0;
    const provider = createDeepseekProvider({
      apiKey: "test-key",
      baseUrl,
      model: "deepseek-v4-flash",
      retry: { maxRetries: 1, initialDelayMs: 100, maxDelayMs: 100 },
    });

    // When
    const events = await collect(
      provider.stream({
        systemPrompt: "You are helpful.",
        messages: [{ role: "user", content: "transient-conflict" }],
        signal: freshSignal(),
      }),
    );

    // Then
    expect(transientConflictRequests).toBe(2);
    const textEvents = events.filter((e) => e.type === "text");
    expect(textEvents.map((e) => e.text).join("")).toBe("Hello world");
  });

  test(`Given the API returns invalid retry-after headers,
    When provider streams the response,
    Then it falls back to local backoff and returns the successful stream`, async () => {
    // Given
    invalidRetryAfterRequests = 0;
    const provider = createDeepseekProvider({
      apiKey: "test-key",
      baseUrl,
      model: "deepseek-v4-flash",
      retry: {
        maxRetries: 1,
        initialDelayMs: 0,
        maxDelayMs: 0,
        jitterRatio: 0,
      },
    });

    // When
    const events = await collect(
      provider.stream({
        systemPrompt: "You are helpful.",
        messages: [{ role: "user", content: "invalid-retry-after" }],
        signal: freshSignal(),
      }),
    );

    // Then
    expect(invalidRetryAfterRequests).toBe(2);
    const textEvents = events.filter((e) => e.type === "text");
    expect(textEvents.map((e) => e.text).join("")).toBe("Hello world");
  });

  test(`Given the API returns a server error,
    When provider attempts to stream,
    Then it throws a provider server error with status and message`, async () => {
    // Given
    const provider = createDeepseekProvider({
      apiKey: "test-key",
      baseUrl,
      model: "deepseek-v4-flash",
      retry: { maxRetries: 0 },
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

  test(`Given the API returns a server error once,
    When provider streams the response,
    Then it retries and returns the successful stream`, async () => {
    // Given
    transientServerErrorRequests = 0;
    const provider = createDeepseekProvider({
      apiKey: "test-key",
      baseUrl,
      model: "deepseek-v4-flash",
      retry: { maxRetries: 1, initialDelayMs: 0, maxDelayMs: 0 },
    });

    // When
    const events = await collect(
      provider.stream({
        systemPrompt: "You are helpful.",
        messages: [{ role: "user", content: "transient-server-error" }],
        signal: freshSignal(),
      }),
    );

    // Then
    expect(transientServerErrorRequests).toBe(2);
    const textEvents = events.filter((e) => e.type === "text");
    expect(textEvents.map((e) => e.text).join("")).toBe("Hello world");
  });

  test(`Given the calculated retry delay exceeds the configured maximum,
    When provider retries a transient server error,
    Then it uses the capped delay and returns the successful stream`, async () => {
    // Given
    transientServerErrorRequests = 0;
    const provider = createDeepseekProvider({
      apiKey: "test-key",
      baseUrl,
      model: "deepseek-v4-flash",
      retry: {
        maxRetries: 1,
        initialDelayMs: 10_000,
        maxDelayMs: 0,
        jitterRatio: 0,
      },
    });

    // When
    const events = await collect(
      provider.stream({
        systemPrompt: "You are helpful.",
        messages: [{ role: "user", content: "transient-server-error" }],
        signal: freshSignal(),
      }),
    );

    // Then
    expect(transientServerErrorRequests).toBe(2);
    const textEvents = events.filter((e) => e.type === "text");
    expect(textEvents.map((e) => e.text).join("")).toBe("Hello world");
  });

  test(`Given rate limits continue past the retry budget,
    When provider attempts to stream,
    Then it throws the final rate limit error`, async () => {
    // Given
    const provider = createDeepseekProvider({
      apiKey: "test-key",
      baseUrl,
      model: "deepseek-v4-flash",
      retry: { maxRetries: 1, initialDelayMs: 0, maxDelayMs: 0 },
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

  test(`Given the API rejects authentication,
    When provider attempts to stream with retries configured,
    Then it does not retry the request`, async () => {
    // Given
    authRetryRequests = 0;
    const provider = createDeepseekProvider({
      apiKey: "test-key",
      baseUrl,
      model: "deepseek-v4-flash",
      retry: { maxRetries: 2, initialDelayMs: 0, maxDelayMs: 0 },
    });

    // When / Then
    await expect(
      collect(
        provider.stream({
          systemPrompt: "You are helpful.",
          messages: [{ role: "user", content: "auth-never-retry" }],
          signal: freshSignal(),
        }),
      ),
    ).rejects.toMatchObject({
      name: "KeelError",
      code: "provider_auth_failed",
    });
    expect(authRetryRequests).toBe(1);
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

  test(`Given the stream ends without a finish reason,
    When provider validates the completed stream,
    Then it throws a protocol error instead of yielding stop`, async () => {
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
          messages: [{ role: "user", content: "missing-finish-reason" }],
          signal: freshSignal(),
        }),
      ),
    ).rejects.toMatchObject({
      name: "KeelError",
      code: "provider_protocol_error",
      message: "DeepSeek stream finished with reason: none",
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

  test(`Given a stream chunk has neither choices nor usage,
    When provider validates the chunk,
    Then it throws an invalid schema protocol error`, async () => {
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
          messages: [{ role: "user", content: "empty-schema-chunk" }],
          signal: freshSignal(),
        }),
      ),
    ).rejects.toMatchObject({
      name: "KeelError",
      code: "provider_protocol_error",
      message: "DeepSeek stream chunk has invalid schema",
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

  test(`Given a stream chunk has inconsistent cache usage totals,
    When provider reads the chunk,
    Then it throws a protocol error before reporting usage`, async () => {
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
          messages: [{ role: "user", content: "inconsistent-cache-usage" }],
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
      usage: {
        inputTokens: 8,
        cachedInputTokens: 0,
        uncachedInputTokens: 8,
        outputTokens: 4,
      },
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
      usage: {
        inputTokens: 7,
        cachedInputTokens: 0,
        uncachedInputTokens: 7,
        outputTokens: 3,
      },
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

  test(`Given a read tool call includes an offset and limit,
    When provider finishes the tool call,
    Then it yields the read tool call with that requested window`, async () => {
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
        messages: [{ role: "user", content: "read-window-tool-call" }],
        signal: freshSignal(),
      }),
    );

    // Then
    expect(events).toEqual([
      {
        type: "tool_call",
        id: "call_read_0",
        tool: "read",
        path: "large.txt",
        offset: 607,
        limit: 20,
      },
      {
        type: "stop",
        usage: {
          inputTokens: 30,
          cachedInputTokens: 0,
          uncachedInputTokens: 30,
          outputTokens: 8,
        },
      },
    ]);
  });

  test(`Given a read tool call only includes a path,
    When provider finishes the tool call,
    Then it yields the read tool call without a requested window`, async () => {
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
        messages: [{ role: "user", content: "read-basic-tool-call" }],
        signal: freshSignal(),
      }),
    );

    // Then
    expect(events).toEqual([
      {
        type: "tool_call",
        id: "call_read_0",
        tool: "read",
        path: "note.txt",
      },
      {
        type: "stop",
        usage: {
          inputTokens: 24,
          cachedInputTokens: 0,
          uncachedInputTokens: 24,
          outputTokens: 6,
        },
      },
    ]);
  });

  test(`Given a grep tool call includes a pattern and path,
    When provider finishes the tool call,
    Then it yields the grep tool call with that requested search path`, async () => {
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
        messages: [{ role: "user", content: "grep-tool-call" }],
        signal: freshSignal(),
      }),
    );

    // Then
    expect(events).toEqual([
      {
        type: "tool_call",
        id: "call_grep_0",
        tool: "grep",
        pattern: "handleSubmit",
        path: "src",
      },
      {
        type: "stop",
        usage: {
          inputTokens: 26,
          cachedInputTokens: 0,
          uncachedInputTokens: 26,
          outputTokens: 7,
        },
      },
    ]);
  });

  test(`Given a write tool call includes a path and content,
    When provider finishes the tool call,
    Then it yields the write tool call with that create-file request`, async () => {
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
        messages: [{ role: "user", content: "write-tool-call" }],
        signal: freshSignal(),
      }),
    );

    // Then
    expect(events).toEqual([
      {
        type: "tool_call",
        id: "call_write_0",
        tool: "write",
        path: "config.json",
        content: '{"created":true}\n',
      },
      {
        type: "stop",
        usage: {
          inputTokens: 28,
          cachedInputTokens: 0,
          uncachedInputTokens: 28,
          outputTokens: 7,
        },
      },
    ]);
  });

  test(`Given a grep tool call sends an empty pattern,
    When provider validates the completed tool call,
    Then it yields the tool call so grep can return a recoverable error`, async () => {
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
        messages: [{ role: "user", content: "empty-grep-pattern" }],
        signal: freshSignal(),
      }),
    );

    // Then
    expect(events).toEqual([
      {
        type: "tool_call",
        id: "call_grep_0",
        tool: "grep",
        pattern: "",
      },
      {
        type: "stop",
        usage: {
          inputTokens: 25,
          cachedInputTokens: 0,
          uncachedInputTokens: 25,
          outputTokens: 6,
        },
      },
    ]);
  });

  test(`Given a bash tool call includes a command and timeout,
    When provider finishes the tool call,
    Then it yields the bash tool call with that execution request`, async () => {
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
        messages: [{ role: "user", content: "bash-tool-call" }],
        signal: freshSignal(),
        allowBash: true,
      }),
    );

    // Then
    expect(events).toEqual([
      {
        type: "tool_call",
        id: "call_bash_0",
        tool: "bash",
        command: "pnpm test",
        timeoutMs: 1000,
      },
      {
        type: "stop",
        usage: {
          inputTokens: 27,
          cachedInputTokens: 0,
          uncachedInputTokens: 27,
          outputTokens: 7,
        },
      },
    ]);
  });

  test(`Given a stream chunk contains multiple tool calls,
    When provider reads the chunk,
    Then it emits each tool call before the stop event`, async () => {
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
        messages: [{ role: "user", content: "multiple-tool-calls" }],
        signal: freshSignal(),
      }),
    );

    // Then
    expect(events).toEqual([
      {
        type: "tool_call",
        id: "call_edit_0",
        tool: "edit",
        path: "one.txt",
        oldString: "old",
        newString: "new",
      },
      {
        type: "tool_call",
        id: "call_edit_1",
        tool: "edit",
        path: "two.txt",
        oldString: "old",
        newString: "new",
      },
      {
        type: "stop",
        usage: {
          inputTokens: 30,
          cachedInputTokens: 0,
          uncachedInputTokens: 30,
          outputTokens: 8,
        },
      },
    ]);
  });

  test(`Given a stream chunk contains a nonzero tool call index,
    When provider reads the chunk,
    Then it parses that indexed tool call`, async () => {
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
        messages: [{ role: "user", content: "nonzero-tool-call-index" }],
        signal: freshSignal(),
      }),
    );

    // Then
    expect(events).toEqual([
      {
        type: "tool_call",
        id: "call_edit_1",
        tool: "edit",
        path: "note.txt",
        oldString: "old",
        newString: "new",
      },
      {
        type: "stop",
        usage: {
          inputTokens: 30,
          cachedInputTokens: 0,
          uncachedInputTokens: 30,
          outputTokens: 8,
        },
      },
    ]);
  });

  test(`Given an edit tool call never sends arguments,
    When provider finishes the tool call,
    Then it throws a protocol error with an empty arguments message`, async () => {
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
          messages: [{ role: "user", content: "missing-tool-arguments" }],
          signal: freshSignal(),
        }),
      ),
    ).rejects.toMatchObject({
      name: "KeelError",
      code: "provider_protocol_error",
      message: "DeepSeek edit tool call has empty arguments",
    });
  });

  test(`Given a tool call delta is missing its index,
    When provider reads the stream chunk,
    Then it throws a protocol error before accumulating the tool call`, async () => {
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
          messages: [{ role: "user", content: "missing-tool-call-index" }],
          signal: freshSignal(),
        }),
      ),
    ).rejects.toMatchObject({
      name: "KeelError",
      code: "provider_protocol_error",
      message: "DeepSeek tool call is missing index",
    });
  });

  test(`Given an edit tool call sends empty arguments,
    When provider finishes the tool call,
    Then it throws a protocol error with an empty arguments message`, async () => {
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
          messages: [{ role: "user", content: "empty-tool-arguments" }],
          signal: freshSignal(),
        }),
      ),
    ).rejects.toMatchObject({
      name: "KeelError",
      code: "provider_protocol_error",
      message: "DeepSeek edit tool call has empty arguments",
    });
  });

  test(`Given a read tool call sends invalid JSON arguments,
    When provider validates the completed tool call,
    Then it throws a read argument protocol error`, async () => {
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
          messages: [{ role: "user", content: "invalid-json-arguments" }],
          signal: freshSignal(),
        }),
      ),
    ).rejects.toMatchObject({
      name: "KeelError",
      code: "provider_protocol_error",
      message: "DeepSeek read tool call has invalid JSON arguments",
    });
  });

  test(`Given a tool call is missing an id,
    When provider finishes the tool call,
    Then it throws a protocol error before exposing the tool call`, async () => {
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
          messages: [{ role: "user", content: "missing-tool-call-id" }],
          signal: freshSignal(),
        }),
      ),
    ).rejects.toMatchObject({
      name: "KeelError",
      code: "provider_protocol_error",
      message: "DeepSeek tool call is missing id",
    });
  });

  test(`Given a tool call names an unsupported tool,
    When provider finishes the tool call,
    Then it throws a protocol error instead of yielding the tool call`, async () => {
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
          messages: [{ role: "user", content: "unsupported-tool-name" }],
          signal: freshSignal(),
        }),
      ),
    ).rejects.toMatchObject({
      name: "KeelError",
      code: "provider_protocol_error",
      message: "DeepSeek returned unsupported tool call: delete",
    });
  });

  test(`Given a read tool call has invalid arguments,
    When provider validates the completed tool call,
    Then it throws a read argument protocol error`, async () => {
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
          messages: [{ role: "user", content: "invalid-read-arguments" }],
          signal: freshSignal(),
        }),
      ),
    ).rejects.toMatchObject({
      name: "KeelError",
      code: "provider_protocol_error",
      message: "DeepSeek read tool call has invalid arguments",
    });
  });

  test(`Given a grep tool call is missing its pattern,
    When provider validates the completed tool call,
    Then it throws a grep argument protocol error`, async () => {
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
          messages: [{ role: "user", content: "invalid-grep-arguments" }],
          signal: freshSignal(),
        }),
      ),
    ).rejects.toMatchObject({
      name: "KeelError",
      code: "provider_protocol_error",
      message: "DeepSeek grep tool call has invalid arguments",
    });
  });

  test(`Given a write tool call is missing its content,
    When provider validates the completed tool call,
    Then it throws a write argument protocol error`, async () => {
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
          messages: [{ role: "user", content: "invalid-write-arguments" }],
          signal: freshSignal(),
        }),
      ),
    ).rejects.toMatchObject({
      name: "KeelError",
      code: "provider_protocol_error",
      message: "DeepSeek write tool call has invalid arguments",
    });
  });

  test(`Given a bash tool call is missing its command,
    When provider validates the completed tool call,
    Then it throws a bash argument protocol error`, async () => {
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
          messages: [{ role: "user", content: "invalid-bash-arguments" }],
          signal: freshSignal(),
          allowBash: true,
        }),
      ),
    ).rejects.toMatchObject({
      name: "KeelError",
      code: "provider_protocol_error",
      message: "DeepSeek bash tool call has invalid arguments",
    });
  });

  test(`Given an edit tool call is missing replacement text,
    When provider validates the completed tool call,
    Then it throws an edit argument protocol error`, async () => {
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
          messages: [{ role: "user", content: "invalid-edit-arguments" }],
          signal: freshSignal(),
        }),
      ),
    ).rejects.toMatchObject({
      name: "KeelError",
      code: "provider_protocol_error",
      message: "DeepSeek edit tool call has invalid arguments",
    });
  });

  test(`Given the stream claims tool_calls without sending a tool call,
    When provider reads the stream,
    Then it throws a protocol error instead of yielding an empty tool call`, async () => {
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
          messages: [{ role: "user", content: "tool-calls-without-delta" }],
          signal: freshSignal(),
        }),
      ),
    ).rejects.toMatchObject({
      name: "KeelError",
      code: "provider_protocol_error",
      message: "DeepSeek stream finished with tool_calls but no tool call",
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
      retry: { maxRetries: 0 },
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

  test(`Given the provider cannot connect on the first attempt,
    When the API becomes available before the retry,
    Then it retries the network error and streams successfully`, async () => {
    // Given
    const port = await unusedLocalPort();
    let requests = 0;
    let listening = false;
    const retryServer = createServer((_req, res) => {
      requests++;
      writeSseResponse(res, [sseChunk("network recovered"), sseFinish(1, 1)]);
    });
    const listeningPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        retryServer.listen(port, "127.0.0.1", () => {
          listening = true;
          resolve();
        });
      }, 20);
    });
    const provider = createDeepseekProvider({
      apiKey: "test-key",
      baseUrl: `http://127.0.0.1:${port}`,
      model: "deepseek-v4-flash",
      retry: {
        maxRetries: 1,
        initialDelayMs: 50,
        maxDelayMs: 50,
        jitterRatio: 0,
      },
    });

    try {
      // When
      const events = await collect(
        provider.stream({
          systemPrompt: "You are helpful.",
          messages: [{ role: "user", content: "hi" }],
          signal: freshSignal(),
        }),
      );
      await listeningPromise;

      // Then
      expect(requests).toBe(1);
      const textEvents = events.filter((e) => e.type === "text");
      expect(textEvents.map((e) => e.text).join("")).toBe("network recovered");
    } finally {
      await listeningPromise;
      if (listening) {
        await closeServer(retryServer);
      }
    }
  });

  test(`Given a retryable provider failure enters backoff,
    When the caller aborts before the retry,
    Then it throws an aborted provider error`, async () => {
    // Given
    const controller = new AbortController();
    const provider = createDeepseekProvider({
      apiKey: "test-key",
      baseUrl,
      model: "deepseek-v4-flash",
      retry: {
        maxRetries: 1,
        initialDelayMs: 1_000,
        maxDelayMs: 1_000,
        jitterRatio: 0,
      },
    });
    const result = collect(
      provider.stream({
        systemPrompt: "You are helpful.",
        messages: [{ role: "user", content: "rate-limited" }],
        signal: controller.signal,
      }),
    );

    // When
    setTimeout(() => {
      controller.abort();
    }, 20);

    // Then
    await expect(result).rejects.toMatchObject({
      name: "KeelError",
      code: "provider_aborted",
      message: "DeepSeek request was aborted",
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

  test(`Given the API returns delta with content null and reasoning_content,
    When provider reads the stream,
    Then it ignores null content and emits only non-null text`, async () => {
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
        messages: [{ role: "user", content: "reasoning-with-null-content" }],
        signal: freshSignal(),
      }),
    );

    // Then
    const textEvents = events.filter((e) => e.type === "text");
    expect(textEvents.map((e) => e.text).join("")).toBe("Hello!");

    const stopEvent = events.find((e) => e.type === "stop");
    expect(stopEvent).toEqual({
      type: "stop",
      usage: {
        inputTokens: 12,
        cachedInputTokens: 0,
        uncachedInputTokens: 12,
        outputTokens: 6,
      },
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

    try {
      // When
      await collect(
        provider.stream({
          systemPrompt: "sys",
          messages: [{ role: "user", content: "hi" }],
          signal: freshSignal(),
        }),
      );

      // Then
      const parsed = parseDeepseekRequestBody(capturedBody);
      expect(parsed.stream_options).toEqual({ include_usage: true });
    } finally {
      await closeServer(captureServer);
    }
  });

  test(`Given shell commands are not allowed,
    When provider sends the request body,
    Then it does not advertise the bash tool`, async () => {
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

    try {
      // When
      await collect(
        provider.stream({
          systemPrompt: "sys",
          messages: [{ role: "user", content: "hi" }],
          signal: freshSignal(),
        }),
      );

      // Then
      const parsed = parseDeepseekRequestBody(capturedBody);
      expect(parsed.tools?.map((tool) => tool.function.name)).toEqual([
        "read",
        "grep",
        "edit",
        "write",
      ]);
    } finally {
      await closeServer(captureServer);
    }
  });

  test(`Given the caller forbids tool use for a wrap-up turn,
    When provider sends the request body,
    Then it advertises no tools so the model cannot call any`, async () => {
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

    try {
      // When
      await collect(
        provider.stream({
          systemPrompt: "sys",
          messages: [{ role: "user", content: "hi" }],
          signal: freshSignal(),
          toolChoice: "none",
        }),
      );

      // Then
      const parsed = parseDeepseekRequestBody(capturedBody);
      expect(parsed.tools).toBeUndefined();
      expect(parsed).not.toHaveProperty("tool_choice");
    } finally {
      await closeServer(captureServer);
    }
  });

  test(`Given shell commands are allowed,
    When provider sends the request body,
    Then it advertises the bash tool with command validation owned by the tool`, async () => {
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

    try {
      // When
      await collect(
        provider.stream({
          systemPrompt: "sys",
          messages: [{ role: "user", content: "hi" }],
          signal: freshSignal(),
          allowBash: true,
        }),
      );

      // Then
      const parsed = parseDeepseekRequestBody(capturedBody);
      expect(parsed.tools?.map((tool) => tool.function.name)).toEqual([
        "read",
        "grep",
        "edit",
        "write",
        "bash",
      ]);
      const bashToolDefinition = parsed.tools?.find(
        (tool) => tool.function.name === "bash",
      );
      if (bashToolDefinition === undefined) {
        throw new Error("Expected bash tool definition");
      }
      const commandSchema = bashToolParametersSchema.parse(
        bashToolDefinition.function.parameters,
      ).properties.command;
      expect(commandSchema).toMatchObject({ type: "string" });
      expect(commandSchema).not.toHaveProperty("minLength");
    } finally {
      await closeServer(captureServer);
    }
  });

  test(`Given provider advertises the grep tool,
    When it sends the request body,
    Then empty-pattern validation remains owned by the grep tool`, async () => {
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

    try {
      // When
      await collect(
        provider.stream({
          systemPrompt: "sys",
          messages: [{ role: "user", content: "hi" }],
          signal: freshSignal(),
        }),
      );

      // Then
      const parsed = parseDeepseekRequestBody(capturedBody);
      if (parsed.tools === undefined) {
        throw new Error("Expected tools array");
      }
      const grepToolDefinition = parsed.tools.find(
        (tool) => tool.function.name === "grep",
      );
      if (grepToolDefinition === undefined) {
        throw new Error("Expected grep tool definition");
      }
      const patternSchema = grepToolParametersSchema.parse(
        grepToolDefinition.function.parameters,
      ).properties.pattern;
      expect(patternSchema).toMatchObject({ type: "string" });
      expect(patternSchema).not.toHaveProperty("minLength");
    } finally {
      await closeServer(captureServer);
    }
  });

  test(`Given provider advertises the write tool,
    When it sends the request body,
    Then the schema describes create-only file writes with path and content`, async () => {
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

    try {
      // When
      await collect(
        provider.stream({
          systemPrompt: "sys",
          messages: [{ role: "user", content: "hi" }],
          signal: freshSignal(),
        }),
      );

      // Then
      const parsed = parseDeepseekRequestBody(capturedBody);
      if (parsed.tools === undefined) {
        throw new Error("Expected tools array");
      }
      const writeToolDefinition = parsed.tools.find(
        (tool) => tool.function.name === "write",
      );
      if (writeToolDefinition === undefined) {
        throw new Error("Expected write tool definition");
      }
      const parameters = writeToolParametersSchema.parse(
        writeToolDefinition.function.parameters,
      );
      expect(parameters).toMatchObject({
        required: ["path", "content"],
        additionalProperties: false,
      });
      expect(parameters.properties.path).toMatchObject({ type: "string" });
      expect(parameters.properties.content).toMatchObject({ type: "string" });
      expect(writeToolDefinition.function.description).toContain(
        "Fails if the file already exists",
      );
    } finally {
      await closeServer(captureServer);
    }
  });

  test(`Given the provider advertises workspace tools,
    When it sends the request body,
    Then every tool description carries use-when, do-not-use, and on-failure guidance`, async () => {
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

    try {
      // When
      await collect(
        provider.stream({
          systemPrompt: "sys",
          messages: [{ role: "user", content: "hi" }],
          signal: freshSignal(),
          allowBash: true,
        }),
      );

      // Then
      const parsed = parseDeepseekRequestBody(capturedBody);
      if (parsed.tools === undefined) {
        throw new Error("Expected tools array");
      }
      expect(parsed.tools.map((tool) => tool.function.name)).toEqual([
        "read",
        "grep",
        "edit",
        "write",
        "bash",
      ]);
      for (const tool of parsed.tools) {
        const description = tool.function.description;
        if (typeof description !== "string") {
          throw new Error(
            `Expected a description string for ${tool.function.name}`,
          );
        }
        expect(description).toContain("Use when:");
        expect(description).toContain("Do not use when:");
        expect(description).toContain("On failure:");
      }
    } finally {
      await closeServer(captureServer);
    }
  });
});
