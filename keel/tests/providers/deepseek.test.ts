import { createServer, type ServerResponse } from "node:http";
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
  let capturedMessages: unknown;

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

          if (parsed.messages?.[1]?.content === "missing-finish-reason") {
            writeSseResponse(res, [
              sseChunk("partial output"),
              sseData({
                choices: [{ delta: {} }],
                usage: { prompt_tokens: 10, completion_tokens: 4 },
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
                usage: { prompt_tokens: 30, completion_tokens: 8 },
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
                usage: { prompt_tokens: 30, completion_tokens: 8 },
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
                usage: { prompt_tokens: 24, completion_tokens: 6 },
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
                usage: { prompt_tokens: 30, completion_tokens: 8 },
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
                usage: { prompt_tokens: 30, completion_tokens: 8 },
              }),
            );
            res.write("data: [DONE]\n\n");
            res.end();
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
                usage: { prompt_tokens: 30, completion_tokens: 8 },
              }),
            );
            res.write("data: [DONE]\n\n");
            res.end();
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
                usage: { prompt_tokens: 30, completion_tokens: 8 },
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
                usage: { prompt_tokens: 30, completion_tokens: 8 },
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
                usage: { prompt_tokens: 30, completion_tokens: 8 },
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
                usage: { prompt_tokens: 30, completion_tokens: 8 },
              }),
              "data: [DONE]\n\n",
            ]);
            return;
          }

          if (parsed.messages?.[1]?.content === "tool-calls-without-delta") {
            writeSseResponse(res, [
              sseData({
                choices: [{ delta: {}, finish_reason: "tool_calls" }],
                usage: { prompt_tokens: 30, completion_tokens: 8 },
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
                usage: { prompt_tokens: 12, completion_tokens: 6 },
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
        ],
        signal: freshSignal(),
      }),
    );

    // Then
    expect(capturedMessages).toEqual([
      { role: "system", content: "You are helpful." },
      { role: "user", content: "serialize-history" },
      { role: "assistant", content: "plain answer" },
      {
        role: "assistant",
        content: null,
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
        content: null,
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
        content: null,
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
      arrayElement(capturedMessages, 7),
      "tool_calls",
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
      { type: "stop", usage: { inputTokens: 30, outputTokens: 8 } },
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
      { type: "stop", usage: { inputTokens: 24, outputTokens: 6 } },
    ]);
  });

  test(`Given a stream chunk contains multiple tool calls,
    When provider reads the chunk,
    Then it throws a protocol error instead of ignoring extra tool calls`, async () => {
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
          messages: [{ role: "user", content: "multiple-tool-calls" }],
          signal: freshSignal(),
        }),
      ),
    ).rejects.toMatchObject({
      name: "KeelError",
      code: "provider_protocol_error",
      message: "DeepSeek returned more than one tool call",
    });
  });

  test(`Given a stream chunk contains a nonzero tool call index,
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
          messages: [{ role: "user", content: "nonzero-tool-call-index" }],
          signal: freshSignal(),
        }),
      ),
    ).rejects.toMatchObject({
      name: "KeelError",
      code: "provider_protocol_error",
      message: "DeepSeek returned unsupported tool call index: 1",
    });
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
      usage: { inputTokens: 12, outputTokens: 6 },
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
