import type { ContextCompactionOptions } from "../agent/context-compaction.ts";
import type { CostModel } from "../core/cost.ts";
import {
  createDeepseekProvider,
  deepseekCostModel,
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

export interface ProviderSelection {
  readonly providerId?: ProviderId;
  readonly model?: string;
}

type ModelSource =
  | "--model"
  | "DEEPSEEK_MODEL"
  | "KIMI_MODEL"
  | "QWEN_MODEL"
  | "default";

type ResolvedProviderBase<
  Id extends ProviderId,
  Cost extends CostModel | null,
> = InteractiveResolvedProvider & {
  readonly providerId: Id;
  readonly costModel: Cost;
  readonly contextCompaction?: ContextCompactionOptions;
  readonly modelSource?: ModelSource;
};

export type ResolvedProvider =
  | ResolvedProviderBase<"fake", CostModel>
  | ResolvedProviderBase<"deepseek", CostModel | null>
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

function fakeContextCompactionOptions(
  runtime: ProviderConfigRuntime,
): ContextCompactionOptions | undefined {
  const contextWindowTokens = positiveIntegerEnv(
    runtime,
    "KEEL_CONTEXT_WINDOW_TOKENS",
  );
  return contextWindowTokens === undefined
    ? undefined
    : { contextWindowTokens };
}

function realContextCompactionOptions(
  runtime: ProviderConfigRuntime,
): ContextCompactionOptions {
  return {
    contextWindowTokens:
      positiveIntegerEnv(runtime, "KEEL_CONTEXT_WINDOW_TOKENS") ?? 256_000,
  };
}

function isProviderId(value: string): value is ProviderId {
  return (
    value === "fake" ||
    value === "deepseek" ||
    value === "kimi" ||
    value === "qwen"
  );
}

function selectedProviderId(
  runtime: ProviderConfigRuntime,
  selection: ProviderSelection | undefined,
): ProviderId {
  if (selection?.providerId !== undefined) {
    return selection.providerId;
  }
  const providerId = runtime.env("KEEL_PROVIDER") ?? "deepseek";
  if (isProviderId(providerId)) {
    return providerId;
  }
  providerConfigError(`Error: unknown provider "${providerId}"`);
}

function selectedModel(
  runtime: ProviderConfigRuntime,
  selection: ProviderSelection | undefined,
  envKey: Exclude<ModelSource, "--model" | "default">,
  defaultModel: string,
): { readonly model: string; readonly source: ModelSource } {
  if (selection?.model !== undefined) {
    return { model: selection.model, source: "--model" };
  }
  const envModel = runtime.env(envKey);
  if (envModel !== undefined) {
    return { model: envModel, source: envKey };
  }
  return { model: defaultModel, source: "default" };
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
  type: "fixed",
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
  selection?: ProviderSelection,
): ResolvedProvider {
  const providerId = selectedProviderId(runtime, selection);

  switch (providerId) {
    case "fake": {
      const contextCompaction = fakeContextCompactionOptions(runtime);
      return {
        providerId: "fake",
        provider: createCliFakeProvider(userMessage),
        model: "fake",
        costModel: ZERO_COST_MODEL,
        ...(contextCompaction !== undefined ? { contextCompaction } : {}),
      };
    }

    case "deepseek": {
      const apiKey = runtime.env("DEEPSEEK_API_KEY");
      if (!apiKey) {
        providerConfigError(
          "Error: DEEPSEEK_API_KEY is required. Set the API key to use DeepSeek.",
        );
      }
      const selected = selectedModel(
        runtime,
        selection,
        "DEEPSEEK_MODEL",
        "deepseek-v4-flash",
      );
      const contextCompaction = realContextCompactionOptions(runtime);
      return {
        providerId: "deepseek",
        provider: createDeepseekProvider({
          apiKey,
          baseUrl:
            runtime.env("DEEPSEEK_BASE_URL") ?? "https://api.deepseek.com",
          model: selected.model,
        }),
        model: selected.model,
        costModel: deepseekCostModel(selected.model),
        modelSource: selected.source,
        contextCompaction,
      };
    }

    case "kimi": {
      const apiKey = runtime.env("KIMI_API_KEY");
      if (!apiKey) {
        providerConfigError(
          "Error: KIMI_API_KEY is required. Set the API key to use Kimi.",
        );
      }
      const selected = selectedModel(
        runtime,
        selection,
        "KIMI_MODEL",
        "kimi-k2.6",
      );
      const contextCompaction = realContextCompactionOptions(runtime);
      return {
        providerId: "kimi",
        provider: createKimiProvider({
          apiKey,
          baseUrl: runtime.env("KIMI_BASE_URL") ?? "https://api.moonshot.cn/v1",
          model: selected.model,
        }),
        model: selected.model,
        costModel: kimiCostModel(selected.model),
        modelSource: selected.source,
        contextCompaction,
      };
    }

    case "qwen": {
      const apiKey =
        runtime.env("DASHSCOPE_API_KEY") ?? runtime.env("QWEN_API_KEY");
      if (!apiKey) {
        providerConfigError(
          "Error: DASHSCOPE_API_KEY or QWEN_API_KEY is required. Qwen default endpoint is https://dashscope-intl.aliyuncs.com/compatible-mode/v1; set QWEN_BASE_URL if your key belongs to China region or a workspace-scoped DashScope endpoint.",
        );
      }
      const selected = selectedModel(
        runtime,
        selection,
        "QWEN_MODEL",
        "qwen3.7-max",
      );
      const contextCompaction = realContextCompactionOptions(runtime);
      return {
        providerId: "qwen",
        provider: createQwenProvider({
          apiKey,
          baseUrl:
            runtime.env("QWEN_BASE_URL") ??
            "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
          model: selected.model,
        }),
        model: selected.model,
        costModel: qwenCostModel(selected.model),
        modelSource: selected.source,
        contextCompaction,
      };
    }
  }
}

export function resolveInteractiveProvider(
  userMessage: string,
  runtime: ProviderConfigRuntime,
  selection?: ProviderSelection,
): ResolvedProvider {
  const providerId = selectedProviderId(runtime, selection);
  if (providerId === "fake") {
    const contextCompaction = fakeContextCompactionOptions(runtime);
    return {
      providerId: "fake",
      provider: createInteractiveFakeProvider(),
      model: "fake",
      costModel: ZERO_COST_MODEL,
      ...(contextCompaction !== undefined ? { contextCompaction } : {}),
    };
  }

  return resolveProvider(userMessage, runtime, selection);
}

function configuredModelLabel(
  resolved: ResolvedProvider,
  fallbackEnvKey: Exclude<ModelSource, "--model" | "default">,
): string {
  if (resolved.modelSource === "default") {
    return `default model "${resolved.model}"`;
  }
  const source =
    resolved.modelSource === "--model" ? "--model" : fallbackEnvKey;
  return `configured ${source}="${resolved.model}"`;
}

export function requireKnownCostModel(resolved: ResolvedProvider): CostModel {
  switch (resolved.providerId) {
    case "fake":
      return resolved.costModel;
    case "deepseek":
      if (resolved.costModel !== null) return resolved.costModel;
      return providerConfigError(
        `Error: cost tracking is only supported for known DeepSeek model pricing; ${configuredModelLabel(resolved, "DEEPSEEK_MODEL")}.`,
      );
    case "kimi":
      if (resolved.costModel !== null) return resolved.costModel;
      return providerConfigError(
        `Error: cost tracking is only supported for Kimi model "kimi-k2.6"; ${configuredModelLabel(resolved, "KIMI_MODEL")}.`,
      );
    case "qwen":
      if (resolved.costModel !== null) return resolved.costModel;
      return providerConfigError(
        `Error: cost tracking is only supported for known Qwen model pricing; ${configuredModelLabel(resolved, "QWEN_MODEL")}.`,
      );
  }
}
