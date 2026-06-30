import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Server } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";
import type { ProviderRetryConfig } from "../llm/providers/openai-compatible.ts";
import type { LLMEvent, LLMProvider } from "../llm/types.ts";
import { close, getPort, listen } from "./provider-sse-fixtures.ts";

interface OpenAICompatibleConformanceConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly retry?: ProviderRetryConfig;
}

interface ConformanceUsageTokens {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface OpenAICompatibleConformanceProvider {
  readonly id: string;
  readonly name: string;
  readonly model: string;
  readonly createProvider: (
    config: OpenAICompatibleConformanceConfig,
  ) => LLMProvider;
  readonly usage: (tokens: ConformanceUsageTokens) => unknown;
}

type FinishReason =
  | { readonly kind: "absent" }
  | { readonly kind: "value"; readonly value: string | null };

interface SuccessCase {
  readonly label: string;
  readonly prompt: string;
  readonly chunks: (
    provider: OpenAICompatibleConformanceProvider,
  ) => readonly string[];
  readonly expectedEvents: readonly LLMEvent[];
}

interface FailureCase {
  readonly label: string;
  readonly prompt: string;
  readonly chunks: (
    provider: OpenAICompatibleConformanceProvider,
  ) => readonly string[];
  readonly message: (provider: OpenAICompatibleConformanceProvider) => string;
}

const usageTokens = {
  inputTokens: 10,
  outputTokens: 3,
} satisfies ConformanceUsageTokens;

const expectedUsage = {
  inputTokens: usageTokens.inputTokens,
  cachedInputTokens: 0,
  uncachedInputTokens: usageTokens.inputTokens,
  outputTokens: usageTokens.outputTokens,
};

const requestBodySchema = z
  .object({
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

function sseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function sseDone(): string {
  return "data: [DONE]\n\n";
}

function toolCallChunk(
  id: string,
  name: string,
  argumentsJson: string | null | undefined,
): string {
  const toolFunction =
    argumentsJson === undefined ? { name } : { name, arguments: argumentsJson };
  return sseData({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id,
              type: "function",
              function: toolFunction,
            },
          ],
        },
        finish_reason: null,
      },
    ],
    usage: null,
  });
}

function finishChunk(
  provider: OpenAICompatibleConformanceProvider,
  finishReason: FinishReason,
): string {
  const choice =
    finishReason.kind === "absent"
      ? { delta: {} }
      : { delta: {}, finish_reason: finishReason.value };
  return sseData({
    choices: [choice],
    usage: provider.usage(usageTokens),
  });
}

function toolResponse(
  provider: OpenAICompatibleConformanceProvider,
  finishReason: FinishReason,
): readonly string[] {
  return [
    toolCallChunk(
      "call_conformance_read",
      "read",
      JSON.stringify({ path: "README.md" }),
    ),
    finishChunk(provider, finishReason),
    sseDone(),
  ];
}

function zeroArgumentToolResponse(
  provider: OpenAICompatibleConformanceProvider,
  argumentsJson: string | null | undefined,
): readonly string[] {
  return [
    toolCallChunk("call_conformance_ls", "ls", argumentsJson),
    finishChunk(provider, { kind: "value", value: "tool_calls" }),
    sseDone(),
  ];
}

function failureFinishResponse(
  provider: OpenAICompatibleConformanceProvider,
  finishReason: FinishReason,
): readonly string[] {
  return [finishChunk(provider, finishReason), sseDone()];
}

const readToolCallEvents = [
  {
    type: "tool_call",
    id: "call_conformance_read",
    tool: "read",
    path: "README.md",
  },
  {
    type: "stop",
    reason: "stop",
    usage: expectedUsage,
  },
] satisfies readonly LLMEvent[];

const lsToolCallEvents = [
  {
    type: "tool_call",
    id: "call_conformance_ls",
    tool: "ls",
  },
  {
    type: "stop",
    reason: "stop",
    usage: expectedUsage,
  },
] satisfies readonly LLMEvent[];

const successCases = [
  {
    label: "tool_calls finish_reason",
    prompt: "conformance-tool-calls-finish",
    chunks: (provider) =>
      toolResponse(provider, { kind: "value", value: "tool_calls" }),
    expectedEvents: readToolCallEvents,
  },
  {
    label: "stop finish_reason",
    prompt: "conformance-stop-finish",
    chunks: (provider) =>
      toolResponse(provider, { kind: "value", value: "stop" }),
    expectedEvents: readToolCallEvents,
  },
  {
    label: "null finish_reason",
    prompt: "conformance-null-finish",
    chunks: (provider) =>
      toolResponse(provider, { kind: "value", value: null }),
    expectedEvents: readToolCallEvents,
  },
  {
    label: "absent finish_reason",
    prompt: "conformance-absent-finish",
    chunks: (provider) => toolResponse(provider, { kind: "absent" }),
    expectedEvents: readToolCallEvents,
  },
  {
    label: "empty zero-argument tool arguments",
    prompt: "conformance-empty-zero-arguments",
    chunks: (provider) => zeroArgumentToolResponse(provider, ""),
    expectedEvents: lsToolCallEvents,
  },
  {
    label: "omitted zero-argument tool arguments",
    prompt: "conformance-omitted-zero-arguments",
    chunks: (provider) => zeroArgumentToolResponse(provider, undefined),
    expectedEvents: lsToolCallEvents,
  },
] satisfies readonly SuccessCase[];

