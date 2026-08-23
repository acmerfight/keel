import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { afterEach, expect, test } from "vitest";
import type { AgentEvent } from "../../src/agent/events.ts";
import { runAgent } from "../../src/agent/loop.ts";
import { defaultStopPolicy } from "../../src/agent/stop-policy.ts";
import { createModelOperationReportLedger } from "../../src/cli/report-model-operations.ts";
import { ZERO_COST_MODEL } from "../../src/core/cost.ts";
import { createDeepseekProvider } from "../../src/llm/providers/deepseek.ts";

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

function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("agent remained stuck on the provider request")),
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

test(`Given the upstream accepts requests without returning response headers,
  When the user asks Keel to complete a task,
  Then Keel retries once and reports a bounded first-response timeout`, async () => {
  // Given
  let physicalRequests = 0;
  const { baseUrl } = await localServer((req) => {
    physicalRequests++;
    req.resume();
  });
  const provider = createDeepseekProvider({
    apiKey: "test-key",
    baseUrl,
    model: "deepseek-v4-flash",
    retry: {
      maxRetries: 4,
      initialDelayMs: 0,
      maxDelayMs: 0,
      jitterRatio: 0,
    },
    liveness: {
      firstResponseTimeoutMs: 250,
      streamInactivityTimeoutMs: 100,
    },
  });
  const events: AgentEvent[] = [];
  const modelOperations = createModelOperationReportLedger(() => null);

  // When
  const run = async () => {
    for await (const event of runAgent({
      workspace: process.cwd(),
      provider,
      userMessage: "finish the task",
      systemPrompt: "You are helpful.",
      signal: new AbortController().signal,
      bash: { kind: "trusted" },
      stopPolicy: defaultStopPolicy(),
      modelOperations: {
        recorder: modelOperations,
        owner: { type: "session" },
        provider: provider.id,
        model: "deepseek-v4-flash",
        costModel: ZERO_COST_MODEL,
      },
    })) {
      events.push(event);
    }
  };

  // Then
  await expect(withDeadline(run(), 1_000)).rejects.toMatchObject({
    name: "KeelError",
    code: "first_response_timeout",
    message: "DeepSeek request timed out before response headers",
  });
  expect(physicalRequests).toBe(2);
  expect(events).toEqual([
    {
      type: "provider_retry",
      provider: "DeepSeek",
      reason: "first_response_timeout",
      attempt: 1,
      maxRetries: 4,
      delayMs: 0,
    },
  ]);
  expect(modelOperations.modelOperations()).toMatchObject([
    {
      outcome: "terminal_error",
      providerRequestAttempts: [
        {
          outcome: "retryable_error",
          retryDecision: {
            reason: "first_response_timeout",
            attempt: 1,
            maxRetries: 4,
          },
        },
        {
          outcome: "terminal_error",
          errorCode: "first_response_timeout",
        },
      ],
    },
  ]);
});
