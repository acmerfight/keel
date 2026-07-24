import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { afterEach, describe, expect, test } from "vitest";
import { createDeepseekProvider } from "../../src/llm/providers/deepseek.ts";
import type {
  LLMEvent,
  ProviderRequestAttemptFinish,
  ProviderRequestAttemptObserver,
} from "../../src/llm/types.ts";

interface ObservedAttempt {
  readonly finishes: ProviderRequestAttemptFinish[];
}

const servers = new Set<ReturnType<typeof createServer>>();

async function localServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ readonly baseUrl: string }> {
  const server = createServer(handler);
  servers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("local provider server has no TCP address");
  }
  return { baseUrl: `http://127.0.0.1:${address.port}` };
}

function observeAttempts(): {
  readonly observer: ProviderRequestAttemptObserver;
  readonly attempts: ObservedAttempt[];
} {
  const attempts: ObservedAttempt[] = [];
  return {
    attempts,
    observer: {
      begin: () => {
        const attempt: ObservedAttempt = { finishes: [] };
        attempts.push(attempt);
        return {
          finish: (result) => {
            if (attempt.finishes.length > 0) {
              throw new Error("provider attempt finished more than once");
            }
            attempt.finishes.push(result);
          },
        };
      },
    },
  };
}

interface TestProviderOptions {
  readonly maxRetries: number;
  readonly liveness: {
    readonly firstResponseTimeoutMs: number;
    readonly streamInactivityTimeoutMs: number;
  };
}

const DEFAULT_PROVIDER_OPTIONS: TestProviderOptions = {
  maxRetries: 0,
  liveness: {
    firstResponseTimeoutMs: 250,
    streamInactivityTimeoutMs: 50,
  },
};

function provider(
  baseUrl: string,
  options: TestProviderOptions = DEFAULT_PROVIDER_OPTIONS,
) {
  return createDeepseekProvider({
    apiKey: "test-key",
    baseUrl,
    model: "deepseek-v4-flash",
    retry: {
      maxRetries: options.maxRetries,
      initialDelayMs: 0,
      maxDelayMs: 0,
      jitterRatio: 0,
    },
    liveness: options.liveness,
  });
}

function streamOptions(
  observer?: ProviderRequestAttemptObserver,
  signal = new AbortController().signal,
) {
  return {
    systemPrompt: "You are helpful.",
    messages: [{ role: "user" as const, content: "hello" }],
    signal,
    ...(observer === undefined ? {} : { providerRequestAttempts: observer }),
  };
}

async function collect(source: AsyncIterable<LLMEvent>): Promise<LLMEvent[]> {
  const events: LLMEvent[] = [];
  for await (const event of source) events.push(event);
  return events;
}

function withDeadline<T>(promise: Promise<T>, timeoutMs = 1_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("provider stream exceeded the test deadline")),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function writeSse(res: ServerResponse, value: unknown): void {
  res.write(`data: ${JSON.stringify(value)}\n\n`);
}

function finishSse(res: ServerResponse, text = ""): void {
  if (text !== "") {
    writeSse(res, { choices: [{ delta: { content: text } }] });
  }
  writeSse(res, {
    choices: [{ delta: {}, finish_reason: "stop" }],
    usage: {
      prompt_tokens: 1,
      prompt_cache_hit_tokens: 0,
      prompt_cache_miss_tokens: 1,
      completion_tokens: text === "" ? 0 : 1,
    },
  });
  res.end("data: [DONE]\n\n");
}

afterEach(async () => {
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
  servers.clear();
});

