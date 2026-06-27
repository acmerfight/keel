import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { expect } from "vitest";
import type { ContextCompactionOptions } from "../agent/context-compaction.ts";
import type { AgentEvent } from "../agent/events.ts";
import type { InteractiveResolvedProvider } from "../cli/interactive-session/types.ts";
import { runInteractiveSession } from "../cli/interactive-session.ts";
import type { CostModel } from "../core/cost.ts";
import type { ModelMetadata } from "../core/model-metadata.ts";
import type { ProviderId } from "../core/provider-id.ts";
import type { LLMProvider, Usage } from "../llm/types.ts";

export const ZERO_USAGE: Usage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  uncachedInputTokens: 0,
  outputTokens: 0,
};

export const ZERO_COST_MODEL: CostModel = {
  type: "fixed",
  uncachedInputPerMillionTokens: 0,
  cachedInputPerMillionTokens: 0,
  outputPerMillionTokens: 0,
};

const TEST_MODEL_METADATA: ModelMetadata = {
  status: "known",
  source: "registry",
  contextWindowTokens: null,
  maxOutputTokens: null,
  capabilities: {
    textInput: true,
    toolCalls: true,
    reasoning: false,
  },
  costModel: ZERO_COST_MODEL,
  lastVerified: "2026-06-26",
};

export const EXPENSIVE_USAGE: Usage = {
  inputTokens: 2_000_000,
  cachedInputTokens: 0,
  uncachedInputTokens: 2_000_000,
  outputTokens: 0,
};

export const ONE_DOLLAR_PER_MILLION_INPUT: CostModel = {
  type: "fixed",
  uncachedInputPerMillionTokens: 1,
  cachedInputPerMillionTokens: 0,
  outputPerMillionTokens: 0,
};

export class ForcedExit extends Error {
  readonly code: number;

  constructor(code: number) {
    super(`forced exit ${code}`);
    this.code = code;
  }
}

export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);

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

export function textProvider(text: string): LLMProvider {
  return {
    id: "fake",
    async *stream() {
      yield { type: "text", text };
      yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
    },
  };
}

export function resolvedProvider(
  providerId: ProviderId,
  model: string,
  provider: LLMProvider,
  costModel: CostModel | null = ZERO_COST_MODEL,
  contextCompaction?: ContextCompactionOptions,
  modelMetadata: InteractiveResolvedProvider["modelMetadata"] = TEST_MODEL_METADATA,
): InteractiveResolvedProvider {
  switch (providerId) {
    case "fake":
      return {
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
        modelMetadata,
        ...(contextCompaction !== undefined ? { contextCompaction } : {}),
      };
    case "deepseek":
      return {
        provider,
        providerId: "deepseek",
        model,
        costModel,
        modelMetadata,
        ...(contextCompaction !== undefined ? { contextCompaction } : {}),
      };
    case "kimi":
      return {
        provider,
        providerId: "kimi",
        model,
        costModel,
        modelMetadata,
        ...(contextCompaction !== undefined ? { contextCompaction } : {}),
      };
    case "qwen":
      return {
        provider,
        providerId: "qwen",
        model,
        costModel,
        modelMetadata,
        ...(contextCompaction !== undefined ? { contextCompaction } : {}),
      };
  }
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function expectInterruptedTurnPreservesVisibleScopedInstructions(
  abortOutcome: "stop" | "throw",
): Promise<void> {
  const workspace = await mkdtemp(
    join(tmpdir(), "keel-interactive-scoped-previsible-abort-"),
  );
  await mkdir(join(workspace, "packages", "api", "src"), {
    recursive: true,
  });
  await writeFile(
    join(workspace, "packages", "api", "AGENTS.md"),
    "API rule: pre-visible instructions survive abort rollback.\n",
    "utf8",
  );
  const targetPath = join(workspace, "packages", "api", "src", "new.ts");
  let request = 0;
  let cancelSeen: () => void = () => {};
  const cancelReceived = new Promise<void>((resolve) => {
    cancelSeen = resolve;
  });
  const provider: LLMProvider = {
    id: "fake",
    async *stream(options) {
      request++;
      if (request === 1) {
        yield {
          type: "tool_call",
          id: "review_scoped_instructions",
          tool: "write",
          path: "packages/api/src/new.ts",
          content: "export const value = 1;\n",
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
        return;
      }
      if (request === 2) {
        yield { type: "text", text: "Reviewed" };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
        return;
      }
      if (request === 3) {
        yield { type: "text", text: "Cancel me" };
        if (!options.signal.aborted) {
          await new Promise<void>((resolve) => {
            options.signal.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
        }
        if (abortOutcome === "throw") {
          throw new Error("provider ignored abort before throwing");
        }
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
        return;
      }
      if (request === 4) {
        yield {
          type: "tool_call",
          id: "retry_scoped_write",
          tool: "write",
          path: "packages/api/src/new.ts",
          content: "export const value = 1;\n",
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
        return;
      }
      yield { type: "text", text: "Created" };
      yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
    },
  };
  const input = new PassThrough();
  const sigintHandlers = new Set<() => void>();
  let stdout = "";
  const session = runInteractiveSession({
    cliArgs: { bashMode: "disabled" },
    workspace,
    platform: process.platform,
    input,
    writeStdout: (text) => {
      stdout += text;
    },
    writeStderr: () => {},
    onSigint: (handler) => {
      sigintHandlers.add(handler);
    },
    offSigint: (handler) => {
      sigintHandlers.delete(handler);
    },
    setExitCode: () => {},
    forceExit: (code) => {
      throw new ForcedExit(code);
    },
    resolveProvider: () => ({
      provider,
      providerId: "fake",
      model: "fake",
      costModel: ZERO_COST_MODEL,
    }),
    requireKnownCostModel: () => ZERO_COST_MODEL,
    printAgentEvents: async (stream) => {
      let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
      for await (const event of stream) {
        if (event.type === "text") {
          stdout += event.text;
          if (event.text === "Cancel me") {
            cancelSeen();
            for (const handler of [...sigintHandlers]) {
              handler();
            }
            input.write("retry create\n");
          }
          if (event.text === "Created") {
            input.end();
          }
        } else if (event.type === "end") {
          finalEnd = event;
        }
      }
      return finalEnd;
    },
    formatCostReport: () => "",
  });

  try {
    input.write("review scoped instructions\n");
    input.write("cancel next turn\n");
    await withTimeout(cancelReceived, 5000, "interrupted turn did not run");
    await withTimeout(session, 5000, "session did not finish");

    expect(await readFile(targetPath, "utf8")).toBe(
      "export const value = 1;\n",
    );
    expect(stdout).toContain("Reviewed");
    expect(stdout).toContain("Cancel me");
    expect(stdout).toContain("Created");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
