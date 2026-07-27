import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Server } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";
import type { ProviderId } from "../core/provider-id.ts";
import type { ProviderRetryConfig } from "../llm/providers/openai-compatible.ts";
import type { LLMEvent, LLMProvider } from "../llm/types.ts";
import {
  compileMcpProviderInputSchema,
  mcpProviderSchemaTarget,
} from "../mcp/provider-schema.ts";
import type {
  McpModelToolDefinition,
  ModelToolExposure,
} from "../tools/tool-call.ts";
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
  readonly id: ProviderId;
  readonly name: string;
  readonly model: string;
  readonly maxOutputTokensField: "max_completion_tokens" | "max_tokens";
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

interface ReplaySuccessCase {
  readonly label: string;
  readonly prompt: string;
  readonly chunks: (
    provider: OpenAICompatibleConformanceProvider,
    requestCount: number,
  ) => readonly string[];
  readonly expectedEvents: (
    provider: OpenAICompatibleConformanceProvider,
  ) => readonly LLMEvent[];
  readonly expectedRequests: number;
}

interface ReplayFailureCase {
  readonly label: string;
  readonly prompt: string;
  readonly chunks: (
    provider: OpenAICompatibleConformanceProvider,
    requestCount: number,
  ) => readonly string[];
  readonly message: (provider: OpenAICompatibleConformanceProvider) => string;
  readonly expectedRequests: number;
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

const conformanceMcpTool = {
  kind: "mcp",
  modelName: "mcp__catalog__search",
  description: "External catalog search",
  parameters: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
    additionalProperties: false,
  },
  reference: {
    kind: "mcp",
    serverId: "catalog",
    serverOrigin: "https://catalog.example",
    rawToolName: "search",
    configurationDigest: "a".repeat(64),
    catalogGeneration: `catalog:${"b".repeat(64)}`,
    descriptorDigest: "c".repeat(64),
  },
} satisfies McpModelToolDefinition;

const mcpExposure: ModelToolExposure = {
  kind: "auto",
  mcp: {
    snapshotId: "conformance-mcp",
    tools: [conformanceMcpTool],
  },
};

