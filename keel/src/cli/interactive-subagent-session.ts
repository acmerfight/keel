import {
  createSharedCostBudgetAccount,
  type SharedCostBudgetAccount,
} from "../agent/cost-budget.ts";
import type {
  AgentId,
  SubagentCanonicalResult,
  SubagentLifecyclePersistence,
} from "../agent/subagent-lifecycle.ts";
import type {
  SubagentBackgroundRun,
  SubagentBackgroundRuntime,
  SubagentContinuationCapability,
} from "../agent/subagent-supervisor.ts";
import { projectSubagentResult } from "../agent/subagent-supervisor.ts";
import {
  createSubagentTreeAdmission,
  type SubagentTreeAdmission,
} from "../agent/subagent-tree-admission.ts";
import {
  createSubagentTreeProviderCoordination,
  type SubagentTreeProviderCoordination,
} from "../agent/subagent-tree-provider.ts";
import { errorMessage } from "../core/error.ts";
import type { AgentControlCapability } from "../tools/agent-control.ts";
import {
  formatAgentHistoryList,
  resolveAgentHistoryEntry,
} from "./agent-history-format.ts";
import type { AgentTreeHistory } from "./agent-tree-store.ts";

interface CreateInteractiveSubagentSessionOptions {
  readonly maxCostUsd: number;
  readonly initialCostUsd: number;
  readonly history: AgentTreeHistory;
  readonly now: () => number;
  readonly writeStderr: (text: string) => void;
  readonly onBackgroundSettled: (result: SubagentCanonicalResult) => void;
}

export interface InteractiveSubagentSession {
  readonly lifecyclePersistence: SubagentLifecyclePersistence;
  readonly sharedCostBudget: SharedCostBudgetAccount;
  readonly sharedAdmission: SubagentTreeAdmission;
  readonly providerCoordination: SubagentTreeProviderCoordination;
  readonly background: SubagentBackgroundRuntime;
  readonly control: AgentControlCapability;
  readonly continuation: {
    readonly attach: (capability: SubagentContinuationCapability) => () => void;
  };
  readonly assertHealthy: () => void;
  readonly shutdown: () => Promise<void>;
}

type BackgroundSessionHealth =
  | { readonly kind: "healthy" }
  | { readonly kind: "failed"; readonly error: unknown };

function awaitWithSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function boundedControlText(text: string, maxResultChars: number): string {
  if (text.length <= maxResultChars) return text;
  const suffix = "\n[truncated]";
  if (maxResultChars <= suffix.length) return suffix.slice(0, maxResultChars);
  return `${text.slice(0, Math.max(0, maxResultChars - suffix.length))}${suffix}`;
}

