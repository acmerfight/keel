import type { ContextCompactionOptions } from "../agent/context-compaction.ts";
import type { CostModel } from "../core/cost.ts";
import {
  createDeepseekProvider,
  DEEPSEEK_V4_FLASH_COST_MODEL,
} from "../llm/providers/deepseek.ts";
import { createFakeProvider, fakeResponse } from "../llm/providers/fake.ts";
import {
  createKimiProvider,
  KIMI_K2_6_COST_MODEL,
} from "../llm/providers/kimi.ts";
import { createQwenProvider, qwenCostModel } from "../llm/providers/qwen.ts";
import type { LLMProvider } from "../llm/types.ts";
import type {
  InteractiveResolvedProvider,
  ProviderId,
} from "./interactive-session.ts";

interface CliEditRequest {
  readonly path: string;
  readonly oldString: string;
  readonly newString: string;
}

interface CliWriteRequest {
  readonly path: string;
  readonly content: string;
}

export interface ProviderConfigRuntime {
  readonly env: (key: string) => string | undefined;
}

type ResolvedProviderBase<
  Id extends ProviderId,
  Cost extends CostModel | null,
> = InteractiveResolvedProvider & {
  readonly providerId: Id;
  readonly costModel: Cost;
  readonly contextCompaction?: ContextCompactionOptions;
};

export type ResolvedProvider =
  | ResolvedProviderBase<"fake", CostModel>
  | ResolvedProviderBase<"deepseek", CostModel>
  | ResolvedProviderBase<"kimi", CostModel | null>
  | ResolvedProviderBase<"qwen", CostModel | null>;

export class ProviderConfigError extends Error {}

function providerConfigError(message: string): never {
  throw new ProviderConfigError(message);
}

function positiveIntegerEnv(
  runtime: ProviderConfigRuntime,
  key: string,
): number | undefined {
  const value = runtime.env(key);
  if (value === undefined || value === "") {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed <= 0 ||
    String(parsed) !== value
  ) {
    providerConfigError(`Error: ${key} must be a positive integer.`);
  }
  return parsed;
}

function defaultContextWindowTokens(
  providerId: ProviderId,
): number | undefined {
  if (providerId === "fake") {
    return undefined;
  }
  return 256_000;
}

function contextCompactionOptions(
  providerId: ProviderId,
  runtime: ProviderConfigRuntime,
): ContextCompactionOptions | undefined {
  const contextWindowTokens =
    positiveIntegerEnv(runtime, "KEEL_CONTEXT_WINDOW_TOKENS") ??
    defaultContextWindowTokens(providerId);
  return contextWindowTokens === undefined
    ? undefined
    : { contextWindowTokens };
}

function parseCliEditDemo(message: string): CliEditRequest | null {
  const prefix = "replace ";
  const withToken = " with ";
  const inToken = " in ";

  if (!message.startsWith(prefix)) return null;

  const body = message.slice(prefix.length);
  const withIndex = body.indexOf(withToken);
  if (withIndex < 0) return null;

  const newStringStart = withIndex + withToken.length;
  const inIndex = body.indexOf(inToken, newStringStart);
  if (inIndex < 0) return null;

  const oldString = body.slice(0, withIndex);
  const newString = body.slice(newStringStart, inIndex);
  const path = body.slice(inIndex + inToken.length);

  if (oldString === "" || newString === "" || path === "") return null;

  return { path, oldString, newString };
}

function parseCliWriteDemo(message: string): CliWriteRequest | null {
  const prefix = "create ";
  if (!message.startsWith(prefix)) return null;

  const path = message.slice(prefix.length);
  if (path === "") return null;

  return { path, content: '{"created":true}\n' };
}

const ZERO_USAGE = {
  inputTokens: 0,
  cachedInputTokens: 0,
  uncachedInputTokens: 0,
  outputTokens: 0,
};

const ZERO_COST_MODEL: CostModel = {
  uncachedInputPerMillionTokens: 0,
  cachedInputPerMillionTokens: 0,
  outputPerMillionTokens: 0,
};

function kimiCostModel(model: string): CostModel | null {
  if (model === "kimi-k2.6") return KIMI_K2_6_COST_MODEL;
  return null;
}

function createCliFakeProvider(userMessage: string): LLMProvider {
  const edit = parseCliEditDemo(userMessage);
  const write = parseCliWriteDemo(userMessage);
  if (edit === null) {
    if (write === null) {
      return createFakeProvider([fakeResponse("Hello from fake provider.")]);
    }

    let turn = 0;
    return {
      id: "fake",
      async *stream(options) {
        turn++;
        if (turn === 1) {
          yield {
            type: "tool_call",
            id: "fake_write",
            tool: "write",
            path: write.path,
            content: write.content,
          };
          yield { type: "stop", usage: ZERO_USAGE };
          return;
        }

        const toolContent = options.messages.findLast(
          (m) => m.role === "tool",
        )?.content;
        const reply = toolContent?.startsWith("Tool failed:")
          ? toolContent
          : `Created ${write.path}`;
        yield { type: "text", text: reply };
        yield { type: "stop", usage: ZERO_USAGE };
      },
    };
  }

  let turn = 0;
  return {
    id: "fake",
    async *stream(options) {
      turn++;
      if (turn === 1) {
        yield {
          type: "tool_call",
          id: "fake_edit",
          tool: "edit",
          path: edit.path,
          oldString: edit.oldString,
          newString: edit.newString,
        };
        yield { type: "stop", usage: ZERO_USAGE };
        return;
      }

      const toolContent = options.messages.findLast(
        (m) => m.role === "tool",
      )?.content;
      const reply = toolContent?.startsWith("Tool failed:")
        ? toolContent
        : `Edited ${edit.path}`;
      yield { type: "text", text: reply };
      yield { type: "stop", usage: ZERO_USAGE };
    },
  };
}