const requestBodySchema = z
  .object({
    max_tokens: z.number().int().positive().optional(),
    max_completion_tokens: z.number().int().positive().optional(),
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

function textDelta(content: string): string {
  return sseData({
    choices: [
      {
        delta: { content },
        finish_reason: null,
      },
    ],
    usage: null,
  });
}

function textResponse(
  provider: OpenAICompatibleConformanceProvider,
  content: string,
): readonly string[] {
  return [
    textDelta(content),
    finishChunk(provider, { kind: "value", value: "stop" }),
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

function providerRetryEvent(
  provider: OpenAICompatibleConformanceProvider,
): LLMEvent {
  return {
    type: "provider_retry",
    provider: provider.name,
    reason: "provider_protocol_error",
    attempt: 1,
    maxRetries: 1,
    delayMs: 0,
  };
}

const replaySuccessCases = [
  {
    label: "a pre-output incomplete stream before text",
    prompt: "conformance-replay-before-text",
    chunks: (provider, requestCount) =>
      requestCount === 1 ? [] : textResponse(provider, "recovered"),
    expectedEvents: (provider) => [
      providerRetryEvent(provider),
      { type: "text", text: "recovered" },
      {
        type: "stop",
        reason: "stop",
        usage: expectedUsage,
      },
    ],
    expectedRequests: 2,
  },
  {
    label: "a pre-output incomplete stream after tool call fragments",
    prompt: "conformance-replay-before-tool-call",
    chunks: (provider, requestCount) =>
      requestCount === 1
        ? [
            toolCallChunk(
              "call_discarded_read",
              "read",
              JSON.stringify({ path: "discarded.md" }),
            ),
          ]
        : toolResponse(provider, { kind: "value", value: "tool_calls" }),
    expectedEvents: (provider) => [
      providerRetryEvent(provider),
      ...readToolCallEvents,
    ],
    expectedRequests: 2,
  },
] satisfies readonly ReplaySuccessCase[];

const replayFailureCases = [
  {
    label: "an incomplete stream after text output",
    prompt: "conformance-no-replay-after-text",
    chunks: () => [textDelta("partial")],
    message: (provider) =>
      `${provider.name} stream ended without [DONE] signal`,
    expectedRequests: 1,
  },
] satisfies readonly ReplayFailureCase[];

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
  requestCount: number,
): readonly string[] | null {
  if (prompt === "conformance-output-budget") {
    return textResponse(provider, "bounded");
  }
  if (prompt === "conformance-unbounded-output") {
    return textResponse(provider, "unbounded");
  }
  if (prompt === "conformance-mainstream-mcp-schema") {
    return textResponse(provider, "schema accepted");
  }
  if (prompt === "conformance-mcp-tool") {
    return [
      toolCallChunk(
        "call_conformance_mcp",
        "mcp__catalog__search",
        JSON.stringify({ query: "otters" }),
      ),
      finishChunk(provider, { kind: "value", value: "tool_calls" }),
      sseDone(),
    ];
  }
  if (prompt === "conformance-invalid-mcp-tool") {
    return [
      toolCallChunk(
        "call_conformance_invalid_mcp",
        "mcp__catalog__search",
        JSON.stringify(["not", "an", "object"]),
      ),
      finishChunk(provider, { kind: "value", value: "tool_calls" }),
      sseDone(),
    ];
  }
  if (prompt === "conformance-disabled-mcp-tool") {
    return [
      toolCallChunk(
        "call_conformance_disabled_mcp",
        "mcp__catalog__search",
        JSON.stringify({ query: "otters" }),
      ),
      finishChunk(provider, { kind: "value", value: "tool_calls" }),
      sseDone(),
    ];
  }
  if (prompt === "conformance-missing-tool-name") {
    return [
      sseData({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_conformance_missing_name",
                  type: "function",
                  function: { arguments: "{}" },
                },
              ],
            },
            finish_reason: null,
          },
        ],
        usage: null,
      }),
      finishChunk(provider, { kind: "value", value: "tool_calls" }),
      sseDone(),
    ];
  }
  for (const row of [...successCases, ...failureCases]) {
    if (row.prompt === prompt) {
      return row.chunks(provider);
    }
  }
  for (const row of [...replaySuccessCases, ...replayFailureCases]) {
    if (row.prompt === prompt) {
      return row.chunks(provider, requestCount);
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
  requestCounts: Map<string, number>,
  requestBodies: Map<string, string>,
): Promise<void> {
  if (req.url !== "/chat/completions") {
    res.writeHead(404);
    res.end();
    return;
  }

  try {
    const body = await requestBody(req);
    const prompt = promptFromRequestBody(body);
    const requestCount =
      (prompt === null ? 0 : (requestCounts.get(prompt) ?? 0)) + 1;
    if (prompt !== null) {
      requestCounts.set(prompt, requestCount);
      requestBodies.set(prompt, body);
    }
    const chunks = chunksForPrompt(prompt, provider, requestCount);
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
  retry: ProviderRetryConfig = { maxRetries: 0 },
): LLMProvider {
  return spec.createProvider({
    apiKey: `test-${spec.id}-key`,
    baseUrl,
    model: spec.model,
    retry,
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
    let requestCounts: Map<string, number>;
    let requestBodies: Map<string, string>;

    beforeAll(async () => {
      requestCounts = new Map();
      requestBodies = new Map();
      server = createServer((req, res) => {
        void handleRequest(req, res, spec, requestCounts, requestBodies);
      });
      await listen(server);
      provider = createProvider(spec, `http://127.0.0.1:${getPort(server)}`);
    });

    afterAll(async () => {
      await close(server);
    });

    test.each(successCases)(
      `Given the enrolled provider streams $label,
      When the shared OpenAI-compatible conformance harness reads the stream,
      Then the provider emits the normalized Keel events`,
      async (row) => {
        // When
        const events = await streamFor(provider, row.prompt);

        // Then
        expect(events).toEqual(row.expectedEvents);
      },
    );

    test(`Given an affordable completion token budget,
      When the enrolled provider sends a bounded request,
      Then it uses the provider's supported output limit field`, async () => {
      // When
      await collect(
        provider.stream({
          systemPrompt: "You are Keel.",
          messages: [{ role: "user", content: "conformance-output-budget" }],
          signal: freshSignal(),
          maxOutputTokens: 321,
        }),
      );

      // Then
      const body = requestBodies.get("conformance-output-budget");
      expect(body).toBeDefined();
      const parsed = requestBodySchema.parse(JSON.parse(body ?? ""));
      expect(parsed[spec.maxOutputTokensField]).toBe(321);
      const otherField =
        spec.maxOutputTokensField === "max_tokens"
          ? "max_completion_tokens"
          : "max_tokens";
      expect(parsed[otherField]).toBeUndefined();
    });

    test(`Given no completion token budget,
      When the enrolled provider sends its request,
      Then it omits both supported output limit fields`, async () => {
      // When
      await streamFor(provider, "conformance-unbounded-output");

      // Then
      const body = requestBodies.get("conformance-unbounded-output");
      expect(body).toBeDefined();
      const parsed = requestBodySchema.parse(JSON.parse(body ?? ""));
      expect(parsed.max_tokens).toBeUndefined();
      expect(parsed.max_completion_tokens).toBeUndefined();
    });

    test(`Given a frozen turn exposes one dynamic MCP tool,
      When the provider returns its exact name or invalid arguments,
      Then the adapter routes the typed reference and distinguishes invalid arguments from unsupported tools`, async () => {
      const validEvents = await collect(
        provider.stream({
          systemPrompt: "You are Keel.",
          messages: [{ role: "user", content: "conformance-mcp-tool" }],
          signal: freshSignal(),
          toolExposure: mcpExposure,
        }),
      );

      expect(validEvents[0]).toMatchObject({
        type: "tool_call",
        kind: "mcp",
        id: "call_conformance_mcp",
        tool: "mcp__catalog__search",
        arguments: { query: "otters" },
      });
      await expect(
        collect(
          provider.stream({
            systemPrompt: "You are Keel.",
            messages: [
              { role: "user", content: "conformance-invalid-mcp-tool" },
            ],
            signal: freshSignal(),
            toolExposure: mcpExposure,
          }),
        ),
      ).rejects.toThrow(
        `${spec.name} mcp__catalog__search tool call has invalid arguments`,
      );
      await expect(
        collect(
          provider.stream({
            systemPrompt: "You are Keel.",
            messages: [
              { role: "user", content: "conformance-disabled-mcp-tool" },
            ],
            signal: freshSignal(),
            toolExposure: { kind: "none" },
          }),
        ),
      ).rejects.toThrow(
        `${spec.name} returned unsupported tool call: mcp__catalog__search`,
      );
      await expect(
        streamFor(provider, "conformance-missing-tool-name"),
      ).rejects.toThrow(`${spec.name} returned unsupported tool call: none`);
    });

    test(`Given a mainstream MCP schema contains a union, nullable type array, and dynamic map,
      When the enrolled provider sends a real request,
      Then the request contains that provider's explicit compiled projection`, async () => {
      // Given
      const compilation = compileMcpProviderInputSchema(
        {
          type: "object",
          properties: {
            repoName: {
              anyOf: [
                { type: "string" },
                { type: "array", items: { type: "string" } },
              ],
            },
            cursor: { type: ["integer", "null"] },
            metadata: {
              type: "object",
              additionalProperties: { type: "string" },
            },
          },
          required: ["repoName"],
        },
        mcpProviderSchemaTarget(spec.id, spec.model),
      );
      expect(compilation.ok).toBe(true);
      if (!compilation.ok) return;
      const exposure: ModelToolExposure = {
        kind: "auto",
        mcp: {
          snapshotId: `conformance-${spec.id}-mainstream-schema`,
          tools: [
            {
              ...conformanceMcpTool,
              parameters: compilation.parameters,
            },
          ],
        },
      };

      // When
      await collect(
        provider.stream({
          systemPrompt: "You are Keel.",
          messages: [
            { role: "user", content: "conformance-mainstream-mcp-schema" },
          ],
          signal: freshSignal(),
          toolExposure: exposure,
        }),
      );

      // Then
      const body = requestBodies.get("conformance-mainstream-mcp-schema");
      expect(body).toBeDefined();
      const request = z
        .object({
          tools: z.array(
            z.object({
              function: z
                .object({
                  name: z.string(),
                  parameters: z.json(),
                })
                .passthrough(),
            }),
          ),
        })
        .passthrough()
        .parse(JSON.parse(body ?? ""));
      expect(
        request.tools.find(
          (tool) => tool.function.name === "mcp__catalog__search",
        )?.function.parameters,
      ).toEqual(compilation.parameters);
    });

    test.each(failureCases)(
      `Given the enrolled provider streams $label,
      When the shared OpenAI-compatible conformance harness reads the stream,
      Then the provider reports a protocol error`,
      async (row) => {
        // When / Then
        await expect(streamFor(provider, row.prompt)).rejects.toMatchObject({
          name: "KeelError",
          code: "provider_protocol_error",
          message: row.message(spec),
        });
      },
    );

    test.each(replaySuccessCases)(
      `Given the enrolled provider loses $label,
      When retry budget remains and no assistant output was emitted,
      Then the provider replays the request and emits one recovered stream`,
      async (row) => {
        // Given
        const retryingProvider = createProvider(
          spec,
          `http://127.0.0.1:${getPort(server)}`,
          {
            maxRetries: 1,
            initialDelayMs: 0,
            maxDelayMs: 0,
            jitterRatio: 0,
          },
        );

        // When
        const events = await streamFor(retryingProvider, row.prompt);

        // Then
        expect(events).toEqual(row.expectedEvents(spec));
        expect(requestCounts.get(row.prompt)).toBe(row.expectedRequests);
      },
    );

    test.each(replayFailureCases)(
      `Given the enrolled provider loses $label,
      When the stream already emitted assistant output,
      Then the provider does not replay partial output`,
      async (row) => {
        // Given
        const retryingProvider = createProvider(
          spec,
          `http://127.0.0.1:${getPort(server)}`,
          {
            maxRetries: 1,
            initialDelayMs: 0,
            maxDelayMs: 0,
            jitterRatio: 0,
          },
        );

        // When / Then
        await expect(
          streamFor(retryingProvider, row.prompt),
        ).rejects.toMatchObject({
          name: "KeelError",
          code: "provider_protocol_error",
          message: row.message(spec),
        });
        expect(requestCounts.get(row.prompt)).toBe(row.expectedRequests);
      },
    );
  });
}
