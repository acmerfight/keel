import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { expect } from "vitest";
import type { ContextCompactionOptions } from "../agent/context-compaction.ts";
import type { AgentEvent } from "../agent/events.ts";
import type {
  InteractiveMemoryRuntime,
  InteractiveResolvedProvider,
  InteractiveSession,
  InteractiveSessionOptions,
  InteractiveSessionResult,
  InteractiveSkillRuntime,
  SavedInteractiveSession,
} from "../cli/interactive-session/types.ts";
import { runInteractiveSession as runProductionInteractiveSession } from "../cli/interactive-session.ts";
import type { ModelSource } from "../cli/provider-config.ts";
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

export const EPHEMERAL_INTERACTIVE_SESSION = {
  kind: "ephemeral",
} satisfies InteractiveSession;

const DISABLED_TEST_MEMORY = {
  kind: "disabled",
  status: () => ({
    enabled: false,
    scope: null,
    loadedIds: [],
    loadedEntries: [],
    renderedBytes: 0,
    estimatedTokens: 0,
    operations: [],
  }),
} satisfies InteractiveMemoryRuntime;

const EMPTY_TEST_SKILLS = {
  kind: "empty",
} satisfies InteractiveSkillRuntime;

export function runInteractiveSessionWithoutMemory(
  options: Omit<InteractiveSessionOptions, "session" | "memory" | "skills"> & {
    readonly session: InteractiveSession;
    readonly skills?: InteractiveSkillRuntime;
  },
): Promise<InteractiveSessionResult> {
  const { skills = EMPTY_TEST_SKILLS, ...sessionOptions } = options;
  return runProductionInteractiveSession({
    ...sessionOptions,
    skills,
    memory: DISABLED_TEST_MEMORY,
  });
}

type SavedInteractiveSessionFixtureOptions = {
  readonly id: string;
} & Partial<Omit<SavedInteractiveSession, "id" | "kind">>;

export function savedInteractiveSession(
  options: SavedInteractiveSessionFixtureOptions,
): SavedInteractiveSession {
  return {
    kind: "saved",
    id: options.id,
    resumeAvailable: options.resumeAvailable ?? (() => true),
    reserveMessageId: options.reserveMessageId ?? (() => `msg-${options.id}`),
    persistQueuedInput:
      options.persistQueuedInput ??
      ((input) => ({
        id: `input-${input.sequence}`,
        timestamp: "2026-01-01T00:00:00.000Z",
        sequence: input.sequence,
        line: input.line,
      })),
    consumeQueuedInputs: options.consumeQueuedInputs ?? (() => {}),
    persistMessages: options.persistMessages ?? (() => {}),
    persistTitle: options.persistTitle ?? ((record) => record.title),
    persistGoal: options.persistGoal ?? ((update) => update.goal ?? undefined),
    persistTaskProgress: options.persistTaskProgress ?? (() => {}),
    persistModelSwitch: options.persistModelSwitch ?? (() => {}),
    persistSkillState: options.persistSkillState ?? (() => {}),
    fork: options.fork ?? (() => ""),
    listForkPoints:
      options.listForkPoints ??
      (() => ({
        sessionId: options.id,
        points: [],
      })),
    persistBashApprovalGrant: options.persistBashApprovalGrant ?? (() => {}),
    persistBashApprovalRevoked:
      options.persistBashApprovalRevoked ?? (() => {}),
    persistBashApprovalsCleared:
      options.persistBashApprovalsCleared ?? (() => {}),
  };
}

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
    async *stream(options) {
      const attempt = options.providerRequestAttempts?.begin();
      yield { type: "text", text };
      attempt?.finish({ outcome: "completed", usage: ZERO_USAGE });
      yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
    },
  };
}

export function withProviderRequestAttemptAccounting(
  provider: LLMProvider,
): LLMProvider {
  return {
    id: provider.id,
    ...(provider.estimateInputTokens !== undefined
      ? { estimateInputTokens: provider.estimateInputTokens }
      : {}),
    async *stream(options) {
      const attempt = options.providerRequestAttempts?.begin();
      const {
        providerRequestAttempts: _providerRequestAttempts,
        ...unobservedOptions
      } = options;
      let finished = false;
      try {
        for await (const event of provider.stream(unobservedOptions)) {
          if (event.type === "stop") {
            finished = true;
            attempt?.finish({ outcome: "completed", usage: event.usage });
          }
          yield event;
        }
      } catch (error) {
        if (!finished) {
          finished = true;
          attempt?.finish({
            outcome: options.signal.aborted ? "aborted" : "terminal_error",
          });
        }
        throw error;
      } finally {
        if (!finished) {
          finished = true;
          attempt?.finish({
            outcome: options.signal.aborted ? "aborted" : "terminal_error",
          });
        }
      }
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
  modelSource: ModelSource = "default",
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
        modelSource,
        modelMetadata,
        ...(contextCompaction !== undefined ? { contextCompaction } : {}),
      };
    case "kimi":
      return {
        provider,
        providerId: "kimi",
        model,
        costModel,
        modelSource,
        modelMetadata,
        ...(contextCompaction !== undefined ? { contextCompaction } : {}),
      };
    case "qwen":
      return {
        provider,
        providerId: "qwen",
        model,
        costModel,
        modelSource,
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
  const session = runInteractiveSessionWithoutMemory({
    cliArgs: { bashMode: "disabled" },
    workspace,
    platform: process.platform,
    session: EPHEMERAL_INTERACTIVE_SESSION,
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