function createInteractiveFakeProvider(): LLMProvider {
  return {
    id: "fake",
    async *stream(options) {
      const userMessages = options.messages.filter(
        (message) => message.role === "user",
      );
      const latest = userMessages.at(-1)?.content ?? "";
      const previous = userMessages.at(-2)?.content;
      const text =
        previous !== undefined && latest.endsWith("remember?")
          ? `Earlier you said: ${previous}`
          : `Remembered: ${latest}`;
      yield { type: "text", text };
      yield { type: "stop", usage: ZERO_USAGE };
    },
  };
}

export function resolveProvider(
  userMessage: string,
  runtime: ProviderConfigRuntime,
): ResolvedProvider {
  const providerId = runtime.env("KEEL_PROVIDER") ?? "deepseek";

  if (providerId === "fake") {
    const contextCompaction = contextCompactionOptions("fake", runtime);
    return {
      providerId: "fake",
      provider: createCliFakeProvider(userMessage),
      model: "fake",
      costModel: ZERO_COST_MODEL,
      ...(contextCompaction !== undefined ? { contextCompaction } : {}),
    };
  }

  if (providerId === "deepseek") {
    const apiKey = runtime.env("DEEPSEEK_API_KEY");
    if (!apiKey) {
      providerConfigError(
        "Error: DEEPSEEK_API_KEY is required. Set the API key to use DeepSeek.",
      );
    }
    const model = "deepseek-v4-flash";
    const contextCompaction = contextCompactionOptions("deepseek", runtime);
    return {
      providerId: "deepseek",
      provider: createDeepseekProvider({
        apiKey,
        baseUrl: runtime.env("DEEPSEEK_BASE_URL") ?? "https://api.deepseek.com",
        model,
      }),
      model,
      costModel: DEEPSEEK_V4_FLASH_COST_MODEL,
      ...(contextCompaction !== undefined ? { contextCompaction } : {}),
    };
  }

  if (providerId === "kimi") {
    const apiKey = runtime.env("KIMI_API_KEY");
    if (!apiKey) {
      providerConfigError(
        "Error: KIMI_API_KEY is required. Set the API key to use Kimi.",
      );
    }
    const model = runtime.env("KIMI_MODEL") ?? "kimi-k2.6";
    const contextCompaction = contextCompactionOptions("kimi", runtime);
    return {
      providerId: "kimi",
      provider: createKimiProvider({
        apiKey,
        baseUrl: runtime.env("KIMI_BASE_URL") ?? "https://api.moonshot.cn/v1",
        model,
      }),
      model,
      costModel: kimiCostModel(model),
      ...(contextCompaction !== undefined ? { contextCompaction } : {}),
    };
  }

  if (providerId === "qwen") {
    const apiKey =
      runtime.env("DASHSCOPE_API_KEY") ?? runtime.env("QWEN_API_KEY");
    if (!apiKey) {
      providerConfigError(
        "Error: DASHSCOPE_API_KEY or QWEN_API_KEY is required. Qwen default endpoint is https://dashscope-intl.aliyuncs.com/compatible-mode/v1; set QWEN_BASE_URL if your key belongs to China region or a workspace-scoped DashScope endpoint.",
      );
    }
    const model = runtime.env("QWEN_MODEL") ?? "qwen3.7-max";
    const contextCompaction = contextCompactionOptions("qwen", runtime);
    return {
      providerId: "qwen",
      provider: createQwenProvider({
        apiKey,
        baseUrl:
          runtime.env("QWEN_BASE_URL") ??
          "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
        model,
      }),
      model,
      costModel: qwenCostModel(model),
      ...(contextCompaction !== undefined ? { contextCompaction } : {}),
    };
  }

  providerConfigError(`Error: unknown provider "${providerId}"`);
}

export function resolveInteractiveProvider(
  userMessage: string,
  runtime: ProviderConfigRuntime,
): ResolvedProvider {
  const providerId = runtime.env("KEEL_PROVIDER") ?? "deepseek";
  if (providerId === "fake") {
    return {
      providerId: "fake",
      provider: createInteractiveFakeProvider(),
      model: "fake",
      costModel: ZERO_COST_MODEL,
    };
  }

  return resolveProvider(userMessage, runtime);
}

export function requireKnownCostModel(resolved: ResolvedProvider): CostModel {
  switch (resolved.providerId) {
    case "fake":
    case "deepseek":
      return resolved.costModel;
    case "kimi":
      if (resolved.costModel !== null) return resolved.costModel;
      return providerConfigError(
        `Error: cost tracking is only supported for Kimi model "kimi-k2.6"; configured KIMI_MODEL="${resolved.model}".`,
      );
    case "qwen":
      if (resolved.costModel !== null) return resolved.costModel;
      return providerConfigError(
        `Error: cost tracking is only supported for Qwen model "qwen3.7-max"; configured QWEN_MODEL="${resolved.model}".`,
      );
  }
}
