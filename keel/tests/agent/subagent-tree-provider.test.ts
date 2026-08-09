import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { afterEach, describe, expect, test } from "vitest";
import { createSubagentTreeProvider } from "../../src/agent/subagent-tree-provider.ts";
import { KeelError } from "../../src/core/error.ts";
import { createDeepseekProvider } from "../../src/llm/providers/deepseek.ts";
import type { LLMEvent, LLMProvider } from "../../src/llm/types.ts";
import { sseTextReplyWithUsage } from "../../src/testing/provider-sse-fixtures.ts";

const servers = new Set<ReturnType<typeof createServer>>();

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<string> {
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
  return `http://127.0.0.1:${address.port}`;
}

async function collect(
  provider: LLMProvider,
  systemPrompt: string,
  signal: AbortSignal = new AbortController().signal,
): Promise<readonly LLMEvent[]> {
  const events: LLMEvent[] = [];
  for await (const event of provider.stream({
    systemPrompt,
    messages: [{ role: "user", content: "complete this request" }],
    signal,
  })) {
    events.push(event);
  }
  return events;
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

describe("Subagent tree provider", () => {
  test(`Given four child turns are ready while the tree has two provider request slots,
    When one queued child is cancelled and the live pair releases its slots,
    Then only two physical requests run, cancellation stays local, and the remaining child proceeds`, async () => {
    const firstPairArrived = Promise.withResolvers<void>();
    const thirdArrived = Promise.withResolvers<void>();
    const heldResponses: ServerResponse[] = [];
    let requests = 0;
    const baseUrl = await listen((req, res) => {
      req.resume();
      req.on("end", () => {
        requests++;
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        if (requests <= 2) {
          heldResponses.push(res);
          if (requests === 2) firstPairArrived.resolve();
          return;
        }
        thirdArrived.resolve();
        res.end(sseTextReplyWithUsage("third completed"));
      });
    });
    const rawProvider = createDeepseekProvider({
      apiKey: "test-key",
      baseUrl,
      model: "deepseek-test",
      retry: { maxRetries: 0 },
    });
    const tree = createSubagentTreeProvider({ provider: rawProvider });
    const preAborted = new AbortController();
    preAborted.abort(new Error("cancel before provider admission"));
    await expect(
      collect(tree.provider, "pre-aborted-child", preAborted.signal),
    ).rejects.toMatchObject({ code: "provider_aborted" });
    expect(requests).toBe(0);
    const queuedCancellation = new AbortController();
    const first = collect(tree.provider, "one-child");
    const second = collect(tree.provider, "two-child");
    const cancelled = collect(
      tree.provider,
      "cancelled-child",
      queuedCancellation.signal,
    );
    const fourth = collect(tree.provider, "four-child");

    await firstPairArrived.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(requests).toBe(2);
    queuedCancellation.abort(new Error("cancel queued child"));
    await expect(cancelled).rejects.toMatchObject({
      code: "provider_aborted",
    });
    for (const response of heldResponses) {
      response.end(sseTextReplyWithUsage("held child completed"));
    }
    await thirdArrived.promise;
    await Promise.all([first, second, fourth]);

    expect(requests).toBe(3);
  });

  test(`Given two sibling requests are rate limited together,
    When their provider retries share one tree coordinator,
    Then both recover with staggered bounded backoff instead of a retry storm`, async () => {
    const requestCounts = new Map<string, number>();
    const baseUrl = await listen((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const child = body.includes("alpha-child") ? "alpha" : "beta";
        const count = (requestCounts.get(child) ?? 0) + 1;
        requestCounts.set(child, count);
        if (count === 1) {
          res.writeHead(429, {
            "Content-Type": "application/json",
            "retry-after-ms": "0",
          });
          res.end(JSON.stringify({ error: { message: "retry" } }));
          return;
        }
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.end(sseTextReplyWithUsage(`${child} recovered`));
      });
    });
    const rawProvider = createDeepseekProvider({
      apiKey: "test-key",
      baseUrl,
      model: "deepseek-test",
      retry: {
        maxRetries: 4,
        initialDelayMs: 0,
        maxDelayMs: 0,
        jitterRatio: 0,
      },
    });
    const tree = createSubagentTreeProvider({
      provider: rawProvider,
      now: () => 0,
      retrySpacingMs: 7,
    });

    const [alpha, beta] = await Promise.all([
      collect(tree.provider, "alpha-child"),
      collect(tree.provider, "beta-child"),
    ]);

    const retryDelays = [...alpha, ...beta]
      .filter((event) => event.type === "provider_retry")
      .map((event) => event.delayMs)
      .toSorted((left, right) => left - right);
    expect(requestCounts).toEqual(
      new Map([
        ["alpha", 2],
        ["beta", 2],
      ]),
    );
    expect(retryDelays).toEqual([7, 14]);
    expect(tree.blocked()).toBe(false);
  });

  test(`Given provider retries would exceed either the tree attempt or delay budget,
    When a child receives a retryable rate limit,
    Then coordination denies the retry and opens the shared circuit after one request`, async () => {
    let requests = 0;
    const baseUrl = await listen((req, res) => {
      req.resume();
      req.on("end", () => {
        requests++;
        res.writeHead(429, {
          "Content-Type": "application/json",
          "retry-after-ms": "0",
        });
        res.end(JSON.stringify({ error: { message: "retry denied" } }));
      });
    });
    const rawProvider = createDeepseekProvider({
      apiKey: "test-key",
      baseUrl,
      model: "deepseek-test",
      retry: {
        maxRetries: 4,
        initialDelayMs: 0,
        maxDelayMs: 0,
        jitterRatio: 0,
      },
    });
    const trees = [
      createSubagentTreeProvider({ provider: rawProvider, maxTreeRetries: 0 }),
      createSubagentTreeProvider({
        provider: rawProvider,
        now: () => 0,
        retrySpacingMs: 7,
        maxTotalRetryDelayMs: 0,
      }),
    ];

    for (const [index, tree] of trees.entries()) {
      await expect(
        collect(tree.provider, `retry-budget-${index}`),
      ).rejects.toMatchObject({ code: "provider_rate_limited" });
      expect(tree.blocked()).toBe(true);
    }
    expect(requests).toBe(2);
  });

  test(`Given one sibling receives a terminal authentication failure,
    When the tree circuit opens while another sibling is live,
    Then both observe provider blockage and later requests fail before transport`, async () => {
    const siblingStarted = Promise.withResolvers<void>();
    let providerCalls = 0;
    const rawProvider: LLMProvider = {
      id: "tree-circuit-provider",
      abortSignalSupport: true,
      async *stream(options) {
        providerCalls++;
        if (options.systemPrompt === "sibling") {
          siblingStarted.resolve();
          await new Promise<void>((_resolve, reject) => {
            const rejectAborted = () =>
              reject(
                new KeelError("provider_aborted", "sibling request aborted"),
              );
            if (options.signal.aborted) rejectAborted();
            else
              options.signal.addEventListener("abort", rejectAborted, {
                once: true,
              });
          });
        } else {
          await siblingStarted.promise;
          throw new KeelError(
            "provider_auth_failed",
            "provider credentials are invalid",
          );
        }
        yield { type: "text", text: "unreachable" };
      },
    };
    const tree = createSubagentTreeProvider({ provider: rawProvider });

    const results = await Promise.allSettled([
      collect(tree.provider, "sibling"),
      collect(tree.provider, "auth-failure"),
    ]);

    expect(results).toMatchObject([
      { status: "rejected", reason: { code: "provider_auth_failed" } },
      { status: "rejected", reason: { code: "provider_auth_failed" } },
    ]);
    expect(tree.blocked()).toBe(true);
    await expect(collect(tree.provider, "later")).rejects.toMatchObject({
      code: "provider_auth_failed",
    });
    expect(providerCalls).toBe(2);
  });
});