const failureCases = [
  {
    label: "tool_calls finish without a tool call",
    prompt: "conformance-tool-calls-without-tool",
    chunks: (provider) =>
      failureFinishResponse(provider, {
        kind: "value",
        value: "tool_calls",
      }),
    message: (provider) =>
      `${provider.name} stream finished with tool_calls but no tool call`,
  },
  {
    label: "text-only stream without finish_reason",
    prompt: "conformance-text-without-finish-reason",
    chunks: (provider) => [
      sseData({ choices: [{ delta: { content: "partial" } }] }),
      finishChunk(provider, { kind: "absent" }),
      sseDone(),
    ],
    message: (provider) => `${provider.name} stream finished with reason: none`,
  },
  {
    label: "unknown finish_reason",
    prompt: "conformance-unknown-finish-reason",
    chunks: (provider) =>
      failureFinishResponse(provider, {
        kind: "value",
        value: "content_filter",
      }),
    message: (provider) =>
      `${provider.name} stream finished with reason: content_filter`,
  },
] satisfies readonly FailureCase[];

function requestBody(req: IncomingMessage): Promise<string> {
  let body = "";
  return new Promise((resolve, reject) => {
    req.on("data", (chunk: Buffer | string) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      resolve(body);
    });
    req.on("error", reject);
  });
}

function promptFromRequestBody(body: string): string | null {
  const parsed: unknown = JSON.parse(body);
  const result = requestBodySchema.parse(parsed);
  const userMessages = result.messages.filter(
    (message) => message.role === "user" && typeof message.content === "string",
  );
  return userMessages.at(-1)?.content ?? null;
}

function chunksForPrompt(
  prompt: string | null,
  provider: OpenAICompatibleConformanceProvider,
): readonly string[] | null {
  for (const row of [...successCases, ...failureCases]) {
    if (row.prompt === prompt) {
      return row.chunks(provider);
    }
  }
  return null;
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

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  provider: OpenAICompatibleConformanceProvider,
): Promise<void> {
  if (req.url !== "/chat/completions") {
    res.writeHead(404);
    res.end();
    return;
  }

  try {
    const body = await requestBody(req);
    const chunks = chunksForPrompt(promptFromRequestBody(body), provider);
    if (chunks === null) {
      res.writeHead(500);
      res.end("unknown conformance prompt");
      return;
    }
    writeSseResponse(res, chunks);
  } catch (error) {
    res.writeHead(500);
    res.end(error instanceof Error ? error.message : "invalid request");
  }
}

function createProvider(
  spec: OpenAICompatibleConformanceProvider,
  baseUrl: string,
): LLMProvider {
  return spec.createProvider({
    apiKey: `test-${spec.id}-key`,
    baseUrl,
    model: spec.model,
    retry: { maxRetries: 0 },
  });
}

function freshSignal(): AbortSignal {
  return new AbortController().signal;
}

async function collect(stream: AsyncIterable<LLMEvent>): Promise<LLMEvent[]> {
  const events: LLMEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

async function streamFor(
  provider: LLMProvider,
  prompt: string,
): Promise<LLMEvent[]> {
  return await collect(
    provider.stream({
      systemPrompt: "You are Keel.",
      messages: [{ role: "user", content: prompt }],
      signal: freshSignal(),
    }),
  );
}

export function runOpenAICompatibleConformance(
  providers: readonly OpenAICompatibleConformanceProvider[],
): void {
  describe.each(providers)("OpenAI-compatible conformance: $name", (spec) => {
    let server: Server;
    let provider: LLMProvider;

    beforeAll(async () => {
      server = createServer((req, res) => {
        void handleRequest(req, res, spec);
      });
      await listen(server);
      provider = createProvider(spec, `http://127.0.0.1:${getPort(server)}`);
    });

    afterAll(async () => {
      await close(server);
    });

    test.each(successCases)(`Given the enrolled provider streams $label,
      When the shared OpenAI-compatible conformance harness reads the stream,
      Then the provider emits the normalized Keel events`, async (row) => {
      // When
      const events = await streamFor(provider, row.prompt);

      // Then
      expect(events).toEqual(row.expectedEvents);
    });

    test.each(failureCases)(`Given the enrolled provider streams $label,
      When the shared OpenAI-compatible conformance harness reads the stream,
      Then the provider reports a protocol error`, async (row) => {
      // When / Then
      await expect(streamFor(provider, row.prompt)).rejects.toMatchObject({
        name: "KeelError",
        code: "provider_protocol_error",
        message: row.message(spec),
      });
    });
  });
}
