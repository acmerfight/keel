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
  readonly drainNotifications: () => readonly string[];
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
  return `${text.slice(0, Math.max(0, maxResultChars - suffix.length))}${suffix}`;
}

export function createInteractiveSubagentSession(
  options: CreateInteractiveSubagentSessionOptions,
): InteractiveSubagentSession {
  const sessionAbortController = new AbortController();
  const runs = new Map<AgentId, SubagentBackgroundRun>();
  const notifications: string[] = [];
  let health: BackgroundSessionHealth = { kind: "healthy" };
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

  const background: SubagentBackgroundRuntime = {
    signal: sessionAbortController.signal,
    register: (run) => {
      if (runs.has(run.childAgentId)) {
        throw new Error(
          `background subagent ${run.childAgentId} is already registered`,
        );
      }
      runs.set(run.childAgentId, run);
      void run.result
        .then((result) => {
          const notice = `Background subagent ${run.childAgentId} ${result.status}.`;
          notifications.push(
            [
              "<keel_runtime_context>",
              notice,
              "Use agent_wait with this stable agent ID when its canonical result is needed.",
              "This is runtime lifecycle state, not a new user request or evidence that the child conclusion is correct.",
              "</keel_runtime_context>",
            ].join("\n"),
          );
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
            // Output is observational; drainNotifications/shutdown still propagates the failure.
          }
        });
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
  };

  return {
    lifecyclePersistence: options.history.persistence,
    sharedCostBudget,
    sharedAdmission,
    providerCoordination,
    background,
    control,
    drainNotifications: () => {
      if (health.kind === "failed") throw health.error;
      return notifications.splice(0, notifications.length);
    },
    shutdown: async () => {
      sessionAbortController.abort(new Error("saved session owner exited"));
      const settlements = await Promise.allSettled(
        [...runs.values()].map((run) => run.result),
      );
      const rejected = settlements.find(
        (settlement) => settlement.status === "rejected",
      );
      if (rejected?.status === "rejected") throw rejected.reason;
      if (health.kind === "failed") throw health.error;
    },
  };
}
