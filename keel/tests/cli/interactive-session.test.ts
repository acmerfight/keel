import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { describe, expect, test } from "vitest";
import type { ContextCompactionOptions } from "../../src/agent/context-compaction.ts";
import type { AgentEvent } from "../../src/agent/loop.ts";
import { createReadVisibilityState } from "../../src/agent/read-visibility.ts";
import { parseInteractiveCommand } from "../../src/cli/interactive-session/commands.ts";
import { executeModelSwitchCompaction } from "../../src/cli/interactive-session/model-switch-compact.ts";
import type {
  InteractiveResolvedProvider,
  ProviderSelection,
} from "../../src/cli/interactive-session/types.ts";
import { runInteractiveSession } from "../../src/cli/interactive-session.ts";
import {
  createSessionStore,
  persistSessionBashApprovalGrant,
  persistSessionMessages,
  persistSessionQueuedInput,
  resumeSessionStore,
  type SessionQueuedInput,
} from "../../src/cli/session-store.ts";
import type { CostModel } from "../../src/core/cost.ts";
import { recordLastEditCheckpoint } from "../../src/core/git.ts";
import type { ModelMetadata } from "../../src/core/model-metadata.ts";
import type { ProviderId } from "../../src/core/provider-id.ts";
import {
  createFakeProvider,
  fakeResponse,
  fakeToolResponse,
} from "../../src/llm/providers/fake.ts";
import type { LLMProvider, Message, Usage } from "../../src/llm/types.ts";
import {
  commitFile,
  createGitWorkspace,
} from "../../src/testing/cli-harness.ts";
import { createProjectInstructionVisibilityState } from "../../src/tools/scoped-project-instructions.ts";

const ZERO_USAGE: Usage = {
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
};

const EXPENSIVE_USAGE: Usage = {
  inputTokens: 2_000_000,
  cachedInputTokens: 0,
  uncachedInputTokens: 2_000_000,
  outputTokens: 0,
};

const ONE_DOLLAR_PER_MILLION_INPUT: CostModel = {
  type: "fixed",
  uncachedInputPerMillionTokens: 1,
  cachedInputPerMillionTokens: 0,
  outputPerMillionTokens: 0,
};

class ForcedExit extends Error {
  readonly code: number;

  constructor(code: number) {
    super(`forced exit ${code}`);
    this.code = code;
  }
}

function withTimeout<T>(
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

function textProvider(text: string): LLMProvider {
  return {
    id: "fake",
    async *stream() {
      yield { type: "text", text };
      yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
    },
  };
}

function resolvedProvider(
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

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath);
    return true;
  } catch {
    return false;
  }
}