export function createInteractiveSubagentSession(
  options: CreateInteractiveSubagentSessionOptions,
): InteractiveSubagentSession {
  const sessionAbortController = new AbortController();
  const runs = new Map<AgentId, SubagentBackgroundRun>();
  const settlements = new Map<string, Promise<void>>();
  let continuationCapability: SubagentContinuationCapability | null = null;
  let health: BackgroundSessionHealth = { kind: "healthy" };
  let acceptingBackgroundRuns = true;
  const maxRemainingCostUsd = Math.max(
    0,
    options.maxCostUsd - options.initialCostUsd,
  );
  const sharedCostBudget = createSharedCostBudgetAccount(maxRemainingCostUsd);
  const sharedAdmission = createSubagentTreeAdmission();
  const providerCoordination = createSubagentTreeProviderCoordination({
    now: options.now,
  });

  const terminalContent = (
    id: string,
    maxResultChars: number,
  ): string | null => {
    const entry = resolveAgentHistoryEntry(options.history, id);
    if (entry === null || entry.result === null) return null;
    return projectSubagentResult(entry.result, maxResultChars);
  };
  const terminalStatusContent = (
    id: string,
    maxResultChars: number,
  ): string | null => {
    const entry = resolveAgentHistoryEntry(options.history, id);
    if (entry === null || entry.result === null) return null;
    return boundedControlText(
      JSON.stringify({
        agentId: entry.childAgentId,
        status: entry.result.status,
      }),
      maxResultChars,
    );
  };
  const unknownAgent = (id: string) => ({
    ok: false,
    content: `No subagent matches ${JSON.stringify(id)}.`,
  });
  const wait = async (
    id: string,
    signal: AbortSignal,
    maxResultChars: number,
  ) => {
    const durable = terminalContent(id, maxResultChars);
    if (durable !== null) return { ok: true, content: durable };
    const entry = resolveAgentHistoryEntry(options.history, id);
    if (entry === null) return unknownAgent(id);
    const run = runs.get(entry.childAgentId);
    if (run === undefined) {
      return {
        ok: false,
        content: `Subagent ${entry.childAgentId} is not owned by this live session.`,
      };
    }
    try {
      await awaitWithSignal(run.result, signal);
      const settled = terminalContent(entry.childAgentId, maxResultChars);
      return settled === null
        ? {
            ok: false,
            content: `Subagent ${entry.childAgentId} settled without a durable result.`,
          }
        : { ok: true, content: settled };
    } catch (caught) {
      return {
        ok: false,
        content: `Waiting for ${entry.childAgentId} failed: ${errorMessage(caught)}`,
      };
    }
  };
  const waitForSettlement = async (
    id: AgentId,
    signal: AbortSignal,
  ): Promise<void> => {
    const entry = resolveAgentHistoryEntry(options.history, id);
    if (entry === null || entry.result !== null) return;
    const settlement = settlements.get(entry.childRunId);
    if (settlement === undefined) return;
    await awaitWithSignal(settlement, signal);
  };

  const background: SubagentBackgroundRuntime = {
    signal: sessionAbortController.signal,
    register: (run) => {
      if (!acceptingBackgroundRuns) {
        throw new Error(
          "saved session owner no longer accepts background Runs",
        );
      }
      const existing = runs.get(run.childAgentId);
      if (existing?.childRunId === run.childRunId) {
        throw new Error(
          `background subagent Run ${run.childRunId} is already registered`,
        );
      }
      if (
        existing !== undefined &&
        options.history
          .runs(run.childAgentId)
          .some(
            (entry) =>
              entry.childRunId === existing.childRunId && entry.result === null,
          )
      ) {
        throw new Error(
          `background subagent ${run.childAgentId} already has a live Run`,
        );
      }
      runs.set(run.childAgentId, run);
      const settlement = run.result
        .then((result) => {
          const notice = `Background subagent ${run.childAgentId} ${result.status}.`;
          try {
            options.writeStderr(`${notice}\n`);
          } catch {
            // Output is observational and cannot change the durable terminal.
          }
          options.onBackgroundSettled(result);
        })
        .catch((caught: unknown) => {
          health = { kind: "failed", error: caught };
          try {
            options.writeStderr(
              `Background subagent ${run.childAgentId} failed to settle: ${errorMessage(caught)}\n`,
            );
          } catch {
            // Output is observational; shutdown still propagates the failure.
          }
        })
        .finally(() => {
          if (runs.get(run.childAgentId)?.childRunId === run.childRunId) {
            runs.delete(run.childAgentId);
          }
        });
      settlements.set(run.childRunId, settlement);
    },
  };
  const control: AgentControlCapability = {
    list: (request) => ({
      ok: true,
      content: boundedControlText(
        formatAgentHistoryList(options.history),
        request.maxResultChars,
      ),
    }),
    waitForSettlement: (request) =>
      waitForSettlement(request.id, request.signal),
    wait: (request) => wait(request.id, request.signal, request.maxResultChars),
    cancel: async (request) => {
      const durable = terminalStatusContent(request.id, request.maxResultChars);
      if (durable !== null) return { ok: true, content: durable };
      const entry = resolveAgentHistoryEntry(options.history, request.id);
      if (entry === null) return unknownAgent(request.id);
      const run = runs.get(entry.childAgentId);
      if (run === undefined) {
        return {
          ok: false,
          content: `Subagent ${entry.childAgentId} is not owned by this live session.`,
        };
      }
      run.cancel();
      try {
        await awaitWithSignal(run.result, request.signal);
        const settled = terminalStatusContent(
          entry.childAgentId,
          request.maxResultChars,
        );
        return settled === null
          ? {
              ok: false,
              content: `Subagent ${entry.childAgentId} settled without a durable result.`,
            }
          : { ok: true, content: settled };
      } catch (caught) {
        return {
          ok: false,
          content: `Cancelling ${entry.childAgentId} failed: ${errorMessage(caught)}`,
        };
      }
    },
    input: (request) => {
      const entry = resolveAgentHistoryEntry(options.history, request.id);
      if (entry === null) return unknownAgent(request.id);
      if (entry.result !== null) {
        return {
          ok: false,
          content: `Subagent ${entry.childAgentId} is terminal; use agent_resume to continue it as a new Run.`,
        };
      }
      const run = runs.get(entry.childAgentId);
      if (run === undefined || run.childRunId !== entry.childRunId) {
        return {
          ok: false,
          content: `Subagent ${entry.childAgentId} is not owned by this live session.`,
        };
      }
      const result = run.input(request.message);
      if (result.kind === "accepted") {
        return {
          ok: true,
          content: boundedControlText(
            JSON.stringify({
              agentId: entry.childAgentId,
              runId: entry.childRunId,
              status: "input_queued",
            }),
            request.maxResultChars,
          ),
        };
      }
      return {
        ok: false,
        content:
          result.kind === "closed"
            ? `Subagent ${entry.childAgentId} stopped accepting input at its terminal boundary; use agent_resume.`
            : `Subagent ${entry.childAgentId} input queue is full.`,
      };
    },
    resume: async (request) => {
      const entry = resolveAgentHistoryEntry(options.history, request.id);
      if (entry === null) return unknownAgent(request.id);
      if (entry.result === null) {
        return {
          ok: false,
          content: `Subagent ${entry.childAgentId} is still active; use agent_input instead.`,
        };
      }
      if (continuationCapability === null) {
        return {
          ok: false,
          content:
            "Agent resume is unavailable outside an admitted model runtime.",
        };
      }
      const result = await continuationCapability.resume({
        childAgentId: entry.childAgentId,
        previousRunId: entry.childRunId,
        capability: entry.capability,
        toolCallId: request.requestId,
        message: request.message,
        focusPaths: entry.focusPaths,
        systemPrompt: entry.systemPrompt,
        priorMessages: options.history.messages(entry),
        signal: request.signal,
      });
      return {
        ok: result.ok,
        content: boundedControlText(result.content, request.maxResultChars),
      };
    },
  };

  return {
    lifecyclePersistence: options.history.persistence,
    sharedCostBudget,
    sharedAdmission,
    providerCoordination,
    background,
    control,
    continuation: {
      attach: (capability) => {
        continuationCapability = capability;
        return () => {
          if (continuationCapability === capability) {
            continuationCapability = null;
          }
        };
      },
    },
    assertHealthy: () => {
      if (health.kind === "failed") throw health.error;
    },
    shutdown: async () => {
      acceptingBackgroundRuns = false;
      sessionAbortController.abort(new Error("saved session owner exited"));
      await Promise.all(settlements.values());
      if (health.kind === "failed") throw health.error;
    },
  };
}