describe("OpenAI-Compatible Provider Liveness", () => {
  test(`Given a successful response starts but sends no SSE event,
    When the stream inactivity deadline expires,
    Then the physical request is aborted with a distinct timeout`, async () => {
    // Given
    let requests = 0;
    const { baseUrl } = await localServer((req, res) => {
      requests++;
      req.resume();
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.flushHeaders();
    });
    const observed = observeAttempts();

    // When / Then
    await expect(
      withDeadline(
        collect(provider(baseUrl).stream(streamOptions(observed.observer))),
      ),
    ).rejects.toMatchObject({
      name: "KeelError",
      code: "stream_inactivity_timeout",
      message: "DeepSeek stream timed out waiting for activity",
    });
    expect(requests).toBe(1);
    expect(observed.attempts).toEqual([
      {
        finishes: [
          {
            outcome: "terminal_error",
            errorCode: "stream_inactivity_timeout",
          },
        ],
      },
    ]);
  });

  test(`Given a stream stalls before emitting assistant output,
    When the configured retry budget is larger than the timeout recovery limit,
    Then the provider retries once and records both physical attempts`, async () => {
    // Given
    let requests = 0;
    const { baseUrl } = await localServer((req, res) => {
      requests++;
      req.resume();
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.flushHeaders();
    });
    const observed = observeAttempts();

    // When / Then
    await expect(
      withDeadline(
        collect(
          provider(baseUrl, {
            ...DEFAULT_PROVIDER_OPTIONS,
            maxRetries: 4,
          }).stream(streamOptions(observed.observer)),
        ),
      ),
    ).rejects.toMatchObject({ code: "stream_inactivity_timeout" });
    expect(requests).toBe(2);
    expect(
      observed.attempts.map((attempt) => attempt.finishes[0]),
    ).toMatchObject([
      {
        outcome: "retryable_error",
        retryDecision: {
          reason: "stream_inactivity_timeout",
          attempt: 1,
          maxRetries: 4,
        },
      },
      {
        outcome: "terminal_error",
        errorCode: "stream_inactivity_timeout",
      },
    ]);
  });

  test(`Given each valid SSE event arrives inside the inactivity window,
    When the total response lasts longer than one window,
    Then activity renews the deadline and the response completes`, async () => {
    // Given
    const { baseUrl } = await localServer((req, res) => {
      req.resume();
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.flushHeaders();
      const timers = [
        setTimeout(
          () =>
            writeSse(res, {
              choices: [{ delta: { reasoning_content: "one" } }],
            }),
          15,
        ),
        setTimeout(
          () =>
            writeSse(res, {
              choices: [{ delta: { reasoning_content: "two" } }],
            }),
          40,
        ),
        setTimeout(
          () =>
            writeSse(res, {
              choices: [{ delta: { reasoning_content: "three" } }],
            }),
          65,
        ),
        setTimeout(() => finishSse(res, "done"), 90),
      ];
      res.on("close", () => {
        for (const timer of timers) clearTimeout(timer);
      });
    });

    // When
    const events = await withDeadline(
      collect(
        provider(baseUrl, {
          ...DEFAULT_PROVIDER_OPTIONS,
          liveness: {
            ...DEFAULT_PROVIDER_OPTIONS.liveness,
            streamInactivityTimeoutMs: 35,
          },
        }).stream(streamOptions()),
      ),
    );

    // Then
    expect(events).toMatchObject([
      { type: "reasoning", text: "one" },
      { type: "reasoning", text: "two" },
      { type: "reasoning", text: "three" },
      { type: "text", text: "done" },
      { type: "stop", reason: "stop" },
    ]);
  });

  test(`Given a stalled stream only sends SSE heartbeat comments,
    When no valid upstream event arrives,
    Then heartbeats do not keep the request alive`, async () => {
    // Given
    const { baseUrl } = await localServer((req, res) => {
      req.resume();
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.flushHeaders();
      const heartbeat = setInterval(() => res.write(": keepalive\n\n"), 10);
      res.on("close", () => clearInterval(heartbeat));
    });

    // When / Then
    await expect(
      withDeadline(
        collect(
          provider(baseUrl, {
            ...DEFAULT_PROVIDER_OPTIONS,
            liveness: {
              ...DEFAULT_PROVIDER_OPTIONS.liveness,
              streamInactivityTimeoutMs: 40,
            },
          }).stream(streamOptions()),
        ),
      ),
    ).rejects.toMatchObject({ code: "stream_inactivity_timeout" });
  });

  test.each([
    {
      label: "text",
      chunk: { choices: [{ delta: { content: "partial" } }] },
      expectedEvents: [{ type: "text", text: "partial" }],
    },
    {
      label: "reasoning",
      chunk: { choices: [{ delta: { reasoning_content: "partial thought" } }] },
      expectedEvents: [{ type: "reasoning", text: "partial thought" }],
    },
    {
      label: "tool-call fragment",
      chunk: {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_read",
                  function: { name: "read", arguments: '{"path":' },
                },
              ],
            },
          },
        ],
      },
      expectedEvents: [],
    },
    {
      label: "complete tool call",
      chunk: {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_read",
                  function: {
                    name: "read",
                    arguments: '{"path":"README.md"}',
                  },
                },
              ],
            },
          },
        ],
      },
      expectedEvents: [],
    },
  ])(
    `Given a stream emits $label output and then stalls,
    When inactivity expires,
    Then the provider preserves emitted output and does not replay the request`,
    async ({ chunk, expectedEvents }) => {
      // Given
      let requests = 0;
      const { baseUrl } = await localServer((req, res) => {
        requests++;
        req.resume();
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.flushHeaders();
        writeSse(res, chunk);
      });
      const events: LLMEvent[] = [];

      // When
      const run = async () => {
        for await (const event of provider(baseUrl, {
          ...DEFAULT_PROVIDER_OPTIONS,
          maxRetries: 4,
        }).stream(streamOptions())) {
          events.push(event);
        }
      };

      // Then
      await expect(withDeadline(run())).rejects.toMatchObject({
        code: "stream_inactivity_timeout",
      });
      expect(events).toMatchObject(expectedEvents);
      expect(requests).toBe(1);
    },
  );

  test(`Given the user cancels a stream before its inactivity deadline,
    When abort and timeout are both possible terminal paths,
    Then user cancellation wins and the request is not retried`, async () => {
    // Given
    let requestStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    const { baseUrl } = await localServer((req, res) => {
      req.resume();
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.flushHeaders();
      requestStarted?.();
    });
    const controller = new AbortController();
    const observed = observeAttempts();
    const result = collect(
      provider(baseUrl, {
        ...DEFAULT_PROVIDER_OPTIONS,
        maxRetries: 4,
        liveness: {
          ...DEFAULT_PROVIDER_OPTIONS.liveness,
          streamInactivityTimeoutMs: 250,
        },
      }).stream(streamOptions(observed.observer, controller.signal)),
    );

    // When
    await started;
    controller.abort();

    // Then
    await expect(withDeadline(result)).rejects.toMatchObject({
      code: "provider_aborted",
    });
    expect(observed.attempts).toEqual([{ finishes: [{ outcome: "aborted" }] }]);
  });

  test(`Given a provider completes normally without visible text,
    When stop and usage arrive inside the inactivity window,
    Then the silent turn remains a successful response`, async () => {
    // Given
    const { baseUrl } = await localServer((req, res) => {
      req.resume();
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      finishSse(res);
    });

    // When
    const events = await withDeadline(
      collect(provider(baseUrl).stream(streamOptions())),
    );

    // Then
    expect(events).toEqual([
      {
        type: "stop",
        reason: "stop",
        usage: {
          inputTokens: 1,
          cachedInputTokens: 0,
          uncachedInputTokens: 1,
          outputTokens: 0,
        },
      },
    ]);
  });

  test.each([
    {
      label: "visible text",
      content: "done",
      expectedEvents: [
        { type: "text", text: "done" },
        { type: "stop", reason: "stop" },
      ],
    },
    {
      label: "a silent turn",
      content: "",
      expectedEvents: [{ type: "stop", reason: "stop" }],
    },
  ])(
    `Given a provider sends $label and DONE but keeps the HTTP body open,
    When the shared stream reader reaches the protocol terminator,
    Then it completes immediately and releases the upstream request`,
    async ({ content, expectedEvents }) => {
      // Given
      const { baseUrl } = await localServer((req, res) => {
        req.resume();
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        writeSse(res, {
          choices: [
            {
              delta: content === "" ? {} : { content },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 1,
            prompt_cache_hit_tokens: 0,
            prompt_cache_miss_tokens: 1,
            completion_tokens: content === "" ? 0 : 1,
          },
        });
        res.write("data: [DONE]\n\n");
      });

      // When
      const events = await withDeadline(
        collect(provider(baseUrl).stream(streamOptions())),
      );

      // Then
      expect(events).toMatchObject(expectedEvents);
    },
  );

  test(`Given a terminal HTTP response flushes headers but leaves its body open,
    When response-body activity exceeds the configured deadline,
    Then the provider aborts and settles one terminal physical attempt`, async () => {
    // Given
    let requests = 0;
    const { baseUrl } = await localServer((req, res) => {
      requests++;
      req.resume();
      res.writeHead(401, { "Content-Type": "application/json" });
      res.flushHeaders();
    });
    const observed = observeAttempts();

    // When / Then
    await expect(
      withDeadline(
        collect(provider(baseUrl).stream(streamOptions(observed.observer))),
      ),
    ).rejects.toMatchObject({
      code: "stream_inactivity_timeout",
      message: "DeepSeek response body timed out waiting for activity",
    });
    expect(requests).toBe(1);
    expect(observed.attempts).toEqual([
      {
        finishes: [
          {
            outcome: "terminal_error",
            errorCode: "stream_inactivity_timeout",
          },
        ],
      },
    ]);
  });

  test(`Given a terminal HTTP response cannot carry a body,
    When the provider classifies the completed response,
    Then it reports the HTTP failure without waiting for body activity`, async () => {
    // Given
    const { baseUrl } = await localServer((req, res) => {
      req.resume();
      res.writeHead(304);
      res.end();
    });
    const observed = observeAttempts();

    // When / Then
    await expect(
      collect(provider(baseUrl).stream(streamOptions(observed.observer))),
    ).rejects.toMatchObject({ code: "provider_http_error" });
    expect(observed.attempts).toEqual([
      {
        finishes: [
          {
            outcome: "terminal_error",
            errorCode: "provider_http_error",
          },
        ],
      },
    ]);
  });
});