async function expectInterruptedTurnPreservesVisibleScopedInstructions(
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

describe("Interactive Session", () => {
  test(`Given the interactive session is idle,
    When user interrupts,
    Then the session exits as interrupted`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let exitCode: number | undefined;
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
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
      setExitCode: (code) => {
        exitCode = code;
      },
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => {
        throw new Error("idle interrupt should not resolve a provider");
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => undefined,
      formatCostReport: () => "",
    });

    // When
    for (const handler of [...sigintHandlers]) {
      handler();
    }

    // Then
    await session;
    expect(stdout).toBe("\n");
    expect(exitCode).toBe(130);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given the interactive session is idle,
    When user enters /help,
    Then help is printed without starting a model turn`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    let providerResolved = false;
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
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
      resolveProvider: () => {
        providerResolved = true;
        throw new Error("help should not resolve a provider");
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => {
        throw new Error("help should not start a model turn");
      },
      formatCostReport: () => "",
    });

    // When
    input.end("/help\n");

    // Then
    await session;
    expect(stdout).toContain("Interactive commands:");
    expect(stdout).toContain("/help");
    expect(stdout).toContain("/undo");
    expect(stdout).toContain("/compact [focus]");
    expect(stdout).toContain("keel sessions");
    expect(stdout).toContain("keel sessions fork");
    expect(stderr).toBe("");
    expect(providerResolved).toBe(false);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given user enters /model command variants,
    When the interactive parser handles valid and invalid model selections,
    Then it accepts supported provider/model targets and rejects malformed input`, () => {
    // Given / When / Then
    expect(parseInteractiveCommand("/model deepseek/deepseek-v4")).toEqual({
      kind: "model",
      selection: { providerId: "deepseek", model: "deepseek-v4" },
    });
    expect(parseInteractiveCommand("/model qwen/qwen3.7 plus")).toEqual({
      kind: "invalid",
      message: "Error: usage is /model <provider>/<model>.",
    });
    expect(parseInteractiveCommand("/model /qwen3.7-plus")).toEqual({
      kind: "invalid",
      message: "Error: usage is /model <provider>/<model>.",
    });
    expect(parseInteractiveCommand("/model qwen/")).toEqual({
      kind: "invalid",
      message: "Error: usage is /model <provider>/<model>.",
    });
    expect(parseInteractiveCommand("/model anthropic/claude")).toEqual({
      kind: "invalid",
      message: 'Error: unknown provider "anthropic".',
    });
  });

  test(`Given user enters malformed /model commands,
    When the interactive session handles those local commands,
    Then it reports usage errors without starting a provider turn`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    let providerResolved = false;
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
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
      resolveProvider: () => {
        providerResolved = true;
        throw new Error("malformed /model should not resolve a provider");
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => {
        throw new Error("malformed /model should not start a model turn");
      },
      formatCostReport: () => "",
    });

    // When
    input.end(
      "/model qwen/qwen3.7 plus\n/model /qwen3.7-plus\n/model qwen/\n/model anthropic/claude\n",
    );

    // Then
    await session;
    expect(stderr).toContain("Error: usage is /model <provider>/<model>.");
    expect(stderr).toContain('Error: unknown provider "anthropic".');
    expect(stdout).toBe("");
    expect(providerResolved).toBe(false);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given no prompt has run,
    When user selects a model with /model before the first prompt,
    Then the first provider request uses the selected provider and model`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    const resolvedSelections: ProviderSelection[] = [];
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
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
      resolveProvider: (_message, selection?: ProviderSelection) => {
        if (selection !== undefined) {
          resolvedSelections.push(selection);
        }
        const providerId = selection?.providerId ?? "fake";
        const model = selection?.model ?? "fake";
        return resolvedProvider(
          providerId,
          model,
          textProvider(`${providerId}:${model}`),
        );
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    // When
    input.end("/model qwen/qwen3.7-plus\nfirst prompt\n");

    // Then
    await session;
    expect(stdout).toContain("qwen:qwen3.7-plus");
    expect(resolvedSelections).toEqual([
      { providerId: "qwen", model: "qwen3.7-plus" },
    ]);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given an interactive session already used one model,
    When user selects another model with /model,
    Then the next prompt uses the selected provider and the command stays local`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    const observedProviderVisibleContent: string[] = [];
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
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
      resolveProvider: (_message, selection?: ProviderSelection) => {
        const providerId = selection?.providerId ?? "fake";
        const model = selection?.model ?? "fake";
        const provider: LLMProvider = {
          id: "fake",
          async *stream(options) {
            observedProviderVisibleContent.push(
              JSON.stringify(options.messages),
            );
            yield { type: "text", text: `${providerId}:${model}` };
            yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          },
        };
        return resolvedProvider(providerId, model, provider);
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    // When
    input.end("first prompt\n/model qwen/qwen3.7-max\nsecond prompt\n");

    // Then
    await session;
    expect(stdout).toContain("fake:fake");
    expect(stdout).toContain("qwen:qwen3.7-max");
    expect(observedProviderVisibleContent).toHaveLength(2);
    expect(observedProviderVisibleContent[1]).not.toContain("/model");
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given an interactive session already has history,
    When user selects an uncatalogued real model without a context override,
    Then Keel rejects the switch and keeps the previous model active`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    let oldProviderTurns = 0;
    let targetProviderTurns = 0;
    const oldProvider: LLMProvider = {
      id: "fake",
      async *stream() {
        oldProviderTurns++;
        yield { type: "text", text: `old provider ${oldProviderTurns}` };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const targetProvider: LLMProvider = {
      id: "fake",
      async *stream() {
        targetProviderTurns++;
        yield { type: "text", text: "unexpected unknown target" };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
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
      resolveProvider: (_message, selection?: ProviderSelection) => {
        if (selection?.providerId === "qwen") {
          return {
            provider: targetProvider,
            providerId: "qwen",
            model: selection.model ?? "qwen-future",
            costModel: null,
          };
        }
        return resolvedProvider("fake", "fake", oldProvider);
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    // When
    input.end("first prompt\n/model qwen/qwen-future\nsecond prompt\n");

    // Then
    await session;
    expect(stderr).toContain(
      "Error: cannot switch to qwen/qwen-future because model metadata is unavailable; set KEEL_CONTEXT_WINDOW_TOKENS to configure the target context window.",
    );
    expect(stdout).toContain("old provider 1");
    expect(stdout).toContain("old provider 2");
    expect(stdout).not.toContain("unexpected unknown target");
    expect(oldProviderTurns).toBe(2);
    expect(targetProviderTurns).toBe(0);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given an interactive session already has history,
    When user selects an uncatalogued real model with a context override,
    Then Keel accepts the switch and uses the target model`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    let targetProviderTurns = 0;
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
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
      resolveProvider: (_message, selection?: ProviderSelection) => {
        if (selection?.providerId === "qwen") {
          return resolvedProvider(
            "qwen",
            selection.model ?? "qwen-future",
            {
              id: "fake",
              async *stream() {
                targetProviderTurns++;
                yield { type: "text", text: "target accepted" };
                yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
              },
            },
            ZERO_COST_MODEL,
            { contextWindowTokens: 100_000 },
            { status: "unknown" },
          );
        }
        return resolvedProvider("fake", "fake", textProvider("old provider"));
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    // When
    input.end("first prompt\n/model qwen/qwen-future\nsecond prompt\n");

    // Then
    await session;
    expect(stderr).toBe("");
    expect(stdout).toContain("old provider");
    expect(stdout).toContain("Model switched to qwen/qwen-future");
    expect(stdout).toContain("target accepted");
    expect(targetProviderTurns).toBe(1);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given the interactive session is idle,
    When user enters /model without arguments,
    Then the current model is printed without starting a model turn`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    let providerStreams = 0;
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
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
      resolveProvider: () =>
        resolvedProvider("fake", "fake", {
          id: "fake",
          async *stream() {
            providerStreams++;
            yield { type: "text", text: "unexpected" };
            yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          },
        }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => {
        throw new Error("/model should not start a model turn");
      },
      formatCostReport: () => "",
    });

    // When
    input.end("/model\n");

    // Then
    await session;
    expect(stdout).toContain("Current model: fake/fake");
    expect(stdout).toContain("Usage: /model <provider>/<model>");
    expect(stderr).toBe("");
    expect(providerStreams).toBe(0);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given interactive cost tracking is enabled,
    When user selects a model with unknown pricing,
    Then the switch fails before mutating the active model`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    let fakeTurns = 0;
    const fakeProvider: LLMProvider = {
      id: "fake",
      async *stream() {
        fakeTurns++;
        yield { type: "text", text: `fake reply ${fakeTurns}` };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled", maxCostUsd: 1 },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
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
      resolveProvider: (_message, selection?: ProviderSelection) => {
        if (selection?.providerId === "kimi") {
          return resolvedProvider(
            "kimi",
            selection.model ?? "kimi-k2.5",
            textProvider("unexpected kimi"),
            null,
          );
        }
        return resolvedProvider("fake", "fake", fakeProvider);
      },
      requireKnownCostModel: (resolved) => {
        if (resolved.costModel === null) {
          throw new Error("unknown target pricing");
        }
        return resolved.costModel;
      },
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    // When
    input.end("first prompt\n/model kimi/kimi-k2.5\nsecond prompt\n");

    // Then
    await session;
    expect(stderr).toContain("unknown target pricing");
    expect(stdout).toContain("fake reply 1");
    expect(stdout).toContain("fake reply 2");
    expect(stdout).not.toContain("unexpected kimi");
    expect(fakeTurns).toBe(2);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given the selected model is already active,
    When user enters /model for that same model,
    Then the command is a no-op and does not add provider-visible history`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let resolveCalls = 0;
    const observedProviderVisibleContent: string[] = [];
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        observedProviderVisibleContent.push(JSON.stringify(options.messages));
        yield {
          type: "text",
          text: `turn ${observedProviderVisibleContent.length}`,
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
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
      resolveProvider: () => {
        resolveCalls++;
        return resolvedProvider("fake", "fake", provider);
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    // When
    input.end("first prompt\n/model fake/fake\nsecond prompt\n");

    // Then
    await session;
    expect(stdout).toContain("Model already set to fake/fake");
    expect(resolveCalls).toBe(1);
    expect(observedProviderVisibleContent).toHaveLength(2);
    expect(observedProviderVisibleContent[1]).not.toContain("/model");
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given a resumed interactive session has an active model,
    When user selects the same model before another prompt,
    Then Keel reports the model is already active without persisting a switch`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    const resolvedSelections: ProviderSelection[] = [];
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      initialModelSelection: { providerId: "qwen", model: "qwen3.7-plus" },
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
      resolveProvider: (_message, selection?: ProviderSelection) => {
        if (selection !== undefined) {
          resolvedSelections.push(selection);
        }
        return resolvedProvider(
          selection?.providerId ?? "fake",
          selection?.model ?? "fake",
          textProvider("unexpected turn"),
        );
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      persistModelSwitch: () => {
        throw new Error("same model should not persist a switch");
      },
      printAgentEvents: async () => {
        throw new Error("same model command should not start a turn");
      },
      formatCostReport: () => "",
    });

    // When
    input.end("/model qwen/qwen3.7-plus\n");

    // Then
    await session;
    expect(stdout).toBe("Model already set to qwen/qwen3.7-plus\n");
    expect(resolvedSelections).toEqual([
      { providerId: "qwen", model: "qwen3.7-plus" },
    ]);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given a named session has queued model-switch input before the first prompt,
    When user selects a model before any turn,
    Then Keel persists a switch from no previous model and consumes the command`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    const switches: Array<{
      readonly from: {
        readonly providerId: string;
        readonly model: string;
      } | null;
      readonly to: { readonly providerId: string; readonly model: string };
      readonly consumedInputIds: readonly string[];
    }> = [];
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      initialQueuedInputs: [
        {
          id: "model-input",
          timestamp: "2026-01-01T00:00:00.000Z",
          sequence: 1,
          line: "/model qwen/qwen3.7-plus",
        },
        {
          id: "prompt-input",
          timestamp: "2026-01-01T00:00:01.000Z",
          sequence: 2,
          line: "first prompt",
        },
      ],
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
      resolveProvider: (_message, selection?: ProviderSelection) =>
        resolvedProvider(
          selection?.providerId ?? "fake",
          selection?.model ?? "fake",
          textProvider(
            `${selection?.providerId ?? "fake"}:${selection?.model ?? "fake"}`,
          ),
        ),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      persistModelSwitch: (switchRecord) => {
        switches.push(switchRecord);
      },
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    // When
    input.end();

    // Then
    await session;
    expect(stdout).toContain("Model switched to qwen/qwen3.7-plus\n");
    expect(stdout).toContain("qwen:qwen3.7-plus");
    expect(switches).toEqual([
      {
        from: null,
        to: { providerId: "qwen", model: "qwen3.7-plus" },
        consumedInputIds: ["model-input"],
      },
    ]);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given the current history does not fit a selected target context window,
    When user enters /model for that target,
    Then Keel compacts with the old provider before accepting the switch`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    let oldProviderTurns = 0;
    let oldProviderSummaryRequests = 0;
    let targetProviderTurns = 0;
    let targetProviderSummaryRequests = 0;
    const targetRequestContexts: Message[][] = [];
    const largePrompt = "large history ".repeat(3_000).trim();
    const oldProvider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        if (options.toolChoice === "none") {
          oldProviderSummaryRequests++;
          yield { type: "text", text: "Downshift checkpoint summary." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        oldProviderTurns++;
        yield { type: "text", text: `old provider ${oldProviderTurns}` };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const targetProvider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        if (options.toolChoice === "none") {
          targetProviderSummaryRequests++;
          yield { type: "text", text: "unexpected target summary" };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        targetProviderTurns++;
        targetRequestContexts.push(structuredClone([...options.messages]));
        yield { type: "text", text: `target provider ${targetProviderTurns}` };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
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
      resolveProvider: (_message, selection?: ProviderSelection) => {
        if (selection?.providerId === "qwen") {
          return resolvedProvider(
            "qwen",
            selection.model ?? "tiny",
            targetProvider,
            ZERO_COST_MODEL,
            {
              contextWindowTokens: 2_000,
              reserveTokens: 0,
              keepRecentTokens: 1,
            },
          );
        }
        return resolvedProvider("fake", "fake", oldProvider);
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    // When
    input.end(`${largePrompt}\n/model qwen/tiny\nsecond prompt\n`);

    // Then
    await session;
    expect(stderr).toContain("Context compacted: model switch");
    expect(stdout).toContain("Model switched to qwen/tiny");
    expect(stdout).toContain("old provider 1");
    expect(stdout).toContain("target provider 1");
    expect(oldProviderTurns).toBe(1);
    expect(oldProviderSummaryRequests).toBe(1);
    expect(targetProviderTurns).toBe(1);
    expect(targetProviderSummaryRequests).toBe(0);
    expect(targetRequestContexts).toHaveLength(1);
    expect(targetRequestContexts[0]).toEqual([
      {
        role: "user",
        content: expect.stringContaining("<conversation-checkpoint>"),
      },
      { role: "user", content: "second prompt" },
    ]);
    expect(targetRequestContexts[0]?.[0]?.content).toContain(
      "Downshift checkpoint summary.",
    );
    expect(JSON.stringify(targetRequestContexts[0])).not.toContain("/model");
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given model-switch compaction fails,
    When user enters /model for a smaller target,
    Then the old provider remains active and the transcript is unchanged`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    let oldProviderTurns = 0;
    let oldProviderSummaryRequests = 0;
    let targetProviderTurns = 0;
    const oldRequestContexts: Message[][] = [];
    const largePrompt = "large history ".repeat(3_000).trim();
    const oldProvider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        if (options.toolChoice === "none") {
          oldProviderSummaryRequests++;
          throw new Error("summary model unavailable");
        }
        oldProviderTurns++;
        oldRequestContexts.push(structuredClone([...options.messages]));
        yield { type: "text", text: `old provider ${oldProviderTurns}` };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const targetProvider: LLMProvider = {
      id: "fake",
      async *stream() {
        targetProviderTurns++;
        yield { type: "text", text: "unexpected target" };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
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
      resolveProvider: (_message, selection?: ProviderSelection) => {
        if (selection?.providerId === "qwen") {
          return resolvedProvider(
            "qwen",
            selection.model ?? "tiny",
            targetProvider,
            ZERO_COST_MODEL,
            {
              contextWindowTokens: 2_000,
              reserveTokens: 0,
              keepRecentTokens: 1,
            },
          );
        }
        return resolvedProvider("fake", "fake", oldProvider);
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    // When
    input.end(`${largePrompt}\n/model qwen/tiny\nsecond prompt\n`);

    // Then
    await session;
    expect(stderr).toContain(
      "Context compaction failed: summary model unavailable",
    );
    expect(stdout).toContain("old provider 1");
    expect(stdout).toContain("old provider 2");
    expect(stdout).not.toContain("unexpected target");
    expect(oldProviderTurns).toBe(2);
    expect(oldProviderSummaryRequests).toBe(1);
    expect(targetProviderTurns).toBe(0);
    expect(oldRequestContexts).toHaveLength(2);
    expect(oldRequestContexts[1]).toEqual([
      { role: "user", content: largePrompt },
      { role: "assistant", content: "old provider 1", toolCalls: [] },
      { role: "user", content: "second prompt" },
    ]);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given model-switch compaction still exceeds the target context window,
    When user enters /model for that target,
    Then the switch is rejected and the old provider remains active`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    let oldProviderTurns = 0;
    let oldProviderSummaryRequests = 0;
    let targetProviderTurns = 0;
    const oldRequestContexts: Message[][] = [];
    const largePrompt = "large history ".repeat(3_000).trim();
    const oldProvider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        if (options.toolChoice === "none") {
          oldProviderSummaryRequests++;
          yield { type: "text", text: "Still too large summary." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        oldProviderTurns++;
        oldRequestContexts.push(structuredClone([...options.messages]));
        yield { type: "text", text: `old provider ${oldProviderTurns}` };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const targetProvider: LLMProvider = {
      id: "fake",
      async *stream() {
        targetProviderTurns++;
        yield { type: "text", text: "unexpected target" };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
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
      resolveProvider: (_message, selection?: ProviderSelection) => {
        if (selection?.providerId === "qwen") {
          return resolvedProvider(
            "qwen",
            selection.model ?? "tiny",
            targetProvider,
            ZERO_COST_MODEL,
            { contextWindowTokens: 1, reserveTokens: 0, keepRecentTokens: 1 },
          );
        }
        return resolvedProvider("fake", "fake", oldProvider);
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    // When
    input.end(`${largePrompt}\n/model qwen/tiny\nsecond prompt\n`);

    // Then
    await session;
    expect(stderr).toContain(
      "still exceeds the target context window after model-switch compaction",
    );
    expect(stdout).toContain("old provider 1");
    expect(stdout).toContain("old provider 2");
    expect(stdout).not.toContain("unexpected target");
    expect(oldProviderTurns).toBe(2);
    expect(oldProviderSummaryRequests).toBe(1);
    expect(targetProviderTurns).toBe(0);
    expect(oldRequestContexts).toHaveLength(2);
    expect(oldRequestContexts[1]).toEqual([
      { role: "user", content: largePrompt },
      { role: "assistant", content: "old provider 1", toolCalls: [] },
      { role: "user", content: "second prompt" },
    ]);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given model-switch compaction is aborted while restoring reads,
    When the compaction helper returns,
    Then messages and read visibility roll back before the model can switch`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-model-switch-abort-restore-"),
    );
    const notePath = join(workspace, "note.txt");
    await writeFile(notePath, "fresh file content\n", "utf8");
    const messages: Message[] = [
      { role: "user", content: "large history ".repeat(3_000).trim() },
      { role: "assistant", content: "old reply", toolCalls: [] },
    ];
    const messagesBeforeCompact = structuredClone(messages);
    const readVisibility = createReadVisibilityState();
    readVisibility.applyVisibleToolExecutions([
      { content: "", ok: true, readTargetPath: notePath },
    ]);
    const projectInstructionVisibility =
      createProjectInstructionVisibilityState(workspace);
    const abortController = new AbortController();
    let stdout = "";
    let stderr = "";
    let summaryRequests = 0;
    const currentProvider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        expect(options.toolChoice).toBe("none");
        summaryRequests++;
        yield { type: "text", text: "Interrupted checkpoint summary." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    try {
      // When
      const result = await executeModelSwitchCompaction({
        current: resolvedProvider("fake", "fake", currentProvider),
        target: resolvedProvider(
          "qwen",
          "tiny",
          textProvider("unexpected target"),
          ZERO_COST_MODEL,
          {
            contextWindowTokens: 2_000,
            reserveTokens: 0,
            keepRecentTokens: 1,
          },
        ),
        workspace,
        messages,
        systemPrompt: "system",
        signal: abortController.signal,
        readVisibility,
        projectInstructionVisibility,
        nextPostCompactionReadToolCallId: () => {
          abortController.abort();
          return "post_compaction_read_after_abort";
        },
        options: {
          cliArgs: { bashMode: "disabled" },
          workspace,
          platform: process.platform,
          input: new PassThrough(),
          writeStdout: (text) => {
            stdout += text;
          },
          writeStderr: (text) => {
            stderr += text;
          },
          onSigint: () => {},
          offSigint: () => {},
          setExitCode: () => {},
          forceExit: (code) => {
            throw new ForcedExit(code);
          },
          resolveProvider: () => {
            throw new Error("provider resolution is not used");
          },
          requireKnownCostModel: () => ZERO_COST_MODEL,
          printAgentEvents: async () => undefined,
          formatCostReport: () => "",
        },
        recordCompactionCost: () => {
          throw new Error("cost is not tracked");
        },
      });

      // Then
      expect(result).toEqual({ status: "rejected" });
      expect(stdout).toBe("\n");
      expect(stderr).toBe("");
      expect(summaryRequests).toBe(1);
      expect(messages).toEqual(messagesBeforeCompact);
      expect(readVisibility.visibleReadsMostRecentFirst()).toEqual([
        { targetPath: notePath },
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given model-switch compaction is aborted after the summary returns,
    When the target has no explicit context-compaction profile,
    Then the helper rejects and restores the original transcript`, async () => {
    // Given
    const messages: Message[] = [
      { role: "user", content: "large history ".repeat(3_000).trim() },
      { role: "assistant", content: "old reply", toolCalls: [] },
    ];
    const messagesBeforeCompact = structuredClone(messages);
    const readVisibility = createReadVisibilityState();
    const projectInstructionVisibility =
      createProjectInstructionVisibilityState(process.cwd());
    const abortController = new AbortController();
    let stdout = "";
    let stderr = "";
    let summaryRequests = 0;
    const currentProvider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        expect(options.toolChoice).toBe("none");
        summaryRequests++;
        yield { type: "text", text: "Aborted checkpoint summary." };
        abortController.abort();
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    // When
    const result = await executeModelSwitchCompaction({
      current: resolvedProvider("fake", "fake", currentProvider),
      target: resolvedProvider(
        "qwen",
        "default-window",
        textProvider("unexpected target"),
      ),
      workspace: process.cwd(),
      messages,
      systemPrompt: "system",
      signal: abortController.signal,
      readVisibility,
      projectInstructionVisibility,
      nextPostCompactionReadToolCallId: () => "unexpected_restore_read",
      options: {
        cliArgs: { bashMode: "disabled" },
        workspace: process.cwd(),
        platform: process.platform,
        input: new PassThrough(),
        writeStdout: (text) => {
          stdout += text;
        },
        writeStderr: (text) => {
          stderr += text;
        },
        onSigint: () => {},
        offSigint: () => {},
        setExitCode: () => {},
        forceExit: (code) => {
          throw new ForcedExit(code);
        },
        resolveProvider: () => {
          throw new Error("provider resolution is not used");
        },
        requireKnownCostModel: () => ZERO_COST_MODEL,
        printAgentEvents: async () => undefined,
        formatCostReport: () => "",
      },
      recordCompactionCost: () => {
        throw new Error("cost is not tracked");
      },
    });

    // Then
    expect(result).toEqual({ status: "rejected" });
    expect(stdout).toBe("\n");
    expect(stderr).toBe("");
    expect(summaryRequests).toBe(1);
    expect(messages).toEqual(messagesBeforeCompact);
  });

  test(`Given model-switch compaction summary throws after abort,
    When the compaction helper catches the error,
    Then it treats the failure as an abort and restores the original transcript`, async () => {
    // Given
    const messages: Message[] = [
      { role: "user", content: "large history ".repeat(3_000).trim() },
      { role: "assistant", content: "old reply", toolCalls: [] },
    ];
    const messagesBeforeCompact = structuredClone(messages);
    const readVisibility = createReadVisibilityState();
    const projectInstructionVisibility =
      createProjectInstructionVisibilityState(process.cwd());
    const abortController = new AbortController();
    let stdout = "";
    let stderr = "";
    let summaryRequests = 0;
    const currentProvider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        expect(options.toolChoice).toBe("none");
        summaryRequests++;
        yield {
          type: "provider_retry",
          provider: "fake",
          reason: "test retry",
          attempt: 1,
          maxRetries: 1,
          delayMs: 1,
        };
        abortController.abort();
        throw new Error("summary aborted");
      },
    };

    // When
    const result = await executeModelSwitchCompaction({
      current: resolvedProvider("fake", "fake", currentProvider),
      target: resolvedProvider(
        "qwen",
        "default-window",
        textProvider("unexpected target"),
      ),
      workspace: process.cwd(),
      messages,
      systemPrompt: "system",
      signal: abortController.signal,
      readVisibility,
      projectInstructionVisibility,
      nextPostCompactionReadToolCallId: () => "unexpected_restore_read",
      options: {
        cliArgs: { bashMode: "disabled" },
        workspace: process.cwd(),
        platform: process.platform,
        input: new PassThrough(),
        writeStdout: (text) => {
          stdout += text;
        },
        writeStderr: (text) => {
          stderr += text;
        },
        onSigint: () => {},
        offSigint: () => {},
        setExitCode: () => {},
        forceExit: (code) => {
          throw new ForcedExit(code);
        },
        resolveProvider: () => {
          throw new Error("provider resolution is not used");
        },
        requireKnownCostModel: () => ZERO_COST_MODEL,
        printAgentEvents: async () => undefined,
        formatCostReport: () => "",
      },
      recordCompactionCost: () => {
        throw new Error("cost is not tracked");
      },
    });

    // Then
    expect(result).toEqual({ status: "rejected" });
    expect(stdout).toBe("\n");
    expect(stderr).toBe("");
    expect(summaryRequests).toBe(1);
    expect(messages).toEqual(messagesBeforeCompact);
  });

  test(`Given model-switch compaction still exceeds after restoring scoped reads,
    When the switch is rejected,
    Then read and project-instruction visibility roll back with the transcript`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-model-switch-visibility-rollback-"),
    );
    const packageRoot = join(workspace, "packages", "api");
    await mkdir(join(packageRoot, "src"), { recursive: true });
    const agentsPath = join(packageRoot, "AGENTS.md");
    const sourcePath = join(packageRoot, "src", "file.ts");
    await writeFile(
      agentsPath,
      "API rule: visibility rollback must preserve this instruction.\n",
      "utf8",
    );
    await writeFile(sourcePath, "export const value = 1;\n", "utf8");
    const realAgentsPath = await realpath(agentsPath);
    const realSourcePath = await realpath(sourcePath);
    const messages: Message[] = [
      { role: "user", content: "large history ".repeat(3_000).trim() },
      { role: "assistant", content: "old reply", toolCalls: [] },
    ];
    const messagesBeforeCompact = structuredClone(messages);
    const readVisibility = createReadVisibilityState();
    readVisibility.applyVisibleToolExecutions([
      {
        content: "",
        ok: true,
        readTargetPath: realSourcePath,
        readTargetOffset: 1,
        readTargetLimit: 1,
      },
    ]);
    const projectInstructionVisibility =
      createProjectInstructionVisibilityState(workspace);
    projectInstructionVisibility.markInstructionPathsVisible([realAgentsPath]);
    const abortController = new AbortController();
    let stdout = "";
    let stderr = "";
    let summaryRequests = 0;
    const currentProvider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        expect(options.toolChoice).toBe("none");
        summaryRequests++;
        yield { type: "text", text: "Still too large checkpoint summary." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };

    try {
      // When
      const result = await executeModelSwitchCompaction({
        current: resolvedProvider("fake", "fake", currentProvider),
        target: resolvedProvider(
          "qwen",
          "tiny",
          textProvider("unexpected target"),
          ZERO_COST_MODEL,
          { contextWindowTokens: 1, reserveTokens: 0, keepRecentTokens: 1 },
        ),
        workspace,
        messages,
        systemPrompt: "system",
        signal: abortController.signal,
        readVisibility,
        projectInstructionVisibility,
        nextPostCompactionReadToolCallId: () => "post_compaction_read",
        options: {
          cliArgs: { bashMode: "disabled" },
          workspace,
          platform: process.platform,
          input: new PassThrough(),
          writeStdout: (text) => {
            stdout += text;
          },
          writeStderr: (text) => {
            stderr += text;
          },
          onSigint: () => {},
          offSigint: () => {},
          setExitCode: () => {},
          forceExit: (code) => {
            throw new ForcedExit(code);
          },
          resolveProvider: () => {
            throw new Error("provider resolution is not used");
          },
          requireKnownCostModel: () => ZERO_COST_MODEL,
          printAgentEvents: async () => undefined,
          formatCostReport: () => "",
        },
        recordCompactionCost: () => {
          throw new Error("cost is not tracked");
        },
      });

      // Then
      expect(result).toEqual({ status: "rejected" });
      expect(stdout).toBe("");
      expect(stderr).toContain(
        "still exceeds the target context window after model-switch compaction",
      );
      expect(summaryRequests).toBe(1);
      expect(messages).toEqual(messagesBeforeCompact);
      expect(readVisibility.visibleReadsMostRecentFirst()).toEqual([
        { targetPath: realSourcePath, offset: 1, limit: 1 },
      ]);
      expect(
        projectInstructionVisibility
          .visibleInstructionsMostRecentFirst()
          .map((snapshot) => snapshot.instructionPath),
      ).toEqual([realAgentsPath]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given restored history has no safe model-switch compaction boundary,
    When user enters /model for a smaller target,
    Then the switch is rejected and the default provider remains active`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    let oldProviderTurns = 0;
    let targetProviderTurns = 0;
    const largePrompt = "large history ".repeat(3_000).trim();
    const oldProvider: LLMProvider = {
      id: "fake",
      async *stream() {
        oldProviderTurns++;
        yield { type: "text", text: `old provider ${oldProviderTurns}` };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const targetProvider: LLMProvider = {
      id: "fake",
      async *stream() {
        targetProviderTurns++;
        yield { type: "text", text: "unexpected target" };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      initialMessages: [{ role: "user", content: largePrompt }],
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
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
      resolveProvider: (_message, selection?: ProviderSelection) => {
        if (selection?.providerId === "qwen") {
          return resolvedProvider(
            "qwen",
            selection.model ?? "tiny",
            targetProvider,
            ZERO_COST_MODEL,
            {
              contextWindowTokens: 2_000,
              reserveTokens: 0,
              keepRecentTokens: 1,
            },
          );
        }
        return resolvedProvider("fake", "fake", oldProvider);
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    // When
    input.end("/model qwen/tiny\nsecond prompt\n");

    // Then
    await session;
    expect(stderr).toContain("Context compaction skipped: no safe history");
    expect(stdout).toContain("old provider 1");
    expect(stdout).not.toContain("unexpected target");
    expect(oldProviderTurns).toBe(1);
    expect(targetProviderTurns).toBe(0);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given model-switch compaction exceeds the cost budget,
    When user enters /model for a smaller target,
    Then Keel records the compaction cost and stops before the queued prompt`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    let oldProviderSummaryRequests = 0;
    let targetProviderTurns = 0;
    const initialMessages: readonly Message[] = [
      { role: "user", content: "large history ".repeat(3_000).trim() },
      { role: "assistant", content: "old provider 1", toolCalls: [] },
    ];
    const oldProvider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        if (options.toolChoice === "none") {
          oldProviderSummaryRequests++;
          yield { type: "text", text: "Costly checkpoint summary." };
          yield { type: "stop", reason: "stop", usage: EXPENSIVE_USAGE };
          return;
        }
        yield { type: "text", text: "unexpected old turn" };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const targetProvider: LLMProvider = {
      id: "fake",
      async *stream() {
        targetProviderTurns++;
        yield { type: "text", text: "unexpected target" };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled", maxCostUsd: 0.01 },
      workspace: process.cwd(),
      platform: process.platform,
      initialMessages,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
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
      resolveProvider: (_message, selection?: ProviderSelection) => {
        if (selection?.providerId === "qwen") {
          return resolvedProvider(
            "qwen",
            selection.model ?? "tiny",
            targetProvider,
            ONE_DOLLAR_PER_MILLION_INPUT,
            {
              contextWindowTokens: 2_000,
              reserveTokens: 0,
              keepRecentTokens: 1,
            },
          );
        }
        return resolvedProvider(
          "fake",
          "fake",
          oldProvider,
          ONE_DOLLAR_PER_MILLION_INPUT,
        );
      },
      requireKnownCostModel: () => ONE_DOLLAR_PER_MILLION_INPUT,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: (cost, maxUsd) =>
        `Cost: ${cost.spentUsd.toFixed(2)} / ${maxUsd.toFixed(2)} exceeded=${cost.budgetExceeded}\n`,
    });

    // When
    input.end("/model qwen/tiny\nsecond prompt\n");

    // Then
    await session;
    expect(stdout).toContain("Model switched to qwen/tiny");
    expect(stdout).not.toContain("unexpected target");
    expect(stderr).toContain("Context compacted: model switch");
    expect(stderr).toContain("Cost: 2.00 / 0.01 exceeded=true");
    expect(oldProviderSummaryRequests).toBe(1);
    expect(targetProviderTurns).toBe(0);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given persisted model-switch compaction exceeds the cost budget,
    When a named session consumes the model command through compaction persistence,
    Then budget stopping does not consume the queued input a second time`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    let oldProviderSummaryRequests = 0;
    let targetProviderTurns = 0;
    const persisted: Array<{
      readonly reason: "turn" | "compaction";
      readonly messages: readonly Message[];
      readonly consumedInputIds: readonly string[];
    }> = [];
    const initialMessages: readonly Message[] = [
      { role: "user", content: "large history ".repeat(3_000).trim() },
      { role: "assistant", content: "old provider 1", toolCalls: [] },
    ];
    const oldProvider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        if (options.toolChoice === "none") {
          oldProviderSummaryRequests++;
          yield { type: "text", text: "Persisted costly checkpoint summary." };
          yield { type: "stop", reason: "stop", usage: EXPENSIVE_USAGE };
          return;
        }
        yield { type: "text", text: "unexpected old turn" };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const targetProvider: LLMProvider = {
      id: "fake",
      async *stream() {
        targetProviderTurns++;
        yield { type: "text", text: "unexpected target" };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled", maxCostUsd: 0.01 },
      workspace: process.cwd(),
      platform: process.platform,
      initialMessages,
      initialQueuedInputs: [
        {
          id: "model-input",
          timestamp: "2026-01-01T00:00:00.000Z",
          sequence: 1,
          line: "/model qwen/tiny",
        },
        {
          id: "target-input",
          timestamp: "2026-01-01T00:00:01.000Z",
          sequence: 2,
          line: "second prompt",
        },
      ],
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
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
      resolveProvider: (_message, selection?: ProviderSelection) =>
        selection?.providerId === "qwen"
          ? resolvedProvider(
              "qwen",
              selection.model ?? "tiny",
              targetProvider,
              ONE_DOLLAR_PER_MILLION_INPUT,
              {
                contextWindowTokens: 2_000,
                reserveTokens: 0,
                keepRecentTokens: 1,
              },
            )
          : resolvedProvider(
              "fake",
              "fake",
              oldProvider,
              ONE_DOLLAR_PER_MILLION_INPUT,
            ),
      requireKnownCostModel: () => ONE_DOLLAR_PER_MILLION_INPUT,
      persistSessionMessages: (messages, reason, consumedInputIds) => {
        persisted.push({
          reason,
          messages: structuredClone([...messages]),
          consumedInputIds,
        });
      },
      consumeQueuedInputs: () => {
        throw new Error("compaction persistence already consumed model input");
      },
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: (cost, maxUsd) =>
        `Cost: ${cost.spentUsd.toFixed(2)} / ${maxUsd.toFixed(2)} exceeded=${cost.budgetExceeded}\n`,
    });

    // When
    input.end();

    // Then
    await session;
    expect(stdout).toContain("Model switched to qwen/tiny");
    expect(stdout).not.toContain("unexpected target");
    expect(stderr).toContain("Context compacted: model switch");
    expect(stderr).toContain("Cost: 2.00 / 0.01 exceeded=true");
    expect(oldProviderSummaryRequests).toBe(1);
    expect(targetProviderTurns).toBe(0);
    expect(persisted[0]?.reason).toBe("compaction");
    expect(persisted[0]?.consumedInputIds).toEqual(["model-input"]);
    expect(JSON.stringify(persisted[0]?.messages)).toContain(
      "Persisted costly checkpoint summary.",
    );
    expect(persisted).toHaveLength(1);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given report-only cost tracking is active before any reported turn,
    When model-switch compaction succeeds,
    Then Keel records compaction cost without printing a budget report`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    let oldProviderSummaryRequests = 0;
    const initialMessages: readonly Message[] = [
      { role: "user", content: "large history ".repeat(3_000).trim() },
      { role: "assistant", content: "old provider 1", toolCalls: [] },
    ];
    const oldProvider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        if (options.toolChoice === "none") {
          oldProviderSummaryRequests++;
          yield { type: "text", text: "Report checkpoint summary." };
          yield { type: "stop", reason: "stop", usage: EXPENSIVE_USAGE };
          return;
        }
        yield { type: "text", text: "unexpected old turn" };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled", reportFile: "session.json" },
      workspace: process.cwd(),
      platform: process.platform,
      initialMessages,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
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
      resolveProvider: (_message, selection?: ProviderSelection) =>
        selection?.providerId === "qwen"
          ? resolvedProvider(
              "qwen",
              selection.model ?? "tiny",
              textProvider("unused target"),
              ONE_DOLLAR_PER_MILLION_INPUT,
              {
                contextWindowTokens: 2_000,
                reserveTokens: 0,
                keepRecentTokens: 1,
              },
            )
          : resolvedProvider(
              "fake",
              "fake",
              oldProvider,
              ONE_DOLLAR_PER_MILLION_INPUT,
            ),
      requireKnownCostModel: () => ONE_DOLLAR_PER_MILLION_INPUT,
      printAgentEvents: async () => undefined,
      formatCostReport: () => "unexpected cost report\n",
    });

    // When
    input.end("/model qwen/tiny\n");

    // Then
    const result = await session;
    expect(result).toEqual({});
    expect(stdout).toContain("Model switched to qwen/tiny");
    expect(stderr).toContain("Context compacted: model switch");
    expect(stderr).not.toContain("unexpected cost report");
    expect(oldProviderSummaryRequests).toBe(1);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given a named session has queued model-switch input,
    When model-switch compaction succeeds,
    Then the compaction record consumes the model command before the target prompt runs`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    const persisted: Array<{
      readonly reason: "turn" | "compaction";
      readonly messages: readonly Message[];
      readonly consumedInputIds: readonly string[];
    }> = [];
    const switches: Array<{
      readonly from: {
        readonly providerId: string;
        readonly model: string;
      } | null;
      readonly to: { readonly providerId: string; readonly model: string };
      readonly consumedInputIds: readonly string[];
    }> = [];
    const targetRequestContexts: Message[][] = [];
    const initialMessages: readonly Message[] = [
      { role: "user", content: "large history ".repeat(3_000).trim() },
      { role: "assistant", content: "old provider 1", toolCalls: [] },
    ];
    const oldProvider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        if (options.toolChoice === "none") {
          yield { type: "text", text: "Persisted checkpoint summary." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        yield { type: "text", text: "unexpected old turn" };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const targetProvider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        targetRequestContexts.push(structuredClone([...options.messages]));
        yield { type: "text", text: "target reply" };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      initialMessages,
      initialQueuedInputs: [
        {
          id: "model-input",
          timestamp: "2026-01-01T00:00:00.000Z",
          sequence: 1,
          line: "/model qwen/tiny",
        },
        {
          id: "target-input",
          timestamp: "2026-01-01T00:00:01.000Z",
          sequence: 2,
          line: "second prompt",
        },
      ],
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
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
      resolveProvider: (_message, selection?: ProviderSelection) =>
        selection?.providerId === "qwen"
          ? resolvedProvider(
              "qwen",
              selection.model ?? "tiny",
              targetProvider,
              ZERO_COST_MODEL,
              {
                contextWindowTokens: 2_000,
                reserveTokens: 0,
                keepRecentTokens: 1,
              },
            )
          : resolvedProvider("fake", "fake", oldProvider),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      persistSessionMessages: (messages, reason, consumedInputIds) => {
        persisted.push({
          reason,
          messages: structuredClone([...messages]),
          consumedInputIds,
        });
      },
      persistModelSwitch: (switchRecord) => {
        switches.push(switchRecord);
      },
      consumeQueuedInputs: () => {
        throw new Error("persisted model switch should not consume separately");
      },
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    // When
    input.end();

    // Then
    await session;
    expect(stdout).toContain("Model switched to qwen/tiny");
    expect(stdout).toContain("target reply");
    expect(stderr).toContain("Context compacted: model switch");
    expect(persisted[0]?.reason).toBe("compaction");
    expect(persisted[0]?.consumedInputIds).toEqual(["model-input"]);
    expect(JSON.stringify(persisted[0]?.messages)).toContain(
      "Persisted checkpoint summary.",
    );
    expect(switches).toEqual([
      {
        from: { providerId: "fake", model: "fake" },
        to: { providerId: "qwen", model: "tiny" },
        consumedInputIds: [],
      },
    ]);
    expect(persisted[1]?.reason).toBe("turn");
    expect(persisted[1]?.consumedInputIds).toEqual(["target-input"]);
    expect(targetRequestContexts).toHaveLength(1);
    expect(targetRequestContexts[0]?.[0]?.content).toContain(
      "Persisted checkpoint summary.",
    );
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given model-switch compaction follows a file read,
    When user asks the target model to edit after the switch,
    Then the edit uses a fresh post-compaction read snapshot`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-interactive-model-switch-compact-"),
    );
    await writeFile(join(workspace, "note.txt"), "hello old world\n", "utf8");
    let receiveFirstEnd: () => void = () => {};
    const firstTurnEnded = new Promise<void>((resolve) => {
      receiveFirstEnd = resolve;
    });
    let oldRequestTurn = 0;
    let oldProviderSummaryRequests = 0;
    let targetRequestTurn = 0;
    let editRequestMessages: readonly Message[] = [];
    const oldProvider: LLMProvider = {
      id: "model-switch-read-restore-old",
      async *stream(options) {
        if (options.toolChoice === "none") {
          oldProviderSummaryRequests++;
          yield { type: "text", text: "Read checkpoint summary." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        if (oldRequestTurn === 0) {
          oldRequestTurn++;
          yield {
            type: "tool_call",
            id: "read_note",
            tool: "read",
            path: "note.txt",
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        oldRequestTurn++;
        yield { type: "text", text: "Read note.txt." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const targetProvider: LLMProvider = {
      id: "model-switch-read-restore-target",
      async *stream(options) {
        if (options.toolChoice === "none") {
          yield { type: "text", text: "unexpected target summary" };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        if (targetRequestTurn === 0) {
          targetRequestTurn++;
          editRequestMessages = structuredClone([...options.messages]);
          yield {
            type: "tool_call",
            id: "edit_note",
            tool: "edit",
            path: "note.txt",
            edits: [{ oldText: "current", newText: "fresh" }],
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        targetRequestTurn++;
        yield { type: "text", text: "Updated note.txt." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace,
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
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
      resolveProvider: (_message, selection?: ProviderSelection) => {
        if (selection?.providerId === "qwen") {
          return resolvedProvider(
            "qwen",
            selection.model ?? "tiny",
            targetProvider,
            ZERO_COST_MODEL,
            {
              contextWindowTokens: 2_000,
              reserveTokens: 0,
              keepRecentTokens: 1,
            },
          );
        }
        return resolvedProvider("fake", "fake", oldProvider, ZERO_COST_MODEL, {
          keepRecentTokens: 1,
        });
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
            if (oldRequestTurn === 2) {
              receiveFirstEnd();
            }
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    try {
      // When
      input.write(
        `read note.txt and remember ${"large history ".repeat(2_000).trim()}\n`,
      );
      await withTimeout(firstTurnEnded, 5000, "first turn did not finish");
      await writeFile(
        join(workspace, "note.txt"),
        "hello current world\n",
        "utf8",
      );
      input.write("/model qwen/tiny\n");
      input.write("replace the word\n");
      input.end();

      // Then
      await session;
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "hello fresh world\n",
      );
      const restoredReadMessage = editRequestMessages.find(
        (message): message is Extract<Message, { readonly role: "tool" }> =>
          message.role === "tool" &&
          message.content.includes("hello current world"),
      );
      expect(restoredReadMessage?.toolCallId).toContain("post_compaction_read");
      expect(JSON.stringify(editRequestMessages)).not.toContain(
        "hello old world",
      );
      expect(stdout).toContain("Read note.txt.");
      expect(stdout).toContain("Model switched to qwen/tiny");
      expect(stdout).toContain("Updated note.txt.");
      expect(stderr).toContain("Context compacted: model switch");
      expect(oldProviderSummaryRequests).toBe(1);
      expect(sigintHandlers.size).toBe(0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an interactive report already contains a completed turn,
    When user switches models and continues,
    Then the report groups usage and cost by the models that actually ran`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    let fakeReportTurns = 0;
    let qwenReportTurns = 0;
    const fakeUsage: Usage = {
      inputTokens: 1_000,
      cachedInputTokens: 0,
      uncachedInputTokens: 1_000,
      outputTokens: 10,
    };
    const qwenUsage: Usage = {
      inputTokens: 2_000,
      cachedInputTokens: 0,
      uncachedInputTokens: 2_000,
      outputTokens: 20,
    };
    const fakeReportProvider: LLMProvider = {
      id: "fake",
      async *stream() {
        fakeReportTurns++;
        yield { type: "text", text: `fake report ${fakeReportTurns}` };
        yield { type: "stop", reason: "stop", usage: fakeUsage };
      },
    };
    const qwenReportProvider: LLMProvider = {
      id: "fake",
      async *stream() {
        qwenReportTurns++;
        yield { type: "text", text: `qwen report ${qwenReportTurns}` };
        yield { type: "stop", reason: "stop", usage: qwenUsage };
      },
    };
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled", reportFile: "report.json" },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
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
      resolveProvider: (_message, selection?: ProviderSelection) => {
        if (selection?.providerId === "qwen") {
          return resolvedProvider(
            "qwen",
            selection.model ?? "qwen3.7-plus",
            qwenReportProvider,
            ONE_DOLLAR_PER_MILLION_INPUT,
          );
        }
        return resolvedProvider(
          "deepseek",
          "deepseek-v4-flash",
          fakeReportProvider,
          ONE_DOLLAR_PER_MILLION_INPUT,
        );
      },
      requireKnownCostModel: (resolved) => {
        if (resolved.costModel === null) {
          throw new Error("unknown target pricing");
        }
        return resolved.costModel;
      },
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    // When
    input.end("first prompt\n/model qwen/qwen3.7-plus\nsecond prompt\n");

    // Then
    const result = await session;
    expect(stderr).toBe("");
    expect(stdout).toContain("fake report 1");
    expect(stdout).toContain("qwen report 1");
    expect(fakeReportTurns).toBe(1);
    expect(qwenReportTurns).toBe(1);
    expect(result.report?.modelsUsed).toEqual([
      { provider: "deepseek", model: "deepseek-v4-flash" },
      { provider: "qwen", model: "qwen3.7-plus" },
    ]);
    expect(result.report?.usageByModel).toEqual([
      {
        provider: "deepseek",
        model: "deepseek-v4-flash",
        turns: 1,
        usage: fakeUsage,
        costUsd: 0.001,
      },
      {
        provider: "qwen",
        model: "qwen3.7-plus",
        turns: 1,
        usage: qwenUsage,
        costUsd: 0.002,
      },
    ]);
    expect(result.report?.end.turns).toBe(2);
    expect(result.report?.end.usage).toEqual({
      inputTokens: 3_000,
      cachedInputTokens: 0,
      uncachedInputTokens: 3_000,
      outputTokens: 30,
    });
    expect(result.report?.end.cost.spentUsd).toBeCloseTo(0.003);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given no edit checkpoint exists,
    When user enters /undo,
    Then the command reports the next actions without starting a model turn`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-interactive-undo-none-");
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    let providerResolved = false;
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace,
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
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
      resolveProvider: () => {
        providerResolved = true;
        throw new Error("undo should not resolve a provider");
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => {
        throw new Error("undo should not start a model turn");
      },
      formatCostReport: () => "",
    });

    try {
      // When
      input.end("/undo\n");

      // Then
      await session;
      expect(stdout).toBe("");
      expect(stderr).toBe(
        "No earlier checkpoints. Ask me to undo more, or use git to reset.\n",
      );
      expect(providerResolved).toBe(false);
      expect(sigintHandlers.size).toBe(0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the user passes arguments to /undo,
    When the command is parsed,
    Then the command is rejected without starting a model turn`, async () => {
    // Given
    const input = new PassThrough();
    let stdout = "";
    let stderr = "";
    let providerResolved = false;
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => {
        providerResolved = true;
        throw new Error("invalid undo should not resolve a provider");
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => {
        throw new Error("invalid undo should not start a model turn");
      },
      formatCostReport: () => "",
    });

    // When
    input.end("/undo now\n");

    // Then
    await session;
    expect(stdout).toBe("");
    expect(stderr).toBe("Error: /undo does not accept arguments.\n");
    expect(providerResolved).toBe(false);
  });

  test(`Given an edit checkpoint no longer matches the workspace,
    When user enters /undo,
    Then the command reports the block without starting a model turn`, async () => {
    // Given
    const workspace = await createGitWorkspace(
      "keel-interactive-undo-blocked-",
    );
    await commitFile(workspace, "note.txt", "before\n");
    await writeFile(join(workspace, "note.txt"), "after\n", "utf8");
    recordLastEditCheckpoint({
      workspace,
      filePath: join(workspace, "note.txt"),
      beforeContent: "before\n",
      afterContent: "after\n",
    });
    await writeFile(join(workspace, "note.txt"), "user change\n", "utf8");

    const input = new PassThrough();
    let stdout = "";
    let stderr = "";
    let providerResolved = false;
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace,
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => {
        providerResolved = true;
        throw new Error("blocked undo should not resolve a provider");
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => {
        throw new Error("blocked undo should not start a model turn");
      },
      formatCostReport: () => "",
    });

    try {
      // When
      input.end("/undo\n");

      // Then
      await session;
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "user change\n",
      );
      expect(stdout).toBe("");
      expect(stderr).toBe(
        "Cannot undo note.txt: Refusing to overwrite user changes.\n",
      );
      expect(providerResolved).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an interactive task edits two files,
    When user enters /undo before another prompt,
    Then both files are restored and the next model turn sees the restore status`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-interactive-undo-task-");
    await commitFile(workspace, "first.txt", "first old\n");
    await commitFile(workspace, "second.txt", "second old\n");

    let request = 0;
    const observedContexts: Message[][] = [];
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        request++;
        observedContexts.push(structuredClone([...options.messages]));
        switch (request) {
          case 1:
            yield {
              type: "tool_call",
              id: "read_first",
              tool: "read",
              path: "first.txt",
              limit: 10,
            };
            break;
          case 2:
            yield {
              type: "tool_call",
              id: "edit_first",
              tool: "edit",
              path: "first.txt",
              edits: [{ oldText: "first old", newText: "first new" }],
            };
            break;
          case 3:
            yield {
              type: "tool_call",
              id: "read_second",
              tool: "read",
              path: "second.txt",
              limit: 10,
            };
            break;
          case 4:
            yield {
              type: "tool_call",
              id: "edit_second",
              tool: "edit",
              path: "second.txt",
              edits: [{ oldText: "second old", newText: "second new" }],
            };
            break;
          case 5:
            yield { type: "text", text: "Updated both files." };
            break;
          case 6:
            yield { type: "text", text: "Checked restored workspace." };
            break;
          default:
            throw new Error("unexpected provider request");
        }
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    let stdout = "";
    let stderr = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace,
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: () => {},
      offSigint: () => {},
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
          } else if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    try {
      // When
      input.end("update both files\n/undo\ncheck restored workspace\n");

      // Then
      await session;
      expect(await readFile(join(workspace, "first.txt"), "utf8")).toBe(
        "first old\n",
      );
      expect(await readFile(join(workspace, "second.txt"), "utf8")).toBe(
        "second old\n",
      );
      expect(stdout).toBe(
        "Updated both files.\nRestored 2 files\nChecked restored workspace.\n",
      );
      expect(stderr).toBe("");
      const nextPromptContext = observedContexts[5];
      expect(nextPromptContext).toContainEqual({
        role: "user",
        content:
          "Keel local command /undo restored 2 files. Treat this as workspace state, not as a new user request.",
      });
      expect(nextPromptContext).toContainEqual({
        role: "user",
        content: "check restored workspace",
      });
      expect(
        observedContexts
          .flat()
          .some(
            (message) => message.role === "user" && message.content === "/undo",
          ),
      ).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given undo restores a file after the assistant reread it,
    When the next turn edits without rereading,
    Then read-before-edit is cleared and the edit is rejected`, async () => {
    // Given
    const workspace = await createGitWorkspace(
      "keel-interactive-undo-read-visibility-",
    );
    await commitFile(workspace, "note.txt", "old\n");

    let request = 0;
    const observedContexts: Message[][] = [];
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        request++;
        observedContexts.push(structuredClone([...options.messages]));
        switch (request) {
          case 1:
            yield {
              type: "tool_call",
              id: "read_before_edit",
              tool: "read",
              path: "note.txt",
              limit: 10,
            };
            break;
          case 2:
            yield {
              type: "tool_call",
              id: "edit_note",
              tool: "edit",
              path: "note.txt",
              edits: [{ oldText: "old", newText: "new" }],
            };
            break;
          case 3:
            yield {
              type: "tool_call",
              id: "read_after_edit",
              tool: "read",
              path: "note.txt",
              limit: 10,
            };
            break;
          case 4:
            yield { type: "text", text: "Updated and reread." };
            break;
          case 5:
            yield {
              type: "tool_call",
              id: "edit_without_reread",
              tool: "edit",
              path: "note.txt",
              edits: [{ oldText: "old", newText: "final" }],
            };
            break;
          case 6:
            yield { type: "text", text: "Need to reread." };
            break;
          default:
            throw new Error("unexpected provider request");
        }
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    let stdout = "";
    let stderr = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace,
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: () => {},
      offSigint: () => {},
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
          } else if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    try {
      // When
      input.end("update and reread\n/undo\ntry edit without rereading\n");

      // Then
      await session;
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe("old\n");
      expect(stdout).toBe(
        "Updated and reread.\nRestored note.txt\nNeed to reread.\n",
      );
      expect(stderr).toBe("");
      const finalContext = observedContexts[5];
      const failedEditMessage = finalContext?.find(
        (message) =>
          message.role === "tool" &&
          message.toolCallId === "edit_without_reread",
      );
      expect(failedEditMessage?.content).toContain("file has not been read");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a named session has queued undo input,
    When undo restores a checkpoint,
    Then resume preserves the restore status without replaying the undo command`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-interactive-undo-resume-");
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    let now = 0;
    const runtime = {
      env: (key: string) => (key === "KEEL_HOME" ? home : undefined),
      now: () => now,
    };
    await commitFile(workspace, "note.txt", "before\n");
    await writeFile(join(workspace, "note.txt"), "after\n", "utf8");
    recordLastEditCheckpoint({
      workspace,
      filePath: join(workspace, "note.txt"),
      beforeContent: "before\n",
      afterContent: "after\n",
    });
    const storedSession = createSessionStore({
      sessionId: "undo-resume",
      workspace,
      runtime,
    });
    const queuedUndo = persistSessionQueuedInput({
      session: storedSession,
      sequence: 1,
      line: "/undo",
      runtime,
    });
    let persistedMessages: readonly Message[] = storedSession.messages;
    const firstInput = new PassThrough();
    let firstStdout = "";
    let firstStderr = "";
    const firstRun = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace,
      platform: process.platform,
      initialMessages: storedSession.messages,
      initialQueuedInputs: [queuedUndo],
      input: firstInput,
      writeStdout: (text) => {
        firstStdout += text;
      },
      writeStderr: (text) => {
        firstStderr += text;
      },
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => {
        throw new Error("queued undo should not resolve a provider");
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => {
        throw new Error("queued undo should not start a model turn");
      },
      formatCostReport: () => "",
      persistSessionMessages: (messages, reason, consumedInputIds) => {
        now = 1;
        persistedMessages = persistSessionMessages({
          session: storedSession,
          previousMessages: persistedMessages,
          currentMessages: messages,
          runtime,
          reason,
          consumedInputIds,
        });
      },
    });
    firstInput.end();

    try {
      await firstRun;
      const resumed = resumeSessionStore({
        sessionId: "undo-resume",
        workspace,
        runtime,
      });
      const observedContexts: Message[][] = [];
      const provider: LLMProvider = {
        id: "fake",
        async *stream(options) {
          observedContexts.push(structuredClone([...options.messages]));
          yield { type: "text", text: "Resumed after undo." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
        },
      };
      const secondInput = new PassThrough();
      let secondStdout = "";
      const secondRun = runInteractiveSession({
        cliArgs: { bashMode: "disabled" },
        workspace,
        platform: process.platform,
        initialMessages: resumed.messages,
        initialQueuedInputs: resumed.pendingInputs,
        input: secondInput,
        writeStdout: (text) => {
          secondStdout += text;
        },
        writeStderr: () => {},
        onSigint: () => {},
        offSigint: () => {},
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
          let finalEnd:
            | Extract<AgentEvent, { readonly type: "end" }>
            | undefined;
          for await (const event of stream) {
            if (event.type === "text") {
              secondStdout += event.text;
            } else if (event.type === "end") {
              finalEnd = event;
            }
          }
          return finalEnd;
        },
        formatCostReport: () => "",
      });

      // When
      secondInput.end("continue after undo\n");
      await secondRun;

      // Then
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "before\n",
      );
      expect(firstStdout).toBe("Restored note.txt\n");
      expect(firstStderr).toBe("");
      expect(resumed.pendingInputs).toEqual([]);
      expect(resumed.messages).toEqual([
        {
          role: "user",
          content:
            "Keel local command /undo restored note.txt. Treat this as workspace state, not as a new user request.",
        },
      ]);
      expect(observedContexts).toEqual([
        [
          {
            role: "user",
            content:
              "Keel local command /undo restored note.txt. Treat this as workspace state, not as a new user request.",
          },
          { role: "user", content: "continue after undo" },
        ],
      ]);
      expect(secondStdout).toBe("Resumed after undo.\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given the interactive session is idle,
    When user enters /fork with a target and fork point,
    Then the fork is created locally without starting a model turn`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    let forkTarget = "";
    let forkBeforeMessageId: string | undefined;
    let providerResolved = false;
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
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
      resolveProvider: () => {
        providerResolved = true;
        throw new Error("fork should not resolve a provider");
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => {
        throw new Error("fork should not start a model turn");
      },
      formatCostReport: () => "",
      forkSession: (request) => {
        forkTarget = request.targetSessionId;
        forkBeforeMessageId = request.beforeMessageId;
        return 'Forked session "source" to "target" before message msg_beta.\nresume: keel --resume target\n';
      },
    });

    // When
    input.end("/fork target --before-message=msg_beta\n");

    // Then
    await session;
    expect(stdout).toBe(
      'Forked session "source" to "target" before message msg_beta.\nresume: keel --resume target\n',
    );
    expect(stderr).toBe("");
    expect(forkTarget).toBe("target");
    expect(forkBeforeMessageId).toBe("msg_beta");
    expect(providerResolved).toBe(false);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given the interactive session is idle,
    When user lists fork points,
    Then the command prints local fork commands without starting a model turn`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    let providerResolved = false;
    let listCalls = 0;
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
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
      resolveProvider: () => {
        providerResolved = true;
        throw new Error("fork points should not resolve a provider");
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => {
        throw new Error("fork points should not start a model turn");
      },
      formatCostReport: () => "",
      listForkPoints: () => {
        listCalls += 1;
        return {
          sessionId: "source",
          points:
            listCalls === 1
              ? [
                  {
                    choice: 1,
                    messageId: "msg_alpha",
                    preview: "remember alpha",
                  },
                  {
                    choice: 2,
                    messageId: "msg_beta",
                    preview: "remember beta",
                  },
                ]
              : [],
        };
      },
    });

    // When
    input.end("/fork-points\n/fork-points\n");

    // Then
    await session;
    expect(stdout).toBe(
      [
        'Fork points for session "source":',
        "1. before message msg_alpha: remember alpha",
        "   use: /fork <new-id> --before-message msg_alpha",
        "2. before message msg_beta: remember beta",
        "   use: /fork <new-id> --before-message msg_beta",
        'No restored user messages in session "source".',
        "",
      ].join("\n"),
    );
    expect(stderr).toBe("");
    expect(providerResolved).toBe(false);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given the interactive session is idle,
    When user picks a fork point,
    Then the fork is created from the selected point without starting a model turn`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    let forkTarget = "";
    let forkBeforeMessageId: string | undefined;
    let providerResolved = false;
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
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
      resolveProvider: () => {
        providerResolved = true;
        throw new Error("fork picker should not resolve a provider");
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => {
        throw new Error("fork picker should not start a model turn");
      },
      formatCostReport: () => "",
      listForkPoints: () => ({
        sessionId: "source",
        points: [
          { choice: 1, messageId: "msg_alpha", preview: "remember alpha" },
          { choice: 2, messageId: "msg_beta", preview: "remember beta" },
        ],
      }),
      forkSession: (request) => {
        forkTarget = request.targetSessionId;
        forkBeforeMessageId = request.beforeMessageId;
        return 'Forked session "source" to "target" before message msg_beta.\nresume: keel --resume target\n';
      },
    });

    // When
    input.end("/fork target --pick\n2\n");

    // Then
    await session;
    expect(stdout).toBe(
      [
        'Fork points for session "source":',
        "0. full restored history",
        "1. before message msg_alpha: remember alpha",
        "2. before message msg_beta: remember beta",
        "",
        "Select fork point [0-2], or q to cancel:",
        'Forked session "source" to "target" before message msg_beta.',
        "resume: keel --resume target",
        "",
      ].join("\n"),
    );
    expect(stderr).toBe("");
    expect(forkTarget).toBe("target");
    expect(forkBeforeMessageId).toBe("msg_beta");
    expect(providerResolved).toBe(false);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given the interactive session is idle,
    When user picks full restored history,
    Then the fork is created without a before-message fork point`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    let forkBeforeMessageId: string | undefined = "msg_alpha";
    let providerResolved = false;
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
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
      resolveProvider: () => {
        providerResolved = true;
        throw new Error(
          "full-history fork picker should not resolve a provider",
        );
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => {
        throw new Error(
          "full-history fork picker should not start a model turn",
        );
      },
      formatCostReport: () => "",
      listForkPoints: () => ({
        sessionId: "source",
        points: [
          { choice: 1, messageId: "msg_alpha", preview: "remember alpha" },
        ],
      }),
      forkSession: (request) => {
        forkBeforeMessageId = request.beforeMessageId;
        return 'Forked session "source" to "target".\nresume: keel --resume target\n';
      },
    });

    // When
    input.end("/fork target --pick\n0\n");

    // Then
    await session;
    expect(stdout).toContain('Forked session "source" to "target".\n');
    expect(stderr).toBe("");
    expect(forkBeforeMessageId).toBeUndefined();
    expect(providerResolved).toBe(false);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given the interactive fork picker input closes before a selection,
    When the session exits,
    Then no fork is created and no model turn starts`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    let forkCalled = false;
    let providerResolved = false;
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
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
      resolveProvider: () => {
        providerResolved = true;
        throw new Error("closed fork picker should not resolve a provider");
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => {
        throw new Error("closed fork picker should not start a model turn");
      },
      formatCostReport: () => "",
      listForkPoints: () => ({
        sessionId: "source",
        points: [
          { choice: 1, messageId: "msg_alpha", preview: "remember alpha" },
        ],
      }),
      forkSession: () => {
        forkCalled = true;
        throw new Error("fork picker should have been closed");
      },
    });

    // When
    input.end("/fork target --pick\n");

    // Then
    await session;
    expect(stdout).toBe(
      [
        'Fork points for session "source":',
        "0. full restored history",
        "1. before message msg_alpha: remember alpha",
        "",
        "Select fork point [0-1], or q to cancel:",
        "",
      ].join("\n"),
    );
    expect(stderr).toBe("");
    expect(forkCalled).toBe(false);
    expect(providerResolved).toBe(false);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given the interactive fork picker operation fails,
    When user selects a fork point,
    Then the failure is reported without starting a model turn`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    let providerResolved = false;
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
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
      resolveProvider: () => {
        providerResolved = true;
        throw new Error("failed fork picker should not resolve a provider");
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => {
        throw new Error("failed fork picker should not start a model turn");
      },
      formatCostReport: () => "",
      listForkPoints: () => ({
        sessionId: "source",
        points: [
          { choice: 1, messageId: "msg_alpha", preview: "remember alpha" },
        ],
      }),
      forkSession: () => {
        throw "picker fork failed";
      },
    });

    // When
    input.end("/fork target --pick\n1\n");

    // Then
    await session;
    expect(stdout).toBe(
      [
        'Fork points for session "source":',
        "0. full restored history",
        "1. before message msg_alpha: remember alpha",
        "",
        "Select fork point [0-1], or q to cancel:",
        "",
      ].join("\n"),
    );
    expect(stderr).toBe("picker fork failed\n");
    expect(providerResolved).toBe(false);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given picker support is unavailable in a fork-capable session,
    When user asks to pick a fork point,
    Then the command fails locally without starting a model turn`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    let providerResolved = false;
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
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
      resolveProvider: () => {
        providerResolved = true;
        throw new Error(
          "unavailable fork picker should not resolve a provider",
        );
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => {
        throw new Error(
          "unavailable fork picker should not start a model turn",
        );
      },
      formatCostReport: () => "",
      forkSession: () => {
        throw new Error("fork picker should fail before forking");
      },
    });

    // When
    input.end("/fork target --pick\n");

    // Then
    await session;
    expect(stdout).toBe("");
    expect(stderr).toBe(
      "Error: /fork requires a named session. Start with --session or --resume.\n",
    );
    expect(providerResolved).toBe(false);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given queued input contains an interactive fork picker command,
    When the picker consumes a queued selection,
    Then both queued inputs are marked consumed without starting a model turn`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    let forkBeforeMessageId: string | undefined;
    let providerResolved = false;
    const consumedInputIds: string[][] = [];
    const initialQueuedInputs: readonly SessionQueuedInput[] = [
      {
        id: "queued-command",
        timestamp: "1970-01-01T00:00:00.000Z",
        sequence: 1,
        line: "/fork target --pick",
      },
      {
        id: "queued-selection",
        timestamp: "1970-01-01T00:00:00.000Z",
        sequence: 2,
        line: "2",
      },
    ];
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      initialQueuedInputs,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
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
      resolveProvider: () => {
        providerResolved = true;
        throw new Error("queued fork picker should not resolve a provider");
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => {
        throw new Error("queued fork picker should not start a model turn");
      },
      formatCostReport: () => "",
      consumeQueuedInputs: (inputIds) => {
        consumedInputIds.push([...inputIds]);
      },
      listForkPoints: () => ({
        sessionId: "source",
        points: [
          { choice: 1, messageId: "msg_alpha", preview: "remember alpha" },
          { choice: 2, messageId: "msg_beta", preview: "remember beta" },
        ],
      }),
      forkSession: (request) => {
        forkBeforeMessageId = request.beforeMessageId;
        return 'Forked session "source" to "target" before message msg_beta.\nresume: keel --resume target\n';
      },
    });

    // When
    input.end();

    // Then
    await session;
    expect(stdout).toContain(
      'Forked session "source" to "target" before message msg_beta.\n',
    );
    expect(stderr).toBe("");
    expect(forkBeforeMessageId).toBe("msg_beta");
    expect(consumedInputIds).toEqual([["queued-command", "queued-selection"]]);
    expect(providerResolved).toBe(false);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given the interactive fork picker receives an invalid answer,
    When user cancels after the retry prompt,
    Then no fork is created and no model turn starts`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    let forkCalled = false;
    let providerResolved = false;
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
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
      resolveProvider: () => {
        providerResolved = true;
        throw new Error("cancelled fork picker should not resolve a provider");
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => {
        throw new Error("cancelled fork picker should not start a model turn");
      },
      formatCostReport: () => "",
      listForkPoints: () => ({
        sessionId: "source",
        points: [
          { choice: 1, messageId: "msg_alpha", preview: "remember alpha" },
        ],
      }),
      forkSession: () => {
        forkCalled = true;
        throw new Error("fork picker should have been cancelled");
      },
    });

    // When
    input.end("/fork target --pick\n\n2\nx\nq\n");

    // Then
    await session;
    expect(stdout).toBe(
      [
        'Fork points for session "source":',
        "0. full restored history",
        "1. before message msg_alpha: remember alpha",
        "",
        "Select fork point [0-1], or q to cancel:",
        "Select fork point [0-1], or q to cancel:",
        "Select fork point [0-1], or q to cancel:",
        "Select fork point [0-1], or q to cancel:",
        "Fork cancelled.",
        "",
      ].join("\n"),
    );
    expect(stderr).toBe(
      "Error: selection must be 0-1 or q.\nError: selection must be 0-1 or q.\nError: selection must be 0-1 or q.\n",
    );
    expect(forkCalled).toBe(false);
    expect(providerResolved).toBe(false);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given the interactive session has no persisted session,
    When user enters /fork,
    Then the command fails locally without starting a model turn`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    let providerResolved = false;
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
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
      resolveProvider: () => {
        providerResolved = true;
        throw new Error("fork should not resolve a provider");
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => {
        throw new Error("fork should not start a model turn");
      },
      formatCostReport: () => "",
    });

    // When
    input.end("/fork-points\n/fork target\n/fork target --pick\n");

    // Then
    await session;
    expect(stdout).toBe("");
    expect(stderr).toBe(
      [
        "Error: /fork-points requires a named session. Start with --session or --resume.",
        "Error: /fork requires a named session. Start with --session or --resume.",
        "Error: /fork requires a named session. Start with --session or --resume.",
        "",
      ].join("\n"),
    );
    expect(providerResolved).toBe(false);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given the interactive session receives malformed fork commands,
    When user enters them at the prompt,
    Then each command reports a local error without starting a model turn`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    let providerResolved = false;
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
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
      resolveProvider: () => {
        providerResolved = true;
        throw new Error("malformed fork should not resolve a provider");
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => {
        throw new Error("malformed fork should not start a model turn");
      },
      formatCostReport: () => "",
    });

    // When
    input.end(
      [
        "/fork",
        "/fork --before-message msg_alpha",
        "/fork target --before-message",
        "/fork target --before-message=",
        "/fork target --pick --before-message msg_alpha",
        "/fork target --pick=1",
        "/fork-points extra",
        "/fork target --all",
        "",
      ].join("\n"),
    );

    // Then
    await session;
    expect(stdout).toBe("");
    expect(stderr).toBe(
      [
        "Error: /fork requires <target-id>.",
        "Error: /fork requires <target-id>.",
        "Error: --before-message requires a value.",
        "Error: --before-message requires a value.",
        "Error: --pick cannot be combined with --before-message.",
        'Error: unknown /fork option "--pick=1".',
        "Error: /fork-points does not accept arguments.",
        'Error: unknown /fork option "--all".',
        "",
      ].join("\n"),
    );
    expect(providerResolved).toBe(false);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given the interactive fork operation fails,
    When user enters /fork,
    Then the failure is reported locally without starting a model turn`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    let providerResolved = false;
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
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
      resolveProvider: () => {
        providerResolved = true;
        throw new Error("failed fork should not resolve a provider");
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => {
        throw new Error("failed fork should not start a model turn");
      },
      formatCostReport: () => "",
      forkSession: () => {
        throw "fork failed";
      },
    });

    // When
    input.end("/fork target\n");

    // Then
    await session;
    expect(stdout).toBe("");
    expect(stderr).toBe("fork failed\n");
    expect(providerResolved).toBe(false);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given an interactive turn has cost tracking,
    When the turn completes,
    Then the session prints the cost report`, async () => {
    // Given
    const provider: LLMProvider = {
      id: "fake",
      async *stream() {
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stderr = "";
    let resolvedProviders = 0;
    const session = runInteractiveSession({
      cliArgs: { bashMode: "trusted", maxCostUsd: 1 },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: () => {},
      writeStderr: (text) => {
        stderr += text;
      },
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
      resolveProvider: () => {
        resolvedProviders++;
        return {
          provider,
          providerId: "fake",
          model: "fake",
          costModel: ZERO_COST_MODEL,
        };
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "Cost: $0\n",
    });

    // When
    input.write("\nhello\n");
    input.end();

    // Then
    await session;
    expect(stderr).toBe("Cost: $0\n");
    expect(resolvedProviders).toBe(1);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given an interactive session cost limit is exhausted,
    When more prompt input is already queued,
    Then the session stops before starting another model turn`, async () => {
    // Given
    let providerCalls = 0;
    const provider: LLMProvider = {
      id: "fake",
      async *stream() {
        providerCalls++;
        yield { type: "text", text: "expensive answer" };
        yield { type: "stop", reason: "stop", usage: EXPENSIVE_USAGE };
      },
    };
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stderr = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "trusted", maxCostUsd: 1 },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: () => {},
      writeStderr: (text) => {
        stderr += text;
      },
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
        costModel: ONE_DOLLAR_PER_MILLION_INPUT,
      }),
      requireKnownCostModel: () => ONE_DOLLAR_PER_MILLION_INPUT,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: (cost) =>
        `Cost: ${cost.spentUsd.toFixed(2)} exceeded=${String(
          cost.budgetExceeded,
        )}\n`,
    });

    // When
    input.end("first prompt\nsecond prompt\n");

    // Then
    await session;
    expect(providerCalls).toBe(1);
    expect(stderr).toBe("Cost: 2.00 exceeded=true\n");
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given a named session resumes with queued input from an interrupted run,
    When stdin closes before new input arrives,
    Then the queued input runs once and is consumed with the persisted turn`, async () => {
    // Given
    const pendingInput: SessionQueuedInput = {
      id: "queued-follow-up",
      timestamp: "1970-01-01T00:00:00.001Z",
      sequence: 7,
      line: "continue with beta",
    };
    const observedUserContexts: string[][] = [];
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        observedUserContexts.push(
          options.messages
            .filter((message) => message.role === "user")
            .map((message) => message.content),
        );
        yield { type: "text", text: "Queued turn done." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    const consumedInputIds: string[][] = [];
    let persistedMessages: readonly Message[] = [];
    let stdout = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      initialQueuedInputs: [pendingInput],
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: () => {},
      onSigint: () => {},
      offSigint: () => {},
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
          } else if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
      persistSessionMessages: (messages, _reason, inputIds) => {
        persistedMessages = [...messages];
        consumedInputIds.push([...inputIds]);
      },
    });
    input.end();

    // When / Then
    await withTimeout(session, 5000, "resumed queued input was not processed");
    expect(stdout).toBe("Queued turn done.\n");
    expect(observedUserContexts).toEqual([["continue with beta"]]);
    expect(consumedInputIds).toEqual([["queued-follow-up"]]);
    expect(persistedMessages).toEqual([
      { role: "user", content: "continue with beta" },
      { role: "assistant", content: "Queued turn done.", toolCalls: [] },
    ]);
  });

  test(`Given a named session resumes with blank queued input,
    When stdin closes before new input arrives,
    Then the blank input is consumed without starting a model turn`, async () => {
    // Given
    const pendingInput: SessionQueuedInput = {
      id: "blank-queued-input",
      timestamp: "1970-01-01T00:00:00.001Z",
      sequence: 8,
      line: "   ",
    };
    const consumedInputIds: string[][] = [];
    const input = new PassThrough();
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      initialQueuedInputs: [pendingInput],
      input,
      writeStdout: () => {},
      writeStderr: () => {},
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => {
        throw new Error("blank queued input should not resolve a provider");
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => undefined,
      formatCostReport: () => "",
      consumeQueuedInputs: (inputIds) => {
        consumedInputIds.push([...inputIds]);
      },
    });
    input.end();

    // When
    await withTimeout(session, 5000, "blank queued input was not consumed");

    // Then
    expect(consumedInputIds).toEqual([["blank-queued-input"]]);
  });

  test(`Given a queued prompt is typed while a named session turn is running,
    When the process stops before the turn transcript is persisted,
    Then the queued prompt is durable and resumes exactly once`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-interactive-inbox-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    let now = 0;
    const runtime = {
      env: (key: string) => (key === "KEEL_HOME" ? home : undefined),
      now: () => now,
    };
    const session = createSessionStore({
      sessionId: "durable-inbox",
      workspace,
      runtime,
    });
    let persistedMessages: readonly Message[] = session.messages;
    const crash = new Error("simulated process stop");
    const firstProvider: LLMProvider = {
      id: "fake",
      async *stream() {
        yield {
          type: "tool_call",
          id: "durable_inbox_read",
          tool: "read",
          path: "package.json",
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const firstInput = new PassThrough();
    const firstRun = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace,
      platform: process.platform,
      initialMessages: session.messages,
      initialQueuedInputs: session.pendingInputs,
      input: firstInput,
      writeStdout: () => {},
      writeStderr: () => {},
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => ({
        provider: firstProvider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        for await (const event of stream) {
          if (event.type === "tool_start") {
            now = 1;
            firstInput.write("continue after restart\n");
            await setImmediate();
            firstInput.end();
            throw crash;
          }
        }
        return undefined;
      },
      formatCostReport: () => "",
      persistQueuedInput: (input) =>
        persistSessionQueuedInput({
          session,
          sequence: input.sequence,
          line: input.line,
          runtime,
        }),
      persistSessionMessages: (messages, reason, consumedInputIds) => {
        now = 2;
        persistedMessages = persistSessionMessages({
          session,
          previousMessages: persistedMessages,
          currentMessages: messages,
          runtime,
          reason,
          consumedInputIds,
        });
      },
    });

    try {
      firstInput.write("start slow tool\n");
      await expect(firstRun).rejects.toThrow("simulated process stop");

      const ledgerAfterCrash = (await readFile(session.filePath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(ledgerAfterCrash).toHaveLength(2);
      expect(ledgerAfterCrash[1]).toMatchObject({
        type: "input_admitted",
        line: "continue after restart",
      });
      const resumed = resumeSessionStore({
        sessionId: "durable-inbox",
        workspace,
        runtime,
      });
      expect(resumed.messages).toEqual([]);
      expect(resumed.pendingInputs).toHaveLength(1);

      const observedUserContexts: string[][] = [];
      const secondProvider: LLMProvider = {
        id: "fake",
        async *stream(options) {
          observedUserContexts.push(
            options.messages
              .filter((message) => message.role === "user")
              .map((message) => message.content),
          );
          yield { type: "text", text: "Recovered queued prompt." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
        },
      };
      const secondInput = new PassThrough();
      let resumedPersistedMessages: readonly Message[] = resumed.messages;
      const secondRun = runInteractiveSession({
        cliArgs: { bashMode: "disabled" },
        workspace,
        platform: process.platform,
        initialMessages: resumed.messages,
        initialQueuedInputs: resumed.pendingInputs,
        input: secondInput,
        writeStdout: () => {},
        writeStderr: () => {},
        onSigint: () => {},
        offSigint: () => {},
        setExitCode: () => {},
        forceExit: (code) => {
          throw new ForcedExit(code);
        },
        resolveProvider: () => ({
          provider: secondProvider,
          providerId: "fake",
          model: "fake",
          costModel: ZERO_COST_MODEL,
        }),
        requireKnownCostModel: () => ZERO_COST_MODEL,
        printAgentEvents: async (stream) => {
          let finalEnd:
            | Extract<AgentEvent, { readonly type: "end" }>
            | undefined;
          for await (const event of stream) {
            if (event.type === "end") {
              finalEnd = event;
            }
          }
          return finalEnd;
        },
        formatCostReport: () => "",
        persistSessionMessages: (messages, reason, consumedInputIds) => {
          now = 3;
          resumedPersistedMessages = persistSessionMessages({
            session: resumed,
            previousMessages: resumedPersistedMessages,
            currentMessages: messages,
            runtime,
            reason,
            consumedInputIds,
          });
        },
      });
      secondInput.end();

      // When
      await withTimeout(
        secondRun,
        5000,
        "durable queued prompt was not resumed",
      );
      const finalResume = resumeSessionStore({
        sessionId: "durable-inbox",
        workspace,
        runtime,
      });

      // Then
      expect(observedUserContexts).toEqual([["continue after restart"]]);
      expect(finalResume.pendingInputs).toEqual([]);
      expect(finalResume.messages).toEqual([
        { role: "user", content: "continue after restart" },
        {
          role: "assistant",
          content: "Recovered queued prompt.",
          toolCalls: [],
        },
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given an interactive report is requested but no end event is returned,
    When the user finishes a prompt,
    Then no session report is produced`, async () => {
    // Given
    const provider: LLMProvider = {
      id: "fake",
      async *stream() {
        yield { type: "text", text: "answer" };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    let stdout = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "trusted", reportFile: "session.json" },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: () => {},
      onSigint: () => {},
      offSigint: () => {},
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
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
          }
        }
        return undefined;
      },
      formatCostReport: () => "",
    });

    // When
    input.end("hello\n");

    // Then
    const result = await session;
    expect(stdout).toBe("answer\n");
    expect(result.report).toBeUndefined();
  });

  test(`Given an interactive assistant turn is still working,
    When user sends a follow-up before it finishes,
    Then the follow-up runs next with previous context`, async () => {
    // Given
    let finishFirstTurn: () => void = () => {};
    let receiveFirstText: () => void = () => {};
    const firstTurnCanFinish = new Promise<void>((resolve) => {
      finishFirstTurn = resolve;
    });
    const firstTextReceived = new Promise<void>((resolve) => {
      receiveFirstText = resolve;
    });
    const observedContexts: Array<
      Array<{ readonly role: Message["role"]; readonly content: string }>
    > = [];
    let turn = 0;
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        turn++;
        observedContexts.push(
          options.messages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
        );

        if (turn === 1) {
          yield { type: "text", text: "First answer" };
          receiveFirstText();
          await firstTurnCanFinish;
        } else {
          yield { type: "text", text: "Second saw prior context" };
        }
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    let stdout = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "ask" },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: () => {
        throw new Error("follow-up input should not be treated as approval");
      },
      onSigint: () => {},
      offSigint: () => {},
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
          } else if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    // When
    input.write("first prompt\n");
    await withTimeout(firstTextReceived, 5000, "first turn did not start");
    input.write("second prompt\n");
    input.end();
    finishFirstTurn();

    // Then
    await session;
    expect(stdout).toBe("First answer\nSecond saw prior context\n");
    expect(observedContexts).toEqual([
      [{ role: "user", content: "first prompt" }],
      [
        { role: "user", content: "first prompt" },
        { role: "assistant", content: "First answer" },
        { role: "user", content: "second prompt" },
      ],
    ]);
  });

  test(`Given a resumed session contains historical tool results,
    When the user sends a follow-up prompt,
    Then the model sees the history without re-running old tools`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-interactive-resume-"));
    const initialMessages: readonly Message[] = [
      { role: "user", content: "create the old file" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "historical_write",
            tool: "write",
            path: "old.txt",
            content: "old content\n",
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "historical_write",
        content: "Wrote old.txt",
      },
    ];
    let observedMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        observedMessages = options.messages;
        yield { type: "text", text: "Continuing from history." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    let stdout = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace,
      platform: process.platform,
      initialMessages,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: () => {},
      onSigint: () => {},
      offSigint: () => {},
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
          } else if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    try {
      // When
      input.end("continue\n");

      // Then
      await session;
      expect(stdout).toBe("Continuing from history.\n");
      expect(observedMessages).toEqual([
        ...initialMessages,
        { role: "user", content: "continue" },
      ]);
      await expect(
        readFile(join(workspace, "old.txt"), "utf8"),
      ).rejects.toThrow("ENOENT");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an interactive session asks for bash permission,
    When the user approves the command for the session,
    Then repeated matching commands run without asking again`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-interactive-bash-"));
    const command =
      "node -e \"require('node:fs').appendFileSync('runs.txt', 'x')\"";
    const provider = createFakeProvider([
      fakeToolResponse("bash", { command }),
      fakeToolResponse("bash", { command }),
      fakeResponse("Ran twice."),
    ]);
    const input = new PassThrough();
    let stdout = "";
    let stderr = "";
    let approvalAnswered = false;
    const session = runInteractiveSession({
      cliArgs: { bashMode: "ask" },
      workspace,
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
        if (text.includes("Approve bash command") && !approvalAnswered) {
          approvalAnswered = true;
          input.write("s\n");
          input.end();
        }
      },
      onSigint: () => {},
      offSigint: () => {},
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
          } else if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    try {
      // When
      input.write("run twice\n");

      // Then
      await session;
      expect(stdout).toBe("Ran twice.\n");
      expect(await readFile(join(workspace, "runs.txt"), "utf8")).toBe("xx");
      expect(stderr.match(/Approve bash command/g)).toHaveLength(1);
      expect(stderr).toContain(
        "Approved command output may be sent to the provider unredacted.",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an interactive user approves a bash command family,
    When the assistant runs matching commands in the same workspace,
    Then the later matching command runs without another prompt`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-interactive-bash-"));
    const firstCommand = "git status --short";
    const secondCommand = "git status --porcelain";
    const provider = createFakeProvider([
      fakeToolResponse("bash", { command: firstCommand }),
      fakeToolResponse("bash", { command: secondCommand }),
      fakeResponse("Checked status twice."),
    ]);
    const input = new PassThrough();
    let stdout = "";
    let stderr = "";
    let approvalPrompts = 0;
    const session = runInteractiveSession({
      cliArgs: { bashMode: "ask" },
      workspace,
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
        if (text.includes("Approve bash command")) {
          approvalPrompts++;
          input.write("p\n");
          input.end();
        }
      },
      onSigint: () => {},
      offSigint: () => {},
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
          } else if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    try {
      execFileSync("git", ["init", "--quiet"], { cwd: workspace });

      // When
      input.write("check status twice\n");

      // Then
      await withTimeout(
        session,
        5000,
        "command family approval did not finish",
      );
      expect(stdout).toBe("Checked status twice.\n");
      expect(stderr).toContain(
        "[p] allow command family for session: git status",
      );
      expect(approvalPrompts).toBe(1);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an interactive user answers prefix for a command without a family,
    When the assistant requests bash approval,
    Then the command is denied without offering a command family`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-interactive-bash-"));
    const command =
      "node -e \"require('node:fs').writeFileSync('created.txt', 'changed')\"";
    const provider = createFakeProvider([
      fakeToolResponse("bash", { command }),
      fakeResponse("No prefix approval."),
    ]);
    const input = new PassThrough();
    let stdout = "";
    let stderr = "";
    let approvalAnswered = false;
    const session = runInteractiveSession({
      cliArgs: { bashMode: "ask" },
      workspace,
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
        if (text.includes("Approve bash command") && !approvalAnswered) {
          approvalAnswered = true;
          input.write("p\n");
          input.end();
        }
      },
      onSigint: () => {},
      offSigint: () => {},
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
          } else if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    try {
      // When
      input.write("try prefix approval\n");

      // Then
      await withTimeout(session, 5000, "prefix denial did not finish");
      expect(stdout).toBe("No prefix approval.\n");
      expect(stderr).not.toContain("[p] allow command family for session:");
      await expect(
        readFile(join(workspace, "created.txt"), "utf8"),
      ).rejects.toThrow("ENOENT");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given git diff no-index requests interactive bash approval,
    When the user answers prefix,
    Then the command is denied without offering a command family`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-interactive-bash-"));
    const outsideSecret = join(tmpdir(), "keel-outside-secret.txt");
    const outsideEmpty = join(tmpdir(), "keel-outside-empty.txt");
    const command = `git diff --no-index ${outsideSecret} ${outsideEmpty}`;
    let secondTurnMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        if (options.messages.length === 1) {
          yield {
            type: "tool_call",
            id: "git_diff_no_index",
            tool: "bash",
            command,
          };
        } else {
          secondTurnMessages = options.messages;
          yield { type: "text", text: "No git diff family." };
        }
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    let stdout = "";
    let stderr = "";
    let approvalAnswered = false;
    const session = runInteractiveSession({
      cliArgs: { bashMode: "ask" },
      workspace,
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
        if (text.includes("Approve bash command") && !approvalAnswered) {
          approvalAnswered = true;
          input.write("p\n");
          input.end();
        }
      },
      onSigint: () => {},
      offSigint: () => {},
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
          } else if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    try {
      // When
      input.write("try git diff prefix approval\n");

      // Then
      await withTimeout(session, 5000, "git diff prefix denial did not finish");
      expect(stdout).toBe("No git diff family.\n");
      expect(stderr).not.toContain(
        "[p] allow command family for session: git diff",
      );
      expect(secondTurnMessages).toContainEqual({
        role: "tool",
        toolCallId: "git_diff_no_index",
        content: expect.stringContaining("User did not approve this command."),
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a resumed session previously approved bash for the session,
    When the assistant repeats the command after resume,
    Then the command runs without another approval prompt`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-interactive-bash-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const command =
      "node -e \"require('node:fs').appendFileSync('runs.txt', 'x')\"";
    const session = createSessionStore({
      sessionId: "bash-approval-resume",
      workspace,
      runtime: {
        env: (key) => (key === "KEEL_HOME" ? home : undefined),
        now: () => 0,
      },
    });
    let persistedMessages: readonly Message[] = session.messages;
    let firstApprovalPrompts = 0;
    const firstInput = new PassThrough();
    const firstProvider = createFakeProvider([
      fakeToolResponse("bash", { command }),
      fakeResponse("First run done."),
    ]);
    const firstSession = runInteractiveSession({
      cliArgs: { bashMode: "ask" },
      workspace,
      platform: process.platform,
      initialMessages: session.messages,
      initialQueuedInputs: session.pendingInputs,
      initialBashApprovalGrants: session.bashApprovalGrants,
      input: firstInput,
      writeStdout: () => {},
      writeStderr: (text) => {
        if (text.includes("Approve bash command")) {
          firstApprovalPrompts++;
          firstInput.write("s\n");
          firstInput.end();
        }
      },
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => ({
        provider: firstProvider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
      persistSessionMessages: (messages, reason, consumedInputIds) => {
        persistedMessages = persistSessionMessages({
          session,
          previousMessages: persistedMessages,
          currentMessages: messages,
          runtime: {
            env: (key) => (key === "KEEL_HOME" ? home : undefined),
            now: () => 1,
          },
          reason,
          consumedInputIds,
        });
      },
      persistBashApprovalGrant: (grant) => {
        persistSessionBashApprovalGrant({
          session,
          grant,
          runtime: {
            env: (key) => (key === "KEEL_HOME" ? home : undefined),
            now: () => 2,
          },
        });
      },
    });

    try {
      firstInput.write("run once\n");
      await firstSession;

      const resumedSession = resumeSessionStore({
        sessionId: "bash-approval-resume",
        workspace,
        runtime: {
          env: (key) => (key === "KEEL_HOME" ? home : undefined),
          now: () => 3,
        },
      });
      let secondApprovalPrompts = 0;
      const secondInput = new PassThrough();
      const secondProvider = createFakeProvider([
        fakeToolResponse("bash", { command }),
        fakeResponse("Second run done."),
      ]);
      const secondSession = runInteractiveSession({
        cliArgs: { bashMode: "ask" },
        workspace,
        platform: process.platform,
        initialMessages: resumedSession.messages,
        initialQueuedInputs: resumedSession.pendingInputs,
        initialBashApprovalGrants: resumedSession.bashApprovalGrants,
        input: secondInput,
        writeStdout: () => {},
        writeStderr: (text) => {
          if (text.includes("Approve bash command")) {
            secondApprovalPrompts++;
          }
        },
        onSigint: () => {},
        offSigint: () => {},
        setExitCode: () => {},
        forceExit: (code) => {
          throw new ForcedExit(code);
        },
        resolveProvider: () => ({
          provider: secondProvider,
          providerId: "fake",
          model: "fake",
          costModel: ZERO_COST_MODEL,
        }),
        requireKnownCostModel: () => ZERO_COST_MODEL,
        printAgentEvents: async (stream) => {
          let finalEnd:
            | Extract<AgentEvent, { readonly type: "end" }>
            | undefined;
          for await (const event of stream) {
            if (event.type === "end") {
              finalEnd = event;
            }
          }
          return finalEnd;
        },
        formatCostReport: () => "",
        persistBashApprovalGrant: (grant) => {
          persistSessionBashApprovalGrant({
            session: resumedSession,
            grant,
            runtime: {
              env: (key) => (key === "KEEL_HOME" ? home : undefined),
              now: () => 4,
            },
          });
        },
      });

      // When
      secondInput.write("run again\n");
      secondInput.end();

      // Then
      await withTimeout(
        secondSession,
        5000,
        "resumed approved command did not finish",
      );
      expect(firstApprovalPrompts).toBe(1);
      expect(secondApprovalPrompts).toBe(0);
      expect(await readFile(join(workspace, "runs.txt"), "utf8")).toBe("xx");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a resumed session previously approved a bash command family,
    When the assistant runs a matching command after resume,
    Then the command family runs without another approval prompt`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-interactive-bash-"));
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));
    const firstCommand = "git status --short";
    const secondCommand = "git status --porcelain";
    const session = createSessionStore({
      sessionId: "bash-prefix-approval-resume",
      workspace,
      runtime: {
        env: (key) => (key === "KEEL_HOME" ? home : undefined),
        now: () => 0,
      },
    });
    let persistedMessages: readonly Message[] = session.messages;
    let firstApprovalPrompts = 0;
    const firstInput = new PassThrough();
    const firstProvider = createFakeProvider([
      fakeToolResponse("bash", { command: firstCommand }),
      fakeResponse("First status done."),
    ]);
    const firstSession = runInteractiveSession({
      cliArgs: { bashMode: "ask" },
      workspace,
      platform: process.platform,
      initialMessages: session.messages,
      initialQueuedInputs: session.pendingInputs,
      initialBashApprovalGrants: session.bashApprovalGrants,
      input: firstInput,
      writeStdout: () => {},
      writeStderr: (text) => {
        if (text.includes("Approve bash command")) {
          firstApprovalPrompts++;
          firstInput.write("p\n");
          firstInput.end();
        }
      },
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => ({
        provider: firstProvider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
      persistSessionMessages: (messages, reason, consumedInputIds) => {
        persistedMessages = persistSessionMessages({
          session,
          previousMessages: persistedMessages,
          currentMessages: messages,
          runtime: {
            env: (key) => (key === "KEEL_HOME" ? home : undefined),
            now: () => 1,
          },
          reason,
          consumedInputIds,
        });
      },
      persistBashApprovalGrant: (grant) => {
        persistSessionBashApprovalGrant({
          session,
          grant,
          runtime: {
            env: (key) => (key === "KEEL_HOME" ? home : undefined),
            now: () => 2,
          },
        });
      },
    });

    try {
      execFileSync("git", ["init", "--quiet"], { cwd: workspace });
      firstInput.write("check status\n");
      await firstSession;

      const resumedSession = resumeSessionStore({
        sessionId: "bash-prefix-approval-resume",
        workspace,
        runtime: {
          env: (key) => (key === "KEEL_HOME" ? home : undefined),
          now: () => 3,
        },
      });
      let secondApprovalPrompts = 0;
      const secondInput = new PassThrough();
      const secondProvider = createFakeProvider([
        fakeToolResponse("bash", { command: secondCommand }),
        fakeResponse("Second status done."),
      ]);
      const secondSession = runInteractiveSession({
        cliArgs: { bashMode: "ask" },
        workspace,
        platform: process.platform,
        initialMessages: resumedSession.messages,
        initialQueuedInputs: resumedSession.pendingInputs,
        initialBashApprovalGrants: resumedSession.bashApprovalGrants,
        input: secondInput,
        writeStdout: () => {},
        writeStderr: (text) => {
          if (text.includes("Approve bash command")) {
            secondApprovalPrompts++;
          }
        },
        onSigint: () => {},
        offSigint: () => {},
        setExitCode: () => {},
        forceExit: (code) => {
          throw new ForcedExit(code);
        },
        resolveProvider: () => ({
          provider: secondProvider,
          providerId: "fake",
          model: "fake",
          costModel: ZERO_COST_MODEL,
        }),
        requireKnownCostModel: () => ZERO_COST_MODEL,
        printAgentEvents: async (stream) => {
          let finalEnd:
            | Extract<AgentEvent, { readonly type: "end" }>
            | undefined;
          for await (const event of stream) {
            if (event.type === "end") {
              finalEnd = event;
            }
          }
          return finalEnd;
        },
        formatCostReport: () => "",
      });

      // When
      secondInput.write("check status again\n");
      secondInput.end();

      // Then
      await withTimeout(
        secondSession,
        5000,
        "resumed approved command family did not finish",
      );
      expect(firstApprovalPrompts).toBe(1);
      expect(secondApprovalPrompts).toBe(0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given an interactive user approves bash once,
    When the assistant repeats the same command,
    Then the session asks for approval again`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-interactive-bash-"));
    const command =
      "node -e \"require('node:fs').appendFileSync('runs.txt', 'x')\"";
    const provider = createFakeProvider([
      fakeToolResponse("bash", { command }),
      fakeToolResponse("bash", { command }),
      fakeResponse("Ran twice."),
    ]);
    const input = new PassThrough();
    let stderr = "";
    let approvalPrompts = 0;
    const session = runInteractiveSession({
      cliArgs: { bashMode: "ask" },
      workspace,
      platform: process.platform,
      input,
      writeStdout: () => {},
      writeStderr: (text) => {
        stderr += text;
        if (text.includes("Approve bash command")) {
          approvalPrompts++;
          queueMicrotask(() => {
            input.write("y\n");
            if (approvalPrompts === 2) {
              input.end();
            }
          });
        }
      },
      onSigint: () => {},
      offSigint: () => {},
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
          if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    try {
      // When
      input.write("run twice\n");

      // Then
      await session;
      expect(await readFile(join(workspace, "runs.txt"), "utf8")).toBe("xx");
      expect(stderr.match(/Approve bash command/g)).toHaveLength(2);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an interactive bash approval receives an empty answer,
    When the command is denied,
    Then the model receives a no-response denial`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-interactive-bash-"));
    const command =
      "node -e \"require('node:fs').writeFileSync('created.txt', 'changed')\"";
    let secondTurnMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        if (options.messages.length === 1) {
          yield {
            type: "tool_call",
            id: "empty_approval_bash",
            tool: "bash",
            command,
          };
        } else {
          secondTurnMessages = options.messages;
          yield { type: "text", text: "No approval." };
        }
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    let stdout = "";
    let answered = false;
    const session = runInteractiveSession({
      cliArgs: { bashMode: "ask" },
      workspace,
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        if (text.includes("Approve bash command") && !answered) {
          answered = true;
          input.write("\n");
          input.end();
        }
      },
      onSigint: () => {},
      offSigint: () => {},
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
          } else if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    try {
      // When
      input.write("run shell\n");

      // Then
      await session;
      await expect(
        readFile(join(workspace, "created.txt"), "utf8"),
      ).rejects.toThrow("ENOENT");
      expect(stdout).toBe("No approval.\n");
      expect(secondTurnMessages).toContainEqual({
        role: "tool",
        toolCallId: "empty_approval_bash",
        content: expect.stringContaining("No approval response provided."),
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an interactive bash approval prompt is waiting,
    When user interrupts the active turn,
    Then the approval is denied without waiting for another input line`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-interactive-bash-"));
    const command =
      "node -e \"require('node:fs').writeFileSync('created.txt', 'changed')\"";
    const provider = createFakeProvider([
      fakeToolResponse("bash", { command }),
      fakeResponse("Interrupted approval."),
    ]);
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "ask" },
      workspace,
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
        if (text.includes("Approve bash command")) {
          queueMicrotask(() => {
            for (const handler of [...sigintHandlers]) {
              handler();
            }
            input.end();
          });
        }
      },
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
          } else if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    try {
      // When
      input.write("run shell\n");

      // Then
      await withTimeout(session, 5000, "approval did not stop after SIGINT");
      await expect(
        readFile(join(workspace, "created.txt"), "utf8"),
      ).rejects.toThrow("ENOENT");
      expect(stdout).toBe("Interrupted approval.\n");
      expect(stderr).toContain("Approve bash command");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a bash approval signal is already aborted,
    When the approval reader starts waiting,
    Then the command is denied without consuming another input line`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-interactive-bash-"));
    const command =
      "node -e \"require('node:fs').writeFileSync('created.txt', 'changed')\"";
    const provider = createFakeProvider([
      fakeToolResponse("bash", { command }),
      fakeResponse("Approval already aborted."),
    ]);
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "ask" },
      workspace,
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        if (text.includes("Approve bash command")) {
          for (const handler of [...sigintHandlers]) {
            handler();
          }
          input.end();
        }
      },
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
          } else if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    try {
      // When
      input.write("run shell\n");

      // Then
      await withTimeout(session, 5000, "approval did not stop after abort");
      await expect(
        readFile(join(workspace, "created.txt"), "utf8"),
      ).rejects.toThrow("ENOENT");
      expect(stdout).toBe("Approval already aborted.\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given stdin closes before bash approval can be answered,
    When the command asks for permission,
    Then the command is denied as interrupted input`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-interactive-bash-"));
    const command =
      "node -e \"require('node:fs').writeFileSync('created.txt', 'changed')\"";
    let startFirstTurn: () => void = () => {};
    let allowToolCall: () => void = () => {};
    const firstTurnStarted = new Promise<void>((resolve) => {
      startFirstTurn = resolve;
    });
    const toolCallAllowed = new Promise<void>((resolve) => {
      allowToolCall = resolve;
    });
    const input = new PassThrough();
    const inputEnded = new Promise<void>((resolve) => {
      input.once("end", () => {
        resolve();
      });
    });
    let secondTurnMessages: readonly Message[] = [];
    let turn = 0;
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        turn++;
        if (turn === 1) {
          startFirstTurn();
          await toolCallAllowed;
          yield {
            type: "tool_call",
            id: "closed_approval_bash",
            tool: "bash",
            command,
          };
        } else {
          secondTurnMessages = options.messages;
          yield { type: "text", text: "Closed approval." };
        }
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    let stdout = "";
    let stderr = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "ask" },
      workspace,
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: () => {},
      offSigint: () => {},
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
          } else if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    try {
      // When
      input.write("run shell\n");
      await withTimeout(firstTurnStarted, 5000, "first turn did not start");
      input.end();
      await withTimeout(inputEnded, 5000, "stdin did not close");
      allowToolCall();

      // Then
      await session;
      await expect(
        readFile(join(workspace, "created.txt"), "utf8"),
      ).rejects.toThrow("ENOENT");
      expect(stdout).toBe("Closed approval.\n");
      expect(stderr).toContain("Approve bash command");
      expect(secondTurnMessages).toContainEqual({
        role: "tool",
        toolCallId: "closed_approval_bash",
        content: expect.stringContaining(
          "Command approval was interrupted or input closed.",
        ),
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a bash approval answer was typed before the prompt,
    When the command asks for permission,
    Then the queued line is not consumed as approval`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-interactive-bash-"));
    const command =
      "node -e \"require('node:fs').writeFileSync('created.txt', 'changed')\"";
    let turn = 0;
    const observedUserContexts: string[][] = [];
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        turn++;
        observedUserContexts.push(
          options.messages
            .filter((message) => message.role === "user")
            .map((message) => message.content),
        );
        if (turn === 1) {
          yield {
            type: "tool_call",
            id: "queued_approval_bash",
            tool: "bash",
            command,
          };
        } else if (turn === 2) {
          yield { type: "text", text: "Denied." };
        } else {
          yield { type: "text", text: "Queued line kept." };
        }
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    let stdout = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "ask" },
      workspace,
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: () => {},
      onSigint: () => {},
      offSigint: () => {},
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
          } else if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    try {
      // When
      input.end("run shell\ns\n");

      // Then
      await session;
      await expect(
        readFile(join(workspace, "created.txt"), "utf8"),
      ).rejects.toThrow("ENOENT");
      expect(stdout).toBe("Denied.\nQueued line kept.\n");
      expect(observedUserContexts).toEqual([
        ["run shell"],
        ["run shell"],
        ["run shell", "s"],
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a user types while an interactive tool turn is running,
    When the assistant continues after the tool result,
    Then the typed message steers the same turn`, async () => {
    // Given
    let turn = 0;
    let steeringWritten = false;
    const observedContexts: Message[][] = [];
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        turn++;
        observedContexts.push([...options.messages]);
        if (turn === 1) {
          yield {
            type: "tool_call",
            id: "interactive_steering_read",
            tool: "read",
            path: "package.json",
            limit: 1,
          };
        } else if (turn === 2) {
          yield { type: "text", text: "Steered." };
        } else {
          yield { type: "text", text: "Queued follow-up." };
        }
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    let stdout = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: () => {},
      onSigint: () => {},
      offSigint: () => {},
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
          if (event.type === "tool_start" && !steeringWritten) {
            steeringWritten = true;
            input.write("focus on scripts\n");
          } else if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
            input.end();
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    // When
    input.write("inspect package\n");

    // Then
    await session;
    expect(stdout).toBe("Steered.\n");
    expect(observedContexts).toEqual([
      [{ role: "user", content: "inspect package" }],
      [
        { role: "user", content: "inspect package" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "interactive_steering_read",
              tool: "read",
              path: "package.json",
              limit: 1,
            },
          ],
        },
        expect.objectContaining({
          role: "tool",
          toolCallId: "interactive_steering_read",
        }),
        { role: "user", content: "focus on scripts" },
      ],
    ]);
  });

  test(`Given user enters /compact while an interactive tool turn is running,
    When the assistant continues after the tool result,
    Then the compact command is deferred instead of injected as steering`, async () => {
    // Given
    const focusInstruction = "keep the tool result and next action";
    let turn = 0;
    let compactWritten = false;
    const observedContexts: Message[][] = [];
    let summaryPrompt = "";
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        if (options.toolChoice === "none") {
          summaryPrompt = options.messages[0]?.content ?? "";
          yield { type: "text", text: "Deferred compact summary." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        turn++;
        observedContexts.push(structuredClone([...options.messages]));
        if (turn === 1) {
          yield {
            type: "tool_call",
            id: "deferred_compact_read",
            tool: "read",
            path: "package.json",
            limit: 1,
          };
        } else if (turn === 2) {
          yield { type: "text", text: "Tool turn done." };
        } else {
          yield { type: "text", text: "After compact done." };
        }
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    let stdout = "";
    let stderr = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
        contextCompaction: { keepRecentTokens: 1 },
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "tool_start" && !compactWritten) {
            compactWritten = true;
            input.write(`/compact ${focusInstruction}\n`);
            input.end("after compact\n");
          } else if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    // When
    input.write("inspect package\n");

    // Then
    await session;
    expect(stdout).toBe("Tool turn done.\nAfter compact done.\n");
    expect(stderr).toContain("Context compacted: manual");
    expect(summaryPrompt).toContain(focusInstruction);
    expect(summaryPrompt).not.toContain("/compact");
    expect(observedContexts[1]).toEqual([
      { role: "user", content: "inspect package" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "deferred_compact_read",
            tool: "read",
            path: "package.json",
            limit: 1,
          },
        ],
      },
      expect.objectContaining({
        role: "tool",
        toolCallId: "deferred_compact_read",
      }),
    ]);
    expect(JSON.stringify(observedContexts[1])).not.toContain("/compact");
    expect(observedContexts[2]).toEqual([
      {
        role: "user",
        content: expect.stringContaining("<conversation-checkpoint>"),
      },
      { role: "assistant", content: "Tool turn done.", toolCalls: [] },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          expect.objectContaining({
            id: "post_compaction_read_0",
            tool: "read",
            path: expect.stringContaining("package.json"),
            limit: 1,
          }),
        ],
      },
      expect.objectContaining({
        role: "tool",
        toolCallId: "post_compaction_read_0",
        content: expect.stringContaining(
          "Read output stopped at requested limit of 1 lines",
        ),
      }),
      { role: "user", content: "after compact" },
    ]);
    expect(JSON.stringify(observedContexts[2])).not.toContain("/compact");
  });

  test(`Given user enters /help while an interactive tool turn is running,
    When the assistant continues after the tool result,
    Then the help command is deferred instead of injected as steering`, async () => {
    // Given
    let turn = 0;
    let helpWritten = false;
    const observedContexts: Message[][] = [];
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        turn++;
        observedContexts.push(structuredClone([...options.messages]));
        if (turn === 1) {
          yield {
            type: "tool_call",
            id: "deferred_help_read",
            tool: "read",
            path: "package.json",
            limit: 1,
          };
        } else if (turn === 2) {
          yield { type: "text", text: "Tool turn done." };
        } else {
          yield { type: "text", text: "After help done." };
        }
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    let stdout = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: () => {},
      onSigint: () => {},
      offSigint: () => {},
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
          if (event.type === "tool_start" && !helpWritten) {
            helpWritten = true;
            input.write("/help\n");
            input.end("after help\n");
          } else if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    // When
    input.write("inspect package\n");

    // Then
    await session;
    expect(stdout).toContain("Tool turn done.\n");
    expect(stdout).toContain("Interactive commands:");
    expect(stdout).toContain("After help done.\n");
    expect(observedContexts[1]).toEqual([
      { role: "user", content: "inspect package" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "deferred_help_read",
            tool: "read",
            path: "package.json",
            limit: 1,
          },
        ],
      },
      expect.objectContaining({
        role: "tool",
        toolCallId: "deferred_help_read",
      }),
    ]);
    expect(observedContexts[2]).toContainEqual({
      role: "user",
      content: "after help",
    });
    expect(JSON.stringify(observedContexts)).not.toContain("/help");
  });

  test(`Given user enters /fork while an interactive tool turn is running,
    When the assistant continues after the tool result,
    Then the fork command is deferred instead of injected as steering`, async () => {
    // Given
    let turn = 0;
    let forkWritten = false;
    const observedContexts: Message[][] = [];
    let forkTarget = "";
    let forkBeforeMessageId: string | undefined;
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        turn++;
        observedContexts.push(structuredClone([...options.messages]));
        if (turn === 1) {
          yield {
            type: "tool_call",
            id: "deferred_fork_read",
            tool: "read",
            path: "package.json",
            limit: 1,
          };
        } else if (turn === 2) {
          yield { type: "text", text: "Tool turn done." };
        } else {
          yield { type: "text", text: "After fork done." };
        }
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    let stdout = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: () => {},
      onSigint: () => {},
      offSigint: () => {},
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
          if (event.type === "tool_start" && !forkWritten) {
            forkWritten = true;
            input.write("/fork target --before-message msg_beta\n");
            input.end("after fork\n");
          } else if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
      forkSession: (request) => {
        forkTarget = request.targetSessionId;
        forkBeforeMessageId = request.beforeMessageId;
        return 'Forked session "source" to "target" before message msg_beta.\nresume: keel --resume target\n';
      },
    });

    // When
    input.write("inspect package\n");

    // Then
    await session;
    expect(stdout).toBe(
      [
        "Tool turn done.",
        'Forked session "source" to "target" before message msg_beta.',
        "resume: keel --resume target",
        "After fork done.",
        "",
      ].join("\n"),
    );
    expect(forkTarget).toBe("target");
    expect(forkBeforeMessageId).toBe("msg_beta");
    expect(observedContexts[1]).toEqual([
      { role: "user", content: "inspect package" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "deferred_fork_read",
            tool: "read",
            path: "package.json",
            limit: 1,
          },
        ],
      },
      expect.objectContaining({
        role: "tool",
        toolCallId: "deferred_fork_read",
      }),
    ]);
    expect(observedContexts[2]).toContainEqual({
      role: "user",
      content: "after fork",
    });
    expect(JSON.stringify(observedContexts)).not.toContain("/fork");
  });

  test(`Given queued input exists before a deferred compact command,
    When more input arrives before a later steering drain,
    Then all deferred lines are replayed in original order`, async () => {
    // Given
    const focusInstruction = "keep queued order and tool results";
    let turn = 0;
    let firstCompactWritten = false;
    let laterInputWritten = false;
    const observedContexts: Message[][] = [];
    let summaryPrompt = "";
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        if (options.toolChoice === "none") {
          summaryPrompt = options.messages[0]?.content ?? "";
          yield { type: "text", text: "Ordered deferred compact summary." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        turn++;
        observedContexts.push(structuredClone([...options.messages]));
        if (turn === 1) {
          yield {
            type: "tool_call",
            id: "ordered_deferred_first_read",
            tool: "read",
            path: "package.json",
            limit: 1,
          };
        } else if (turn === 2) {
          yield {
            type: "tool_call",
            id: "ordered_deferred_second_read",
            tool: "read",
            path: "tsconfig.json",
            limit: 1,
          };
        } else if (turn === 3) {
          yield { type: "text", text: "Tool turn done." };
        } else {
          const lastUserMessage = options.messages.findLast(
            (message) => message.role === "user",
          );
          yield {
            type: "text",
            text:
              lastUserMessage?.content === "queued before compact"
                ? "Queued before compact done."
                : "After compact done.",
          };
        }
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    let stdout = "";
    let stderr = "";
    input.write("inspect package\nqueued before compact\n");
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
        contextCompaction: { keepRecentTokens: 1 },
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (
            event.type === "tool_start" &&
            event.toolCall.id === "ordered_deferred_first_read" &&
            !firstCompactWritten
          ) {
            firstCompactWritten = true;
            input.write(`/compact ${focusInstruction}\n`);
          } else if (
            event.type === "tool_start" &&
            event.toolCall.id === "ordered_deferred_second_read" &&
            !laterInputWritten
          ) {
            laterInputWritten = true;
            input.end("after compact\n");
          } else if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    // When the queued input and active-turn compact command are processed

    // Then
    await session;
    expect(stdout).toBe(
      "Tool turn done.\nQueued before compact done.\nAfter compact done.\n",
    );
    expect(stderr).toContain("Context compacted: manual");
    expect(summaryPrompt).toContain(focusInstruction);
    expect(summaryPrompt).not.toContain("/compact");
    expect(summaryPrompt).not.toContain("after compact");
    expect(JSON.stringify(observedContexts[2])).not.toContain("/compact");
    expect(JSON.stringify(observedContexts[2])).not.toContain("after compact");
    expect(JSON.stringify(observedContexts[2])).not.toContain(
      "queued before compact",
    );
    expect(observedContexts[3]?.at(-1)).toEqual({
      role: "user",
      content: "queued before compact",
    });
    expect(observedContexts[4]?.at(-1)).toEqual({
      role: "user",
      content: "after compact",
    });
    expect(JSON.stringify(observedContexts[4])).not.toContain("/compact");
  });

  test(`Given an interactive steering message was injected into an interrupted turn,
    When the turn is cancelled,
    Then the steering message becomes the next prompt`, async () => {
    // Given
    let turn = 0;
    let steeringWritten = false;
    const observedUserContexts: string[][] = [];
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        turn++;
        observedUserContexts.push(
          options.messages
            .filter((message) => message.role === "user")
            .map((message) => message.content),
        );
        if (turn === 1) {
          yield {
            type: "tool_call",
            id: "interrupted_steering_read",
            tool: "read",
            path: "package.json",
            limit: 1,
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        if (turn === 2) {
          yield { type: "text", text: "Working" };
          if (!options.signal.aborted) {
            await new Promise<void>((resolve) => {
              options.signal.addEventListener("abort", () => resolve(), {
                once: true,
              });
            });
          }
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        yield { type: "text", text: "Restored prompt." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
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
          if (event.type === "tool_start" && !steeringWritten) {
            steeringWritten = true;
            input.write("focus on scripts\n");
          } else if (event.type === "text") {
            stdout += event.text;
            if (event.text === "Working") {
              for (const handler of [...sigintHandlers]) {
                handler();
              }
            }
          } else if (event.type === "end") {
            finalEnd = event;
            if (turn >= 3) {
              input.end();
            }
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    // When
    input.write("inspect package\n");

    // Then
    await withTimeout(session, 5000, "interrupted steering was not restored");
    expect(stdout).toBe("Working\nRestored prompt.\n");
    expect(observedUserContexts).toEqual([
      ["inspect package"],
      ["inspect package", "focus on scripts"],
      ["focus on scripts"],
    ]);
  });

  test(`Given an interactive steering message is queued before steering can be drained,
    When the tool turn is cancelled,
    Then the queued message becomes the next prompt`, async () => {
    // Given
    let turn = 0;
    let abortQueued = false;
    const observedUserContexts: string[][] = [];
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        turn++;
        observedUserContexts.push(
          options.messages
            .filter((message) => message.role === "user")
            .map((message) => message.content),
        );
        if (turn === 1) {
          yield {
            type: "tool_call",
            id: "abort_before_drain_bash",
            tool: "bash",
            command: 'node -e "setTimeout(() => {}, 10000)"',
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        yield { type: "text", text: "Queued prompt restored." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "trusted" },
      workspace: process.cwd(),
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
          if (event.type === "tool_start" && !abortQueued) {
            abortQueued = true;
            input.write("queued after abort\n");
            for (const handler of [...sigintHandlers]) {
              handler();
            }
          } else if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
            if (turn >= 2) {
              input.end();
            }
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    // When
    input.write("run then abort\n");

    // Then
    await withTimeout(session, 5000, "queued prompt was not replayed");
    expect(stdout).toBe("\nQueued prompt restored.\n");
    expect(observedUserContexts).toEqual([
      ["run then abort"],
      ["queued after abort"],
    ]);
  });

  test(`Given multiple interrupted steering batches are restored,
    When later prompts continue,
    Then pending prompts keep their original order`, async () => {
    // Given
    let streamCall = 0;
    let toolStarts = 0;
    const observedUserContexts: string[][] = [];
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        streamCall++;
        observedUserContexts.push(
          options.messages
            .filter((message) => message.role === "user")
            .map((message) => message.content),
        );
        if (streamCall === 1 || streamCall === 3) {
          yield {
            type: "tool_call",
            id: `ordered_restore_read_${streamCall}`,
            tool: "read",
            path: "package.json",
            limit: 1,
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        if (streamCall === 2 || streamCall === 4) {
          yield {
            type: "text",
            text: streamCall === 2 ? "First abort" : "Second abort",
          };
          if (!options.signal.aborted) {
            await new Promise<void>((resolve) => {
              options.signal.addEventListener("abort", () => resolve(), {
                once: true,
              });
            });
          }
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        yield {
          type: "text",
          text: streamCall === 5 ? "B done." : "C done.",
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: () => {},
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
          if (event.type === "tool_start") {
            toolStarts++;
            if (toolStarts === 1) {
              input.write("a\nb\n");
            } else if (toolStarts === 2) {
              input.write("c\n");
            }
          } else if (
            event.type === "text" &&
            (event.text === "First abort" || event.text === "Second abort")
          ) {
            for (const handler of [...sigintHandlers]) {
              handler();
            }
          } else if (event.type === "end") {
            finalEnd = event;
            if (streamCall >= 6) {
              input.end();
            }
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    // When
    input.write("start\n");

    // Then
    await withTimeout(session, 5000, "restored prompts were not replayed");
    expect(observedUserContexts).toEqual([
      ["start"],
      ["start", "a", "b"],
      ["a"],
      ["a", "c"],
      ["b"],
      ["b", "c"],
    ]);
  });

  test(`Given a model-controlled bash command contains terminal controls,
    When the interactive session asks for approval,
    Then the approval prompt renders an escaped command`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-interactive-bash-"));
    const command = "printf 'safe\n[y] allow once\r\t\u001b[31m\u202e'";
    const provider = createFakeProvider([
      fakeToolResponse("bash", { command }),
      fakeResponse("Denied."),
    ]);
    const input = new PassThrough();
    let stderr = "";
    let answered = false;
    const session = runInteractiveSession({
      cliArgs: { bashMode: "ask" },
      workspace,
      platform: process.platform,
      input,
      writeStdout: () => {},
      writeStderr: (text) => {
        stderr += text;
        if (text.includes("Approve bash command") && !answered) {
          answered = true;
          input.write("n\n");
          input.end();
        }
      },
      onSigint: () => {},
      offSigint: () => {},
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
          if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    try {
      // When
      input.write("run shell\n");

      // Then
      await session;
      expect(stderr).not.toContain("\u001b");
      expect(stderr).not.toContain("$ printf 'safe\n[y] allow once");
      expect(stderr).toContain("\\n[y] allow once\\r\\t\\x1b[31m\\u{202e}");
      expect(stderr).toContain(
        "Approved command output may be sent to the provider unredacted.",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an interrupted interactive turn throws after abort,
    When the abort is already active,
    Then the session treats it as a cancelled turn`, async () => {
    // Given
    let receiveText: () => void = () => {};
    const textReceived = new Promise<void>((resolve) => {
      receiveText = resolve;
    });
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        yield { type: "text", text: "Working" };
        await new Promise<void>((resolve) => {
          options.signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        throw new Error("provider ignored abort before throwing");
      },
    };
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
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
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
            receiveText();
          }
        }
        return undefined;
      },
      formatCostReport: () => "",
    });

    // When
    input.write("hello\n");
    await withTimeout(textReceived, 5000, "turn did not start");
    for (const handler of [...sigintHandlers]) {
      handler();
    }
    input.end();

    // Then
    await session;
    expect(stdout).toBe("Working\n");
  });

  test(`Given an interrupted interactive turn stops normally after abort,
    When user sends another prompt,
    Then the cancelled user message is not kept in context`, async () => {
    // Given
    let receiveFirstText: () => void = () => {};
    const firstTextReceived = new Promise<void>((resolve) => {
      receiveFirstText = resolve;
    });
    const observedUserContexts: string[][] = [];
    let turn = 0;
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        turn++;
        observedUserContexts.push(
          options.messages
            .filter((message) => message.role === "user")
            .map((message) => message.content),
        );
        if (turn === 1) {
          yield { type: "text", text: "Cancel me" };
          await new Promise<void>((resolve) => {
            options.signal.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        yield { type: "text", text: "Second done" };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
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
              receiveFirstText();
            }
          } else if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    // When
    input.write("first prompt\n");
    await withTimeout(firstTextReceived, 5000, "first turn did not start");
    for (const handler of [...sigintHandlers]) {
      handler();
    }
    input.write("second prompt\n");
    input.end();

    // Then
    await session;
    expect(stdout).toBe("Cancel me\nSecond done\n");
    expect(observedUserContexts).toEqual([["first prompt"], ["second prompt"]]);
  });

  test(`Given an interrupted interactive turn exposed scoped project instructions,
    When the next prompt mutates the same scoped path,
    Then the cancelled visibility is not reused`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-interactive-scoped-abort-"),
    );
    await mkdir(join(workspace, "packages", "api", "src"), {
      recursive: true,
    });
    await writeFile(
      join(workspace, "packages", "api", "AGENTS.md"),
      "API rule: retry writes must still review this after abort.\n",
      "utf8",
    );
    const targetPath = join(workspace, "packages", "api", "src", "new.ts");
    let request = 0;
    let workingSeen: () => void = () => {};
    const workingReceived = new Promise<void>((resolve) => {
      workingSeen = resolve;
    });
    let finalMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        request++;
        if (request === 1) {
          yield {
            type: "tool_call",
            id: "initial_write",
            tool: "write",
            path: "packages/api/src/new.ts",
            content: "export const value = 1;\n",
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        if (request === 2) {
          yield { type: "text", text: "Working" };
          if (!options.signal.aborted) {
            await new Promise<void>((resolve) => {
              options.signal.addEventListener("abort", () => resolve(), {
                once: true,
              });
            });
          }
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        if (request === 3) {
          yield {
            type: "tool_call",
            id: "retry_write",
            tool: "write",
            path: "packages/api/src/new.ts",
            content: "export const value = 1;\n",
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        finalMessages = options.messages;
        yield { type: "text", text: "Still blocked." };
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
            if (event.text === "Working") {
              workingSeen();
              for (const handler of [...sigintHandlers]) {
                handler();
              }
              input.write("retry create\n");
            }
            if (event.text === "Still blocked.") {
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
      // When
      input.write("create then cancel\n");
      await withTimeout(workingReceived, 5000, "interrupted turn did not run");

      // Then
      await session;
      const retryMessage = finalMessages.find(
        (message) =>
          message.role === "tool" && message.toolCallId === "retry_write",
      );
      expect(retryMessage?.content).toContain(
        "Project instructions from packages/api/AGENTS.md",
      );
      expect(retryMessage?.content).toContain(
        "API rule: retry writes must still review this after abort.",
      );
      expect(await fileExists(targetPath)).toBe(false);
      expect(stdout).toBe("Working\nStill blocked.\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given scoped project instructions were visible before an interrupted turn stops,
    When the next prompt mutates the same scoped path,
    Then the pre-turn visibility is still available`, async () => {
    await expectInterruptedTurnPreservesVisibleScopedInstructions("stop");
  });

  test(`Given scoped project instructions were visible before an interrupted turn throws,
    When the next prompt mutates the same scoped path,
    Then the pre-turn visibility is still available`, async () => {
    await expectInterruptedTurnPreservesVisibleScopedInstructions("throw");
  });

  test(`Given multiple scoped project instructions were visible before an interrupted turn,
    When the next prompt compacts context,
    Then restored instruction visibility keeps most-recent-first order`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-interactive-scoped-order-abort-"),
    );
    await mkdir(join(workspace, "packages", "ui", "src"), { recursive: true });
    await mkdir(join(workspace, "packages", "api", "src"), {
      recursive: true,
    });
    await writeFile(
      join(workspace, "packages", "ui", "AGENTS.md"),
      "UI rule: restored order keeps this second.\n",
      "utf8",
    );
    await writeFile(
      join(workspace, "packages", "api", "AGENTS.md"),
      "API rule: restored order keeps this first.\n",
      "utf8",
    );
    let actualRequest = 0;
    let receiveSetupReady: () => void = () => {};
    let receiveCancelText: () => void = () => {};
    const setupReady = new Promise<void>((resolve) => {
      receiveSetupReady = resolve;
    });
    const cancelTextReceived = new Promise<void>((resolve) => {
      receiveCancelText = resolve;
    });
    let postAbortMessages: readonly Message[] = [];
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        if (options.toolChoice === "none") {
          yield { type: "text", text: "Summary before retry." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        actualRequest++;
        if (actualRequest === 1) {
          yield {
            type: "tool_call",
            id: "ui_write",
            tool: "write",
            path: "packages/ui/src/new.ts",
            content: "export const value = 1;\n",
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        if (actualRequest === 2) {
          yield {
            type: "tool_call",
            id: "api_write",
            tool: "write",
            path: "packages/api/src/new.ts",
            content: "export const value = 1;\n",
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        if (actualRequest === 3) {
          yield { type: "text", text: "Setup ready" };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        if (actualRequest === 4) {
          yield { type: "text", text: "Cancel me" };
          if (!options.signal.aborted) {
            await new Promise<void>((resolve) => {
              options.signal.addEventListener("abort", () => resolve(), {
                once: true,
              });
            });
          }
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        postAbortMessages = structuredClone([...options.messages]);
        yield { type: "text", text: "Done" };
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
        contextCompaction: {
          contextWindowTokens: 10_000,
          reserveTokens: 0,
          keepRecentTokens: 1,
        },
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
            if (event.text === "Setup ready") {
              receiveSetupReady();
            }
            if (event.text === "Cancel me") {
              receiveCancelText();
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
      // When
      input.write("surface scoped instructions\n");
      await withTimeout(setupReady, 5000, "scoped setup turn did not finish");
      input.write("cancel turn\n");
      await withTimeout(cancelTextReceived, 5000, "cancel turn did not start");
      for (const handler of [...sigintHandlers]) {
        handler();
      }
      input.write(`${"retry after abort ".repeat(4000)}\n`);
      input.end();

      // Then
      await withTimeout(session, 5000, "session did not finish");
      const restoredInstructionPaths = postAbortMessages
        .flatMap((message) =>
          message.role === "assistant" ? message.toolCalls : [],
        )
        .filter(
          (toolCall) =>
            toolCall.tool === "read" &&
            "path" in toolCall &&
            typeof toolCall.path === "string" &&
            toolCall.path.endsWith("/AGENTS.md"),
        )
        .map((toolCall) => ("path" in toolCall ? toolCall.path : ""));
      expect(restoredInstructionPaths).toEqual([
        "packages/api/AGENTS.md",
        "packages/ui/AGENTS.md",
      ]);
      expect(stdout).toContain("Setup ready");
      expect(stdout).toContain("Cancel me");
      expect(stdout).toContain("Done");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an interactive turn compacts context before it is interrupted,
    When user sends another prompt,
    Then the session restores the pre-turn history and drops the cancelled prompt`, async () => {
    // Given
    let receiveCancelText: () => void = () => {};
    const cancelTextReceived = new Promise<void>((resolve) => {
      receiveCancelText = resolve;
    });
    let receiveFirstEnd: () => void = () => {};
    const firstTurnEnded = new Promise<void>((resolve) => {
      receiveFirstEnd = resolve;
    });
    const cancelledPrompt = `cancelled prompt ${"x".repeat(50_000)}`;
    const observedRequestContexts: Message[][] = [];
    const compactionPrompts: string[] = [];
    let requestTurn = 0;
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        if (options.toolChoice === "none") {
          const [prompt] = options.messages;
          if (prompt?.role === "user") {
            compactionPrompts.push(prompt.content);
          }
          yield { type: "text", text: "Summary of first turn." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        requestTurn++;
        observedRequestContexts.push(structuredClone([...options.messages]));
        if (requestTurn === 1) {
          yield { type: "text", text: "First done" };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        if (requestTurn === 2) {
          yield { type: "text", text: "Cancel me" };
          if (!options.signal.aborted) {
            await new Promise<void>((resolve) => {
              options.signal.addEventListener("abort", () => resolve(), {
                once: true,
              });
            });
          }
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        yield { type: "text", text: "Third done" };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
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
        contextCompaction: {
          contextWindowTokens: 10_000,
          reserveTokens: 0,
          keepRecentTokens: 1,
        },
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
            if (event.text === "Cancel me") {
              receiveCancelText();
            }
          } else if (event.type === "end") {
            finalEnd = event;
            if (requestTurn === 1) {
              receiveFirstEnd();
            }
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    // When
    input.write("first prompt\n");
    await withTimeout(firstTurnEnded, 5000, "first turn did not finish");
    input.write(`${cancelledPrompt}\n`);
    await withTimeout(cancelTextReceived, 5000, "second turn did not start");
    for (const handler of [...sigintHandlers]) {
      handler();
    }
    input.write("third prompt\n");
    input.end();

    // Then
    await session;
    expect(stdout).toBe("First done\nCancel me\nThird done\n");
    expect(compactionPrompts).toHaveLength(1);
    expect(compactionPrompts[0]).toContain("first prompt");
    expect(compactionPrompts[0]).toContain("First done");
    expect(observedRequestContexts[2]).toEqual([
      { role: "user", content: "first prompt" },
      { role: "assistant", content: "First done", toolCalls: [] },
      { role: "user", content: "third prompt" },
    ]);
  });

  test(`Given an interactive session has prior history,
    When user enters /compact,
    Then the session continues from a manual checkpoint`, async () => {
    // Given
    let receiveFirstEnd: () => void = () => {};
    const firstTurnEnded = new Promise<void>((resolve) => {
      receiveFirstEnd = resolve;
    });
    const observedRequestContexts: Message[][] = [];
    let summaryPrompt = "";
    let requestTurn = 0;
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        if (options.toolChoice === "none") {
          summaryPrompt = options.messages[0]?.content ?? "";
          yield { type: "text", text: "Manual checkpoint summary." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        requestTurn++;
        observedRequestContexts.push(structuredClone([...options.messages]));
        yield {
          type: "text",
          text: requestTurn === 1 ? "First done" : "Second done",
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
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
        contextCompaction: { keepRecentTokens: 1 },
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
            if (requestTurn === 1) {
              receiveFirstEnd();
            }
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    // When
    input.write("first prompt\n");
    await withTimeout(firstTurnEnded, 5000, "first turn did not finish");
    input.write("/compact\n");
    input.write("second prompt\n");
    input.end();

    // Then
    await session;
    expect(stdout).toBe("First done\nSecond done\n");
    expect(stderr).toContain("Context compacted: manual");
    expect(summaryPrompt).toContain("first prompt");
    expect(summaryPrompt).toContain("First done");
    expect(observedRequestContexts[1]).toEqual([
      {
        role: "user",
        content: expect.stringContaining("<conversation-checkpoint>"),
      },
      { role: "user", content: "second prompt" },
    ]);
    expect(observedRequestContexts[1]?.[0]?.content).toContain(
      "Manual checkpoint summary.",
    );
    expect(JSON.stringify(observedRequestContexts[1])).not.toContain(
      "/compact",
    );
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given an interactive session has read a file before manual compaction,
    When user asks for an edit after /compact,
    Then the edit uses a fresh post-compaction read snapshot`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-interactive-compact-"),
    );
    await writeFile(join(workspace, "note.txt"), "hello old world\n", "utf8");
    let receiveFirstEnd: () => void = () => {};
    const firstTurnEnded = new Promise<void>((resolve) => {
      receiveFirstEnd = resolve;
    });
    let editRequestMessages: readonly Message[] = [];
    let requestTurn = 0;
    const provider: LLMProvider = {
      id: "manual-compact-read-restore",
      async *stream(options) {
        if (options.toolChoice === "none") {
          yield { type: "text", text: "Manual checkpoint summary." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        if (requestTurn === 0) {
          requestTurn++;
          yield {
            type: "tool_call",
            id: "read_note",
            tool: "read",
            path: "note.txt",
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        if (requestTurn === 1) {
          requestTurn++;
          yield { type: "text", text: "Read note.txt." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        if (requestTurn === 2) {
          requestTurn++;
          editRequestMessages = options.messages;
          yield {
            type: "tool_call",
            id: "edit_note",
            tool: "edit",
            path: "note.txt",
            edits: [{ oldText: "current", newText: "fresh" }],
          };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        requestTurn++;
        yield { type: "text", text: "Updated note.txt." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace,
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
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
        contextCompaction: { keepRecentTokens: 1 },
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
            if (requestTurn === 2) {
              receiveFirstEnd();
            }
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    try {
      // When
      input.write("read note.txt\n");
      await withTimeout(firstTurnEnded, 5000, "first turn did not finish");
      await writeFile(
        join(workspace, "note.txt"),
        "hello current world\n",
        "utf8",
      );
      input.write("/compact\n");
      input.write("replace the word\n");
      input.end();

      // Then
      await session;
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "hello fresh world\n",
      );
      const restoredReadMessage = editRequestMessages.find(
        (message): message is Extract<Message, { readonly role: "tool" }> =>
          message.role === "tool" &&
          message.content.includes("hello current world"),
      );
      expect(restoredReadMessage?.toolCallId).toContain("post_compaction_read");
      expect(JSON.stringify(editRequestMessages)).not.toContain(
        "hello old world",
      );
      expect(stdout).toBe("Read note.txt.\nUpdated note.txt.\n");
      expect(stderr).toContain("Context compacted: manual");
      expect(sigintHandlers.size).toBe(0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given manual compaction has cost tracking enabled,
    When user enters /compact,
    Then the session prints the compaction cost report`, async () => {
    // Given
    let receiveFirstEnd: () => void = () => {};
    const firstTurnEnded = new Promise<void>((resolve) => {
      receiveFirstEnd = resolve;
    });
    let requestTurn = 0;
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        if (options.toolChoice === "none") {
          yield { type: "text", text: "Costed checkpoint summary." };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 30,
              cachedInputTokens: 0,
              uncachedInputTokens: 30,
              outputTokens: 10,
            },
          };
          return;
        }

        requestTurn++;
        yield { type: "text", text: "First done" };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    let stdout = "";
    let stderr = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled", maxCostUsd: 0.01 },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: {
          type: "fixed",
          uncachedInputPerMillionTokens: 100,
          cachedInputPerMillionTokens: 0,
          outputPerMillionTokens: 200,
        },
      }),
      requireKnownCostModel: () => ({
        type: "fixed",
        uncachedInputPerMillionTokens: 100,
        cachedInputPerMillionTokens: 0,
        outputPerMillionTokens: 200,
      }),
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
            if (requestTurn === 1) {
              receiveFirstEnd();
            }
          }
        }
        return finalEnd;
      },
      formatCostReport: (cost, maxUsd) =>
        `Cost: ${cost.spentUsd.toFixed(6)} / ${maxUsd.toFixed(2)} exceeded=${cost.budgetExceeded}\n`,
    });

    // When
    input.write("first prompt\n");
    await withTimeout(firstTurnEnded, 5000, "first turn did not finish");
    input.write("/compact\n");
    input.end();

    // Then
    await session;
    expect(stdout).toBe("First done\n");
    expect(stderr).toContain("Context compacted: manual");
    expect(stderr).toContain("Cost: 0.005000 / 0.01 exceeded=false\n");
  });

  test(`Given manual compaction runs during a report-only interactive session,
    When user enters /compact,
    Then compaction cost is included without printing a budget report`, async () => {
    // Given
    let receiveFirstEnd: () => void = () => {};
    const firstTurnEnded = new Promise<void>((resolve) => {
      receiveFirstEnd = resolve;
    });
    let requestTurn = 0;
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        if (options.toolChoice === "none") {
          yield { type: "text", text: "Report checkpoint summary." };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 30,
              cachedInputTokens: 0,
              uncachedInputTokens: 30,
              outputTokens: 10,
            },
          };
          return;
        }

        requestTurn++;
        yield { type: "text", text: "First done" };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    let stdout = "";
    let stderr = "";
    const costModel: CostModel = {
      type: "fixed",
      uncachedInputPerMillionTokens: 100,
      cachedInputPerMillionTokens: 0,
      outputPerMillionTokens: 200,
    };
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled", reportFile: "session.json" },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel,
        contextCompaction: { keepRecentTokens: 1 },
      }),
      requireKnownCostModel: () => costModel,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
            if (requestTurn === 1) {
              receiveFirstEnd();
            }
          }
        }
        return finalEnd;
      },
      formatCostReport: (cost, maxUsd) =>
        `Cost: ${cost.spentUsd.toFixed(6)} / ${maxUsd.toFixed(2)} exceeded=${cost.budgetExceeded}\n`,
    });

    // When
    input.write("first prompt\n");
    await withTimeout(firstTurnEnded, 5000, "first turn did not finish");
    input.write("/compact\n");
    input.end();

    // Then
    const result = await session;
    expect(stdout).toBe("First done\n");
    expect(stderr).toContain("Context compacted: manual");
    expect(stderr).not.toContain("Cost:");
    expect(result.report?.end.stopReason).toBe("completed");
    expect(result.report?.end.usage).toEqual({
      inputTokens: 30,
      cachedInputTokens: 0,
      uncachedInputTokens: 30,
      outputTokens: 10,
    });
    expect(result.report?.end.cost.spentUsd).toBeCloseTo(0.005);
  });

  test(`Given manual compaction exhausts an interactive session cost limit,
    When more prompt input is already queued,
    Then the session report records a cost budget stop`, async () => {
    // Given
    let receiveFirstEnd: () => void = () => {};
    const firstTurnEnded = new Promise<void>((resolve) => {
      receiveFirstEnd = resolve;
    });
    let requestTurn = 0;
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        if (options.toolChoice === "none") {
          yield { type: "text", text: "Costed checkpoint summary." };
          yield {
            type: "stop",
            reason: "stop",
            usage: {
              inputTokens: 30,
              cachedInputTokens: 0,
              uncachedInputTokens: 30,
              outputTokens: 10,
            },
          };
          return;
        }

        requestTurn++;
        yield { type: "text", text: "First done" };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    let stdout = "";
    let stderr = "";
    const costModel: CostModel = {
      type: "fixed",
      uncachedInputPerMillionTokens: 100,
      cachedInputPerMillionTokens: 0,
      outputPerMillionTokens: 200,
    };
    const session = runInteractiveSession({
      cliArgs: {
        bashMode: "disabled",
        maxCostUsd: 0.001,
        reportFile: "session.json",
      },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel,
        contextCompaction: { keepRecentTokens: 1 },
      }),
      requireKnownCostModel: () => costModel,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
            if (requestTurn === 1) {
              receiveFirstEnd();
            }
          }
        }
        return finalEnd;
      },
      formatCostReport: (cost, maxUsd) =>
        `Cost: ${cost.spentUsd.toFixed(6)} / ${maxUsd.toFixed(3)} exceeded=${cost.budgetExceeded}\n`,
    });

    // When
    input.write("first prompt\n");
    await withTimeout(firstTurnEnded, 5000, "first turn did not finish");
    input.write("/compact\n");
    input.write("second prompt\n");
    input.end();

    // Then
    const result = await session;
    expect(requestTurn).toBe(1);
    expect(stdout).toBe("First done\n");
    expect(stderr).toContain("Context compacted: manual");
    expect(stderr).toContain("Cost: 0.005000 / 0.001 exceeded=true\n");
    expect(result.report?.end.stopReason).toBe("cost_budget");
    expect(result.report?.end.cost.spentUsd).toBeCloseTo(0.005);
  });

  test(`Given manual compaction cost model resolution fails,
    When user enters /compact,
    Then the configuration error is not reported as compaction failure`, async () => {
    // Given
    let receiveFirstEnd: () => void = () => {};
    const firstTurnEnded = new Promise<void>((resolve) => {
      receiveFirstEnd = resolve;
    });
    let summaryRequests = 0;
    let costModelRequests = 0;
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        if (options.toolChoice === "none") {
          summaryRequests++;
          yield { type: "text", text: "Unexpected checkpoint summary." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        yield { type: "text", text: "First done" };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    let stdout = "";
    let stderr = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled", maxCostUsd: 1 },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
        contextCompaction: { keepRecentTokens: 1 },
      }),
      requireKnownCostModel: () => {
        costModelRequests++;
        if (costModelRequests === 1) {
          return ZERO_COST_MODEL;
        }
        throw new Error("known cost model missing");
      },
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
            receiveFirstEnd();
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    // When
    input.write("first prompt\n");
    await withTimeout(firstTurnEnded, 5000, "first turn did not finish");
    input.write("/compact\n");
    input.end();

    // Then
    await expect(session).rejects.toThrow("known cost model missing");
    expect(stdout).toBe("First done\n");
    expect(stderr).not.toContain("Context compaction failed");
    expect(summaryRequests).toBe(0);
  });

  test(`Given an interactive session has prior history,
    When user enters /compact with a whitespace-separated focus instruction,
    Then the instruction is included in the summary prompt but not appended as a task`, async () => {
    // Given
    const focusInstruction =
      "keep the root cause, files changed, failed tests, and next steps";
    let receiveFirstEnd: () => void = () => {};
    const firstTurnEnded = new Promise<void>((resolve) => {
      receiveFirstEnd = resolve;
    });
    const observedRequestContexts: Message[][] = [];
    let summaryPrompt = "";
    let requestTurn = 0;
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        if (options.toolChoice === "none") {
          summaryPrompt = options.messages[0]?.content ?? "";
          yield { type: "text", text: "Focused checkpoint summary." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        requestTurn++;
        observedRequestContexts.push(structuredClone([...options.messages]));
        yield {
          type: "text",
          text: requestTurn === 1 ? "First done" : "Second done",
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    let stdout = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: () => {},
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
        contextCompaction: { keepRecentTokens: 1 },
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
            if (requestTurn === 1) {
              receiveFirstEnd();
            }
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    // When
    input.write("first prompt\n");
    await withTimeout(firstTurnEnded, 5000, "first turn did not finish");
    input.write(`/compact\t${focusInstruction}\n`);
    input.write("second prompt\n");
    input.end();

    // Then
    await session;
    expect(stdout).toBe("First done\nSecond done\n");
    expect(summaryPrompt).toContain(focusInstruction);
    expect(JSON.stringify(observedRequestContexts[1])).not.toContain(
      "/compact",
    );
    expect(observedRequestContexts[1]).toEqual([
      {
        role: "user",
        content: expect.stringContaining("<conversation-checkpoint>"),
      },
      { role: "user", content: "second prompt" },
    ]);
  });

  test(`Given an interactive session has prior history,
    When user enters /compact with only surrounding whitespace,
    Then compaction runs without a focus instruction`, async () => {
    // Given
    let receiveFirstEnd: () => void = () => {};
    const firstTurnEnded = new Promise<void>((resolve) => {
      receiveFirstEnd = resolve;
    });
    const observedRequestContexts: Message[][] = [];
    let summaryPrompt = "";
    let requestTurn = 0;
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        if (options.toolChoice === "none") {
          summaryPrompt = options.messages[0]?.content ?? "";
          yield { type: "text", text: "Whitespace checkpoint summary." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        requestTurn++;
        observedRequestContexts.push(structuredClone([...options.messages]));
        yield {
          type: "text",
          text: requestTurn === 1 ? "First done" : "Second done",
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    let stdout = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: () => {},
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
        contextCompaction: { keepRecentTokens: 1 },
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
            if (requestTurn === 1) {
              receiveFirstEnd();
            }
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    // When
    input.write("first prompt\n");
    await withTimeout(firstTurnEnded, 5000, "first turn did not finish");
    input.write("   /compact      \n");
    input.write("second prompt\n");
    input.end();

    // Then
    await session;
    expect(stdout).toBe("First done\nSecond done\n");
    expect(summaryPrompt).not.toContain("manual compaction focus");
    expect(observedRequestContexts[1]).toEqual([
      {
        role: "user",
        content: expect.stringContaining("<conversation-checkpoint>"),
      },
      { role: "user", content: "second prompt" },
    ]);
  });

  test(`Given an interactive session has no prior history,
    When user enters /compact,
    Then compaction is skipped without corrupting the next prompt`, async () => {
    // Given
    const observedRequestContexts: Message[][] = [];
    let resolvedProviders = 0;
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        observedRequestContexts.push(structuredClone([...options.messages]));
        yield { type: "text", text: "Hello done" };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    let stdout = "";
    let stderr = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => {
        resolvedProviders++;
        return {
          provider,
          providerId: "fake",
          model: "fake",
          costModel: ZERO_COST_MODEL,
          contextCompaction: { keepRecentTokens: 1 },
        };
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    // When
    input.write("/compact\n");
    input.write("hello\n");
    input.end();

    // Then
    await session;
    expect(stdout).toBe("Hello done\n");
    expect(stderr).toContain("Context compaction skipped");
    expect(resolvedProviders).toBe(1);
    expect(observedRequestContexts).toEqual([
      [{ role: "user", content: "hello" }],
    ]);
  });

  test(`Given an interactive session has only an unsplittable prior prompt,
    When user enters /compact,
    Then compaction is skipped without changing the history`, async () => {
    // Given
    let receiveFirstEnd: () => void = () => {};
    const firstTurnEnded = new Promise<void>((resolve) => {
      receiveFirstEnd = resolve;
    });
    const observedRequestContexts: Message[][] = [];
    let requestTurn = 0;
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        requestTurn++;
        observedRequestContexts.push(structuredClone([...options.messages]));
        if (requestTurn === 1) {
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }
        yield { type: "text", text: "Second done" };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    let stdout = "";
    let stderr = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
        contextCompaction: { keepRecentTokens: 1 },
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
            if (requestTurn === 1) {
              receiveFirstEnd();
            }
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    // When
    input.write("first prompt\n");
    await withTimeout(firstTurnEnded, 5000, "first turn did not finish");
    input.write("/compact\n");
    input.write("second prompt\n");
    input.end();

    // Then
    await session;
    expect(stdout).toBe("\nSecond done\n");
    expect(stderr).toContain("Context compaction skipped");
    expect(observedRequestContexts).toEqual([
      [{ role: "user", content: "first prompt" }],
      [
        { role: "user", content: "first prompt" },
        { role: "user", content: "second prompt" },
      ],
    ]);
  });

  test(`Given manual compaction summary fails,
    When user sends another prompt,
    Then the session reports failure and keeps the original history`, async () => {
    // Given
    let receiveFirstEnd: () => void = () => {};
    const firstTurnEnded = new Promise<void>((resolve) => {
      receiveFirstEnd = resolve;
    });
    const observedRequestContexts: Message[][] = [];
    let requestTurn = 0;
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        if (options.toolChoice === "none") {
          throw new Error("summary\n\u001b[31m exploded");
        }

        requestTurn++;
        observedRequestContexts.push(structuredClone([...options.messages]));
        yield {
          type: "text",
          text: requestTurn === 1 ? "First done" : "Second done",
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    let stdout = "";
    let stderr = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
        contextCompaction: { keepRecentTokens: 1 },
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
            if (requestTurn === 1) {
              receiveFirstEnd();
            }
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    // When
    input.write("first prompt\n");
    await withTimeout(firstTurnEnded, 5000, "first turn did not finish");
    input.write("/compact\n");
    input.write("second prompt\n");
    input.end();

    // Then
    await session;
    expect(stdout).toBe("First done\nSecond done\n");
    expect(stderr).toContain(
      "Context compaction failed: summary\\n\\x1b[31m exploded",
    );
    expect(observedRequestContexts[1]).toEqual([
      { role: "user", content: "first prompt" },
      { role: "assistant", content: "First done", toolCalls: [] },
      { role: "user", content: "second prompt" },
    ]);
  });

  test(`Given manual compaction is interrupted,
    When user sends another prompt,
    Then the session restores original history and drops the cancelled checkpoint`, async () => {
    // Given
    let receiveFirstEnd: () => void = () => {};
    const firstTurnEnded = new Promise<void>((resolve) => {
      receiveFirstEnd = resolve;
    });
    let receiveSummaryRequest: () => void = () => {};
    const summaryRequested = new Promise<void>((resolve) => {
      receiveSummaryRequest = resolve;
    });
    const observedRequestContexts: Message[][] = [];
    const compactionPrompts: string[] = [];
    let requestTurn = 0;
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        if (options.toolChoice === "none") {
          compactionPrompts.push(options.messages[0]?.content ?? "");
          receiveSummaryRequest();
          if (!options.signal.aborted) {
            await new Promise<void>((resolve) => {
              options.signal.addEventListener("abort", () => resolve(), {
                once: true,
              });
            });
          }
          yield { type: "text", text: "Cancelled manual summary." };
          yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
          return;
        }

        requestTurn++;
        observedRequestContexts.push(structuredClone([...options.messages]));
        yield {
          type: "text",
          text: requestTurn === 1 ? "First done" : "Second done",
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
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
        contextCompaction: { keepRecentTokens: 1 },
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
            if (requestTurn === 1) {
              receiveFirstEnd();
            }
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    // When
    input.write("first prompt\n");
    await withTimeout(firstTurnEnded, 5000, "first turn did not finish");
    input.write("/compact\n");
    await withTimeout(summaryRequested, 5000, "manual summary did not start");
    for (const handler of [...sigintHandlers]) {
      handler();
    }
    input.write("second prompt\n");
    input.end();

    // Then
    await session;
    expect(stdout).toBe("First done\n\nSecond done\n");
    expect(compactionPrompts).toHaveLength(1);
    expect(observedRequestContexts[1]).toEqual([
      { role: "user", content: "first prompt" },
      { role: "assistant", content: "First done", toolCalls: [] },
      { role: "user", content: "second prompt" },
    ]);
    expect(JSON.stringify(observedRequestContexts[1])).not.toContain(
      "<conversation-checkpoint>",
    );
    expect(JSON.stringify(observedRequestContexts[1])).not.toContain(
      "/compact",
    );
  });

  test(`Given manual compaction summary fails after interruption,
    When user sends another prompt,
    Then the session treats the failure as an abort and restores history`, async () => {
    // Given
    let receiveFirstEnd: () => void = () => {};
    const firstTurnEnded = new Promise<void>((resolve) => {
      receiveFirstEnd = resolve;
    });
    let receiveSummaryRequest: () => void = () => {};
    const summaryRequested = new Promise<void>((resolve) => {
      receiveSummaryRequest = resolve;
    });
    const observedRequestContexts: Message[][] = [];
    let requestTurn = 0;
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        if (options.toolChoice === "none") {
          receiveSummaryRequest();
          if (!options.signal.aborted) {
            await new Promise<void>((resolve) => {
              options.signal.addEventListener("abort", () => resolve(), {
                once: true,
              });
            });
          }
          throw new Error("summary aborted");
        }

        requestTurn++;
        observedRequestContexts.push(structuredClone([...options.messages]));
        yield {
          type: "text",
          text: requestTurn === 1 ? "First done" : "Second done",
        };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
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
        contextCompaction: { keepRecentTokens: 1 },
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
            if (requestTurn === 1) {
              receiveFirstEnd();
            }
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    // When
    input.write("first prompt\n");
    await withTimeout(firstTurnEnded, 5000, "first turn did not finish");
    input.write("/compact\n");
    await withTimeout(summaryRequested, 5000, "manual summary did not start");
    for (const handler of [...sigintHandlers]) {
      handler();
    }
    input.write("second prompt\n");
    input.end();

    // Then
    await session;
    expect(stdout).toBe("First done\n\nSecond done\n");
    expect(stderr).toBe("");
    expect(observedRequestContexts[1]).toEqual([
      { role: "user", content: "first prompt" },
      { role: "assistant", content: "First done", toolCalls: [] },
      { role: "user", content: "second prompt" },
    ]);
  });

  test(`Given a prompt only starts with the compact command name,
    When user enters the prompt,
    Then it is sent as a normal task message`, async () => {
    // Given
    const observedRequestContexts: Message[][] = [];
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        observedRequestContexts.push(structuredClone([...options.messages]));
        yield { type: "text", text: "Normal answer" };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    let stdout = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: () => {},
      onSigint: () => {},
      offSigint: () => {},
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
          } else if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    // When
    input.write("/compactfoo\n");
    input.end();

    // Then
    await session;
    expect(stdout).toBe("Normal answer\n");
    expect(observedRequestContexts).toEqual([
      [{ role: "user", content: "/compactfoo" }],
    ]);
  });

  test(`Given an active interactive turn fails without abort,
    When the provider error reaches the session,
    Then the error is rethrown`, async () => {
    // Given
    const provider: LLMProvider = {
      id: "fake",
      async *stream() {
        yield { type: "text", text: "Before failure" };
        throw new Error("provider failed");
      },
    };
    const input = new PassThrough();
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: () => {},
      writeStderr: () => {},
      onSigint: () => {},
      offSigint: () => {},
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
        for await (const _event of stream) {
          // Consume the stream so provider errors surface through the session.
        }
        return undefined;
      },
      formatCostReport: () => "",
    });

    // When
    input.write("hello\n");
    input.end();

    // Then
    await expect(session).rejects.toThrow("provider failed");
  });

  test(`Given an active interactive turn has already been interrupted,
    When user interrupts the still-running turn again,
    Then the CLI exits as interrupted`, async () => {
    // Given
    let releaseHang: () => void = () => {};
    let receiveHanging: () => void = () => {};
    let receiveAbort: () => void = () => {};
    let receiveAbortMarker: () => void = () => {};
    const hangReleased = new Promise<void>((resolve) => {
      releaseHang = resolve;
    });
    const hangingReceived = new Promise<void>((resolve) => {
      receiveHanging = resolve;
    });
    const abortReceived = new Promise<void>((resolve) => {
      receiveAbort = resolve;
    });
    const abortMarkerReceived = new Promise<void>((resolve) => {
      receiveAbortMarker = resolve;
    });
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        yield { type: "text", text: "Hanging" };
        await new Promise<void>((resolve) => {
          options.signal.addEventListener(
            "abort",
            () => {
              receiveAbort();
              resolve();
            },
            { once: true },
          );
        });
        yield { type: "text", text: " Aborted" };
        await hangReleased;
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    let exitCode: number | undefined;
    const printAgentEvents = async (stream: AsyncIterable<AgentEvent>) => {
      let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
      for await (const event of stream) {
        if (event.type === "text") {
          stdout += event.text;
          if (stdout.includes("Hanging")) {
            receiveHanging();
          }
          if (stdout.includes("Hanging Aborted")) {
            receiveAbortMarker();
          }
        } else if (event.type === "end") {
          finalEnd = event;
        }
      }
      return finalEnd;
    };
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: (handler) => {
        sigintHandlers.add(handler);
      },
      offSigint: (handler) => {
        sigintHandlers.delete(handler);
      },
      setExitCode: (code) => {
        exitCode = code;
      },
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
      printAgentEvents,
      formatCostReport: () => "",
    });
    const emitSigint = () => {
      for (const handler of [...sigintHandlers]) {
        handler();
      }
    };

    try {
      // When
      input.write("hang\n");
      await withTimeout(
        hangingReceived,
        5000,
        "interactive session did not start the hanging turn",
      );
      emitSigint();
      await withTimeout(
        abortReceived,
        5000,
        "interactive session did not deliver the first interrupt",
      );
      await withTimeout(
        abortMarkerReceived,
        5000,
        "interactive session did not print the first interrupt marker",
      );

      // Then
      let forcedExit: ForcedExit | null = null;
      try {
        emitSigint();
      } catch (error) {
        if (error instanceof ForcedExit) {
          forcedExit = error;
        } else {
          throw error;
        }
      }
      expect(forcedExit?.code).toBe(130);
      expect(exitCode).toBeUndefined();
      expect(stdout).toBe("Hanging Aborted\n");
      expect(stderr).toBe("");
    } finally {
      releaseHang();
      input.end();
      await session;
    }
  });
});
