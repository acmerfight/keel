import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { afterEach, describe, expect, test } from "vitest";
import { createDeepseekProvider } from "../../src/llm/providers/deepseek.ts";
import {
  createFakeProvider,
  fakeResponse,
} from "../../src/llm/providers/fake.ts";
import { createKimiProvider } from "../../src/llm/providers/kimi.ts";
import { createQwenProvider } from "../../src/llm/providers/qwen.ts";
import type {
  LLMEvent,
  LLMProvider,
  ProviderRequestAttemptFinish,
  ProviderRequestAttemptObserver,
} from "../../src/llm/types.ts";

interface ObservedAttempt {
  readonly finishes: ProviderRequestAttemptFinish[];
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

function assertConformantAttemptCount(
  physicalRequests: number,
  attempts: readonly ObservedAttempt[],
): void {
  expect(attempts).toHaveLength(physicalRequests);
  for (const attempt of attempts) expect(attempt.finishes).toHaveLength(1);
}

function successfulSse(text = "ok"): string {
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}`,
    "",
    `data: ${JSON.stringify({
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 3,
        prompt_cache_hit_tokens: 0,
        prompt_cache_miss_tokens: 3,
        completion_tokens: 1,
      },
    })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");
}

function completedToolCallSse(): string {
  return [
    `data: ${JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_read_0",
                function: {
                  name: "read",
                  arguments: JSON.stringify({ path: "unexpected.txt" }),
                },
              },
            ],
          },
        },
      ],
    })}`,
    "",
    `data: ${JSON.stringify({
      choices: [{ delta: {}, finish_reason: "tool_calls" }],
      usage: {
        prompt_tokens: 10,
        prompt_cache_hit_tokens: 2,
        prompt_cache_miss_tokens: 8,
        completion_tokens: 3,
      },
    })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");
}

function respondWithSse(res: ServerResponse): void {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.end(successfulSse());
}

async function collect(source: AsyncIterable<LLMEvent>): Promise<LLMEvent[]> {
  const events: LLMEvent[] = [];
  for await (const event of source) events.push(event);
  return events;
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
    throw new Error("local provider conformance server has no TCP address");
  }
  return { baseUrl: `http://127.0.0.1:${address.port}` };
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

function streamOptions(
  observer: ProviderRequestAttemptObserver,
  signal = new AbortController().signal,
) {
  return {
    systemPrompt: "You are helpful.",
    messages: [{ role: "user" as const, content: "hello" }],
    signal,
    providerRequestAttempts: observer,
  };
}

const supportedProtocolProviders: readonly {
  readonly label: string;
  readonly create: (baseUrl: string) => LLMProvider;
}[] = [
  {
    label: "DeepSeek",
    create: (baseUrl) =>
      createDeepseekProvider({
        apiKey: "test-key",
        baseUrl,
        model: "deepseek-v4-flash",
        retry: { maxRetries: 0 },
      }),
  },
  {
    label: "Kimi",
    create: (baseUrl) =>
      createKimiProvider({
        apiKey: "test-key",
        baseUrl,
        model: "kimi-k2.5",
        retry: { maxRetries: 0 },
      }),
  },
  {
    label: "Qwen",
    create: (baseUrl) =>
      createQwenProvider({
        apiKey: "test-key",
        baseUrl,
        model: "qwen3.7-plus",
        retry: { maxRetries: 0 },
      }),
  },
];

describe("Provider Request Attempt Conformance", () => {
  test.each(supportedProtocolProviders)(
    `Given a $label initial upstream request succeeds,
    When the supported provider completes the stream,
    Then exactly one completed physical attempt records returned usage`,
    async ({ create }) => {
      let physicalRequests = 0;
      const { baseUrl } = await localServer((_req, res) => {
        physicalRequests++;
        respondWithSse(res);
      });
      const observed = observeAttempts();
      const provider = create(baseUrl);

      await collect(provider.stream(streamOptions(observed.observer)));

      assertConformantAttemptCount(physicalRequests, observed.attempts);
      expect(observed.attempts[0]?.finishes).toEqual([
        {
          outcome: "completed",
          usage: {
            inputTokens: 3,
            cachedInputTokens: 0,
            uncachedInputTokens: 3,
            outputTokens: 1,
          },
        },
      ]);
    },
  );

  test(`Given the supported fake provider completes one scripted request,
    When attempt observation is enabled,
    Then it also invokes and finishes the hook exactly once`, async () => {
    const observed = observeAttempts();
    const provider = createFakeProvider([fakeResponse("ok")]);

    await collect(provider.stream(streamOptions(observed.observer)));

    expect(observed.attempts).toHaveLength(1);
    expect(observed.attempts[0]?.finishes).toEqual([
      {
        outcome: "completed",
        usage: {
          inputTokens: 0,
          cachedInputTokens: 0,
          uncachedInputTokens: 0,
          outputTokens: 0,
        },
      },
    ]);
  });

  test(`Given the first upstream request is rate-limited and the retry succeeds,
    When the provider applies its retry policy,
    Then both physical attempts and the retry decision are recorded in order`, async () => {
    let physicalRequests = 0;
    const { baseUrl } = await localServer((_req, res) => {
      physicalRequests++;
      if (physicalRequests === 1) {
        res.writeHead(429, { "retry-after-ms": "0" });
        res.end("rate limited");
        return;
      }
      respondWithSse(res);
    });
    const observed = observeAttempts();
    const provider = createDeepseekProvider({
      apiKey: "test-key",
      baseUrl,
      model: "deepseek-v4-flash",
      retry: { maxRetries: 1, initialDelayMs: 0, maxDelayMs: 0 },
    });

    await collect(provider.stream(streamOptions(observed.observer)));

    assertConformantAttemptCount(physicalRequests, observed.attempts);
    expect(
      observed.attempts.map((attempt) => attempt.finishes[0]),
    ).toMatchObject([
      {
        outcome: "retryable_error",
        retryDecision: {
          provider: "DeepSeek",
          reason: "provider_rate_limited",
          attempt: 1,
          maxRetries: 1,
          delayMs: 0,
        },
      },
      { outcome: "completed" },
    ]);
  });

  test(`Given provider-visible context changes after a rate-limited attempt,
    When the provider sends its physical retry,
    Then it rebuilds the request with the latest system prompt`, async () => {
    let currentSystemPrompt = "first physical prompt";
    const receivedSystemPrompts: string[] = [];
    const { baseUrl } = await localServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        receivedSystemPrompts.push(body.messages[0].content);
        if (receivedSystemPrompts.length === 1) {
          currentSystemPrompt = "second physical prompt";
          res.writeHead(429, { "retry-after-ms": "0" });
          res.end("rate limited");
          return;
        }
        respondWithSse(res);
      });
    });
    const provider = createDeepseekProvider({
      apiKey: "test-key",
      baseUrl,
      model: "deepseek-v4-flash",
      retry: { maxRetries: 1, initialDelayMs: 0, maxDelayMs: 0 },
    });

    await collect(
      provider.stream({
        systemPrompt: currentSystemPrompt,
        requestSystemPrompt: () => currentSystemPrompt,
        messages: [{ role: "user", content: "retry with fresh context" }],
        signal: new AbortController().signal,
      }),
    );

    expect(receivedSystemPrompts).toEqual([
      "first physical prompt",
      "second physical prompt",
    ]);
  });

  test(`Given request setup fails before a server can receive bytes,
    When the provider attempts the invalid upstream URL once,
    Then the setup attempt is still recorded as terminal`, async () => {
    const observed = observeAttempts();
    const provider = createDeepseekProvider({
      apiKey: "test-key",
      baseUrl: "http://[invalid",
      model: "deepseek-v4-flash",
      retry: { maxRetries: 0 },
    });

    await expect(
      collect(provider.stream(streamOptions(observed.observer))),
    ).rejects.toMatchObject({ code: "provider_network_error" });

    expect(observed.attempts).toHaveLength(1);
    expect(observed.attempts[0]?.finishes).toEqual([
      { outcome: "terminal_error" },
    ]);
  });

  test.each([
    {
      label: "terminal pre-stream response",
      status: 401,
      body: "unauthorized",
      errorCode: "provider_auth_failed",
      attemptOutcome: "terminal_error" as const,
    },
    {
      label: "context overflow response",
      status: 400,
      body: "context_length_exceeded: prompt too long",
      errorCode: "provider_context_overflow",
      attemptOutcome: "context_overflow" as const,
    },
  ])(
    `Given a $label, Then its physical attempt has the exact failure outcome`,
    async ({ status, body, errorCode, attemptOutcome }) => {
      let physicalRequests = 0;
      const { baseUrl } = await localServer((_req, res) => {
        physicalRequests++;
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(body);
      });
      const observed = observeAttempts();
      const provider = createDeepseekProvider({
        apiKey: "test-key",
        baseUrl,
        model: "deepseek-v4-flash",
        retry: { maxRetries: 0 },
      });

      await expect(
        collect(provider.stream(streamOptions(observed.observer))),
      ).rejects.toMatchObject({ code: errorCode });

      assertConformantAttemptCount(physicalRequests, observed.attempts);
      expect(observed.attempts[0]?.finishes).toEqual([
        { outcome: attemptOutcome },
      ]);
    },
  );

  test(`Given a terminal HTTP response body is truncated after headers arrive,
    When the provider cannot read the error payload,
    Then the physical attempt is finalized as a terminal network failure`, async () => {
    let physicalRequests = 0;
    const { baseUrl } = await localServer((_req, res) => {
      physicalRequests++;
      res.writeHead(401, {
        "Content-Type": "application/json",
        "Content-Length": "100",
      });
      res.write("partial");
      setImmediate(() => res.destroy());
    });
    const observed = observeAttempts();
    const provider = createDeepseekProvider({
      apiKey: "test-key",
      baseUrl,
      model: "deepseek-v4-flash",
      retry: { maxRetries: 0 },
    });

    await expect(
      collect(provider.stream(streamOptions(observed.observer))),
    ).rejects.toMatchObject({ code: "provider_network_error" });

    assertConformantAttemptCount(physicalRequests, observed.attempts);
    expect(observed.attempts[0]?.finishes).toEqual([
      { outcome: "terminal_error" },
    ]);
  });

  test(`Given a terminal HTTP response body remains in flight,
    When the request is aborted while reading that body,
    Then the physical attempt is finalized as aborted`, async () => {
    let physicalRequests = 0;
    let bodyStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      bodyStarted = resolve;
    });
    const { baseUrl } = await localServer((_req, res) => {
      physicalRequests++;
      res.writeHead(401, { "Content-Type": "application/json" });
      res.write("partial");
      bodyStarted?.();
    });
    const observed = observeAttempts();
    const controller = new AbortController();
    const provider = createDeepseekProvider({
      apiKey: "test-key",
      baseUrl,
      model: "deepseek-v4-flash",
      retry: { maxRetries: 0 },
    });

    const result = collect(
      provider.stream(streamOptions(observed.observer, controller.signal)),
    );
    await started;
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
    await expect(result).rejects.toMatchObject({ code: "provider_aborted" });

    assertConformantAttemptCount(physicalRequests, observed.attempts);
    expect(observed.attempts[0]?.finishes).toEqual([{ outcome: "aborted" }]);
  });

  test(`Given an in-flight upstream request is aborted,
    When the provider observes the abort,
    Then the one physical attempt is finished as aborted`, async () => {
    let physicalRequests = 0;
    let requestReceived: (() => void) | undefined;
    const received = new Promise<void>((resolve) => {
      requestReceived = resolve;
    });
    const { baseUrl } = await localServer(() => {
      physicalRequests++;
      requestReceived?.();
    });
    const observed = observeAttempts();
    const controller = new AbortController();
    const provider = createDeepseekProvider({
      apiKey: "test-key",
      baseUrl,
      model: "deepseek-v4-flash",
      retry: { maxRetries: 0 },
    });

    const result = collect(
      provider.stream(streamOptions(observed.observer, controller.signal)),
    );
    await received;
    controller.abort();
    await expect(result).rejects.toMatchObject({ code: "provider_aborted" });

    assertConformantAttemptCount(physicalRequests, observed.attempts);
    expect(observed.attempts[0]?.finishes).toEqual([{ outcome: "aborted" }]);
  });

  test(`Given a consumer stops reading after the first streamed event,
    When the provider iterator is closed before usage arrives,
    Then the physical attempt is still finalized as terminal`, async () => {
    let physicalRequests = 0;
    const { baseUrl } = await localServer((_req, res) => {
      physicalRequests++;
      respondWithSse(res);
    });
    const observed = observeAttempts();
    const provider = createDeepseekProvider({
      apiKey: "test-key",
      baseUrl,
      model: "deepseek-v4-flash",
      retry: { maxRetries: 0 },
    });
    const iterator = provider
      .stream(streamOptions(observed.observer))
      [Symbol.asyncIterator]();

    const first = await iterator.next();
    await iterator.return?.();

    expect(first.value).toMatchObject({ type: "text" });
    assertConformantAttemptCount(physicalRequests, observed.attempts);
    expect(observed.attempts[0]?.finishes).toEqual([
      { outcome: "terminal_error" },
    ]);
  });

  test(`Given a complete upstream response buffers a tool call and returns usage,
    When the consumer closes after receiving that tool call but before reading stop,
    Then the physical request remains completed with its returned usage`, async () => {
    let physicalRequests = 0;
    const { baseUrl } = await localServer((_req, res) => {
      physicalRequests++;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(completedToolCallSse());
    });
    const observed = observeAttempts();
    const provider = createDeepseekProvider({
      apiKey: "test-key",
      baseUrl,
      model: "deepseek-v4-flash",
      retry: { maxRetries: 0 },
    });
    const iterator = provider
      .stream(streamOptions(observed.observer))
      [Symbol.asyncIterator]();

    const first = await iterator.next();
    await iterator.return?.();

    expect(first.value).toMatchObject({ type: "tool_call", tool: "read" });
    assertConformantAttemptCount(physicalRequests, observed.attempts);
    expect(observed.attempts[0]?.finishes).toEqual([
      {
        outcome: "completed",
        usage: {
          inputTokens: 10,
          cachedInputTokens: 2,
          uncachedInputTokens: 8,
          outputTokens: 3,
        },
      },
    ]);
  });

  test(`Given a provider implementation skips or double-invokes the attempt hook,
    When the conformance assertion compares hooks with physical requests,
    Then either non-conforming provider fails conformance`, async () => {
    const { baseUrl } = await localServer((_req, res) => {
      respondWithSse(res);
    });
    const usage = {
      inputTokens: 1,
      cachedInputTokens: 0,
      uncachedInputTokens: 1,
      outputTokens: 1,
    };
    const providerWithHookCount = (hookCount: number): LLMProvider => ({
      id: `non-conforming-${hookCount}`,
      async *stream(options) {
        const attempts = Array.from(
          { length: hookCount },
          () => options.providerRequestAttempts?.begin() ?? null,
        );
        await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          signal: options.signal,
        });
        for (const attempt of attempts) {
          attempt?.finish({ outcome: "completed", usage });
        }
        yield { type: "stop", reason: "stop", usage };
      },
    });

    for (const hookCount of [0, 2]) {
      const observed = observeAttempts();
      await collect(
        providerWithHookCount(hookCount).stream(
          streamOptions(observed.observer),
        ),
      );
      expect(() =>
        assertConformantAttemptCount(1, observed.attempts),
      ).toThrow();
    }
  });
});
