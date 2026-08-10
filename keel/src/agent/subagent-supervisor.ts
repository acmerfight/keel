import { randomUUID } from "node:crypto";
import type { CostModel } from "../core/cost.ts";
import { errorMessage, isAbortThrow, KeelError } from "../core/error.ts";
import type { LLMProvider, StreamOptions, Usage } from "../llm/types.ts";
import type {
  DelegationBatch,
  DelegationBatchEntry,
  DelegationCapability,
  DelegationRequest,
  DelegationToolResult,
} from "../tools/delegation.ts";
import { createDelegationExecutor } from "../tools/delegation.ts";
import { resolveWorkspaceTarget } from "../tools/workspace-path.ts";
import type { ContextCompactionOptions } from "./context-compaction.ts";
import {
  createSharedCostBudgetedProvider,
  estimateProviderInputTokens,
  MIN_USEFUL_OUTPUT_TOKENS,
  type SharedCostBudgetedProvider,
} from "./cost-budget.ts";
import { runAgent } from "./loop.ts";
import type {
  MainModelOperationInstrumentation,
  SubagentModelOperationInstrumentation,
} from "./model-operations.ts";
import type { ProjectInstructions } from "./prompt.ts";
import { buildReadOnlySubagentSystemPrompt } from "./prompt.ts";
import type { SessionMessage } from "./session-message.ts";
import { maxTurnFallbackPolicy } from "./stop-policy.ts";
import type {
  AgentId,
  SubagentCanonicalResult,
  SubagentLifecyclePersistence,
  SubagentRunId,
  SubagentRunningPersistence,
  SubagentRunPersistence,
  SubagentTerminalOutcome,
  SubagentTerminalStatus,
} from "./subagent-lifecycle.ts";
import { SubagentPersistenceError } from "./subagent-lifecycle.ts";
import {
  createSubagentTreeAdmission,
  type SubagentAdmissionLease,
  type SubagentAdmissionRejection,
} from "./subagent-tree-admission.ts";
import {
  createSubagentTreeBudget,
  type SubagentChildBudgetLease,
  type SubagentResultOutcome,
  type SubagentTreeBudgetCandidate,
  type SubagentTreeBudgetLeaseResult,
} from "./subagent-tree-budget.ts";
import type {
  AbortableToolOutputArtifactStore,
  ToolOutputArtifactSaveResult,
} from "./tool-output-artifacts.ts";

const DEFAULT_CHILD_DEADLINE_MS = 120_000;
const DEFAULT_SETTLEMENT_GRACE_MS = 2_000;
const DEFAULT_CHILD_MAX_TURNS = 16;
const MAIN_CONTINUATION_MAX_OUTPUT_TOKENS = 4_096;
const MAX_ADMITTED_FINAL_TEXT_CHARS = 4_000;
const MAX_ADMITTED_ERROR_CHARS = 2_000;
const MAX_ADMITTED_ID_CHARS = 512;
const MAX_ADMITTED_TRANSCRIPT_REF_CHARS = 512;

type AgentTerminalStatus = SubagentTerminalStatus;

export type SubagentProgressEvent =
  | {
      readonly status: "queued" | "running";
      readonly delegationId: string;
      readonly task: string;
      readonly elapsedMs: number;
      readonly deadlineMs: number;
    }
  | {
      readonly status: "turn";
      readonly delegationId: string;
      readonly task: string;
      readonly turn: number;
      readonly elapsedMs: number;
      readonly deadlineMs: number;
    }
  | {
      readonly status: "tool";
      readonly delegationId: string;
      readonly task: string;
      readonly tool: string;
      readonly elapsedMs: number;
      readonly deadlineMs: number;
    }
  | {
      readonly status: AgentTerminalStatus;
      readonly delegationId: string;
      readonly task: string;
      readonly elapsedMs: number;
      readonly deadlineMs: number;
    };

interface AcceptedDelegation {
  readonly kind: "accepted";
  readonly record: SubagentRunRecord;
  readonly run: () => Promise<SubagentCanonicalResult>;
  readonly cancelBeforeStart: () => void;
}

interface SubagentRunRecord {
  readonly delegationId: string;
  readonly childAgentId: AgentId;
  readonly childRunId: SubagentRunId;
  readonly task: string;
  state:
    | { readonly kind: "queued" | "running" }
    | {
        readonly kind: "terminal";
        readonly result: SubagentCanonicalResult;
      };
}

type SubagentRunSnapshot =
  | {
      readonly delegationId: string;
      readonly childAgentId: AgentId;
      readonly childRunId: SubagentRunId;
      readonly task: string;
      readonly state: "queued" | "running";
      readonly terminal: null;
    }
  | {
      readonly delegationId: string;
      readonly childAgentId: AgentId;
      readonly childRunId: SubagentRunId;
      readonly task: string;
      readonly state: "terminal";
      readonly terminal: SubagentCanonicalResult;
    };

interface ChildLifecycle {
  readonly startedAt: number;
  readonly abortController: AbortController;
  readonly settlementAbortController: AbortController;
  readonly deadlineExpired: () => boolean;
  readonly cleanup: () => void;
}

interface RejectedDelegation {
  readonly kind: "rejected";
  readonly result: Extract<
    DelegationToolResult,
    { readonly delivery: "rejected" }
  >;
}

type DelegationReceipt = AcceptedDelegation | RejectedDelegation;

interface PreparedDelegationCandidate {
  readonly input: DelegationRequest;
  readonly delegationId: string;
  readonly systemPrompt: string;
  readonly userMessage: string;
  readonly minimumInputTokens: number;
}

interface PreparedAcceptedCandidate {
  readonly childBudget: SubagentChildBudgetLease<PreparedDelegationCandidate>;
  readonly childAgentId: AgentId;
  readonly childRunId: SubagentRunId;
  readonly persistence?: SubagentRunPersistence;
}

export interface SubagentSupervisor {
  readonly capability: DelegationCapability;
  readonly activeAgentRunCount: () => number;
  readonly activeChildRunCount: () => number;
  readonly totalAcceptedCount: () => number;
  readonly runSnapshots: () => readonly SubagentRunSnapshot[];
}

interface CreateSubagentSupervisorOptions {
  readonly workspace: string;
  readonly platform: string;
  readonly parentRunId: string;
  readonly provider: LLMProvider;
  readonly providerId: string;
  readonly model: string;
  readonly costModel: CostModel;
  readonly rootBudget: SharedCostBudgetedProvider;
  readonly projectInstructions?: ProjectInstructions;
  readonly hiddenWorkspacePaths?: readonly string[];
  readonly contextCompaction?: ContextCompactionOptions;
  readonly modelMaxOutputTokens?: number;
  readonly modelOperations?: MainModelOperationInstrumentation;
  readonly transcriptStore: AbortableToolOutputArtifactStore;
  readonly lifecyclePersistence?: SubagentLifecyclePersistence;
  readonly now: () => number;
  readonly onProgress: (event: SubagentProgressEvent) => void;
  readonly deadlineMs?: number;
  readonly settlementGraceMs?: number;
  readonly maxTurns?: number;
  readonly maxActiveAgentRuns?: number;
  readonly maxTotalChildRuns?: number;
  readonly providerBlocked?: () => boolean;
}

function zeroUsage(): Usage {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    uncachedInputTokens: 0,
    outputTokens: 0,
  };
}

function rejectedDelegation(
  content: string,
): Extract<DelegationToolResult, { readonly delivery: "rejected" }> {
  return { delivery: "rejected", ok: false, content };
}

function admissionRejectionMessage(reason: SubagentAdmissionRejection): string {
  switch (reason) {
    case "active_limit":
      return "Delegation rejected: the root-inclusive active agent limit is reached.";
    case "total_limit":
      return "Delegation rejected: the total child limit for this root run is reached.";
  }
}

function childTaskMessage(
  delegationId: string,
  task: string,
  focusPaths: readonly string[],
): string {
  return [
    `Delegation ID: ${delegationId}`,
    "",
    "Delegated task:",
    task,
    "",
    "Focus paths:",
    ...(focusPaths.length === 0
      ? ["- none"]
      : focusPaths.map((path) => `- ${path}`)),
    "",
    "Return one concise final answer with the findings, key grounds, relevant workspace locations, and remaining uncertainty.",
  ].join("\n");
}

function validateWorkspacePaths(
  workspace: string,
  paths: readonly string[],
): string | null {
  for (const path of paths) {
    try {
      resolveWorkspaceTarget(workspace, path, "read");
    } catch (error) {
      return errorMessage(error);
    }
  }
  return null;
}

function admittedText(
  text: string,
  maxChars: number,
): { readonly value: string; readonly truncated: boolean } {
  if (maxChars <= 0) return { value: "", truncated: text.length > 0 };
  return text.length <= maxChars
    ? { value: text, truncated: false }
    : {
        value:
          maxChars <= 3
            ? ".".repeat(maxChars)
            : `${text.slice(0, maxChars - 3)}...`,
        truncated: true,
      };
}

function admittedTerminalText(
  result: SubagentCanonicalResult,
  value: string,
):
  | { readonly finalText: string; readonly error: null }
  | { readonly finalText: null; readonly error: string } {
  return result.status === "completed"
    ? { finalText: value, error: null }
    : { finalText: null, error: value };
}

function admittedAgentResult(
  result: SubagentCanonicalResult,
  maxResultChars: number,
): string {
  const rawText =
    result.status === "completed" ? result.finalText : result.error;
  const textLimit =
    result.status === "completed"
      ? MAX_ADMITTED_FINAL_TEXT_CHARS
      : MAX_ADMITTED_ERROR_CHARS;
  const delegationId = admittedText(result.delegationId, MAX_ADMITTED_ID_CHARS);
  const admittedResultText = admittedText(rawText, textLimit);
  const transcriptRefText =
    result.transcriptRef === null
      ? null
      : admittedText(result.transcriptRef, MAX_ADMITTED_TRANSCRIPT_REF_CHARS);
  const transcriptRef =
    transcriptRefText?.truncated === false ? transcriptRefText.value : null;
  const truncated =
    delegationId.truncated ||
    admittedResultText.truncated ||
    (result.transcriptRef !== null && transcriptRef === null);
  const serialize = (
    admittedDelegationId: string,
    value: string,
    admittedTranscriptRef: string | null,
    isTruncated: boolean,
  ): string =>
    JSON.stringify({
      delegationId: admittedDelegationId,
      status: result.status,
      transcriptRef: admittedTranscriptRef,
      truncated: isTruncated,
      ...admittedTerminalText(result, value),
    });
  const serialized = serialize(
    delegationId.value,
    admittedResultText.value,
    transcriptRef,
    truncated,
  );
  if (serialized.length <= maxResultChars) return serialized;

  let low = 0;
  let high = Math.min(rawText.length, textLimit);
  let fitted = serialize(delegationId.value, "", null, true);
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = serialize(
      delegationId.value,
      admittedText(rawText, middle).value,
      null,
      true,
    );
    if (candidate.length <= maxResultChars) {
      fitted = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (fitted.length <= maxResultChars) return fitted;

  low = 0;
  high = Math.min(result.delegationId.length, MAX_ADMITTED_ID_CHARS);
  let identityFitted = "0".slice(0, maxResultChars);
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = serialize(
      admittedText(result.delegationId, middle).value,
      "",
      null,
      true,
    );
    if (candidate.length <= maxResultChars) {
      identityFitted = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return identityFitted;
}

function childFinalText(messages: readonly SessionMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (
      message?.role === "assistant" &&
      message.toolCalls.length === 0 &&
      message.content.trim() !== ""
    ) {
      return message.content.trim();
    }
  }
  return null;
}

function transcriptContent(input: {
  readonly delegationId: string;
  readonly childRunId: SubagentRunId;
  readonly provider: string;
  readonly model: string;
  readonly systemPrompt: string;
  readonly messages: readonly SessionMessage[];
}): string {
  const records = [
    {
      schemaVersion: 1,
      type: "transcript",
      kind: "subagent",
      delegationId: input.delegationId,
      childRunId: input.childRunId,
      provider: input.provider,
      model: input.model,
      origin: "runtime_subagent_delegation",
      systemPrompt: input.systemPrompt,
    },
    ...input.messages.map((message) => ({ type: "message", message })),
  ];
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

function terminalOutcomeFromStopReason(
  stopReason: string,
  finalText: string | null,
): SubagentTerminalOutcome {
  if (stopReason === "completed" && finalText !== null) {
    return { status: "completed", finalText, error: null };
  }
  const status: Exclude<AgentTerminalStatus, "completed"> =
    stopReason === "turn_limit"
      ? "turn_limited"
      : stopReason === "cost_budget"
        ? "budget_limited"
        : "failed";
  const error =
    stopReason === "turn_limit"
      ? "Child exhausted its turn limit."
      : stopReason === "cost_budget"
        ? "Child exhausted its cost budget."
        : stopReason === "provider_length"
          ? "Child output was truncated by the provider length limit."
          : "Child ended without a non-empty final assistant message.";
  return { status, finalText: null, error };
}

function terminalStatusFromError(
  error: unknown,
  signal: AbortSignal,
  deadlineExpired: boolean,
): Exclude<AgentTerminalStatus, "completed"> {
  if (isAbortThrow(error, signal)) {
    return deadlineExpired ? "timed_out" : "cancelled";
  }
  if (error instanceof KeelError) {
    switch (error.code) {
      case "provider_auth_failed":
      case "provider_rate_limited":
      case "provider_http_error":
      case "provider_server_error":
        return "provider_blocked";
      default:
        return "failed";
    }
  }
  return "failed";
}

function cloneCanonicalResult(
  result: SubagentCanonicalResult,
): SubagentCanonicalResult {
  return {
    ...result,
    usage: { ...result.usage },
  };
}

function runSnapshot(record: SubagentRunRecord): SubagentRunSnapshot {
  if (record.state.kind === "terminal") {
    return {
      delegationId: record.delegationId,
      childAgentId: record.childAgentId,
      childRunId: record.childRunId,
      task: record.task,
      state: "terminal",
      terminal: cloneCanonicalResult(record.state.result),
    };
  }
  return {
    delegationId: record.delegationId,
    childAgentId: record.childAgentId,
    childRunId: record.childRunId,
    task: record.task,
    state: record.state.kind,
    terminal: null,
  };
}

function commitTerminalResult(
  record: SubagentRunRecord,
  result: SubagentCanonicalResult,
): void {
  /* v8 ignore next 3 -- the single foreground lifecycle has one canonical commit site; retain a fail-fast invariant guard. */
  if (record.state.kind === "terminal") {
    throw new Error("subagent terminal result was already committed");
  }
  record.state = { kind: "terminal", result: cloneCanonicalResult(result) };
}

export function createSubagentSupervisor(
  options: CreateSubagentSupervisorOptions,
): SubagentSupervisor {
  const receipts = new Map<string, DelegationReceipt>();
  const admission = createSubagentTreeAdmission({
    ...(options.maxActiveAgentRuns !== undefined
      ? { maxActiveAgentRuns: options.maxActiveAgentRuns }
      : {}),
    ...(options.maxTotalChildRuns !== undefined
      ? { maxTotalChildRuns: options.maxTotalChildRuns }
      : {}),
  });
  const treeBudget = createSubagentTreeBudget({
    rootBudget: options.rootBudget,
    costModel: options.costModel,
  });
  const deadlineMs = options.deadlineMs ?? DEFAULT_CHILD_DEADLINE_MS;
  const settlementGraceMs =
    options.settlementGraceMs ?? DEFAULT_SETTLEMENT_GRACE_MS;
  const maxTurns = options.maxTurns ?? DEFAULT_CHILD_MAX_TURNS;
  const observationNow = (fallback = 0): number => {
    try {
      const now = options.now();
      return Number.isFinite(now) ? now : fallback;
    } catch {
      return fallback;
    }
  };
  const elapsedSince = (startedAt: number): number =>
    Math.max(0, observationNow(startedAt) - startedAt);
  const publishProgress = (event: SubagentProgressEvent): void => {
    try {
      options.onProgress(event);
    } catch {
      // Progress is an observation adapter and cannot own child lifecycle.
    }
  };
  const createLifecycle = (parentSignal: AbortSignal): ChildLifecycle => {
    const startedAt = observationNow();
    const abortController = new AbortController();
    const settlementAbortController = new AbortController();
    let expired = false;
    let settlementDeadline: ReturnType<typeof setTimeout> | null = null;
    const beginCancellation = (reason: unknown): void => {
      abortController.abort(reason);
      if (settlementDeadline !== null) return;
      settlementDeadline = setTimeout(() => {
        settlementAbortController.abort(reason);
      }, settlementGraceMs);
    };
    const parentAbort = (): void => beginCancellation(parentSignal.reason);
    if (parentSignal.aborted) {
      parentAbort();
    } else {
      parentSignal.addEventListener("abort", parentAbort, { once: true });
    }
    const executionDeadline = setTimeout(() => {
      expired = true;
      const reason = new Error("subagent deadline exceeded");
      beginCancellation(reason);
    }, deadlineMs);
    return {
      startedAt,
      abortController,
      settlementAbortController,
      deadlineExpired: () => expired,
      cleanup: () => {
        clearTimeout(executionDeadline);
        if (settlementDeadline !== null) clearTimeout(settlementDeadline);
        parentSignal.removeEventListener("abort", parentAbort);
      },
    };
  };

  const executeAccepted = async (input: {
    readonly delegationId: string;
    readonly childAgentId: AgentId;
    readonly childRunId: SubagentRunId;
    readonly toolCallId: string;
    readonly task: string;
    readonly focusPaths: readonly string[];
    readonly systemPrompt: string;
    readonly userMessage: string;
    readonly childMaxCostUsd: number;
    readonly lifecycle: ChildLifecycle;
    readonly record: SubagentRunRecord;
    readonly persistence?: SubagentRunPersistence;
  }): Promise<SubagentCanonicalResult> => {
    const progress = (
      status: Exclude<SubagentProgressEvent["status"], "tool" | "turn">,
    ): void => {
      publishProgress({
        status,
        delegationId: input.delegationId,
        task: input.task,
        elapsedMs: elapsedSince(input.lifecycle.startedAt),
        deadlineMs,
      });
    };
    const toolProgress = (tool: string): void => {
      publishProgress({
        status: "tool",
        delegationId: input.delegationId,
        task: input.task,
        tool,
        elapsedMs: elapsedSince(input.lifecycle.startedAt),
        deadlineMs,
      });
    };
    const turnProgress = (turn: number): void => {
      publishProgress({
        status: "turn",
        delegationId: input.delegationId,
        task: input.task,
        turn,
        elapsedMs: elapsedSince(input.lifecycle.startedAt),
        deadlineMs,
      });
    };
    try {
      const runningPersistence: SubagentRunningPersistence | undefined =
        input.persistence?.running();
      input.record.state = { kind: "running" };
      progress("running");
      let transcriptMessages: readonly SessionMessage[] = [];
      let usage = zeroUsage();
      let turns = 0;
      let costUsd = 0;
      let terminal: SubagentTerminalOutcome = {
        status: "failed",
        finalText: null,
        error: "Child ended without a usable terminal result.",
      };
      const childBudget = createSharedCostBudgetedProvider({
        provider: options.provider,
        model: options.costModel,
        maxCostUsd: input.childMaxCostUsd,
        ...(options.modelMaxOutputTokens !== undefined
          ? { modelMaxOutputTokens: options.modelMaxOutputTokens }
          : {}),
      });
      const childModelOperations:
        | SubagentModelOperationInstrumentation
        | undefined =
        options.modelOperations === undefined
          ? undefined
          : {
              ...options.modelOperations,
              attribution: {
                type: "subagent",
                delegationId: input.delegationId,
                childRunId: input.childRunId,
              },
            };
      try {
        for await (const event of runAgent({
          workspace: options.workspace,
          provider: options.provider,
          userMessage: input.userMessage,
          userMessageOrigin: { type: "runtime_subagent_delegation" },
          systemPrompt: input.systemPrompt,
          signal: input.lifecycle.abortController.signal,
          bash: { kind: "disabled" },
          toolProfile: "read-only-subagent",
          stopPolicy: maxTurnFallbackPolicy(maxTurns),
          costTracking: {
            model: options.costModel,
            maxCostUsd: input.childMaxCostUsd,
            ...(options.modelMaxOutputTokens !== undefined
              ? { modelMaxOutputTokens: options.modelMaxOutputTokens }
              : {}),
          },
          costBudgetProvider: childBudget.provider,
          ...(options.hiddenWorkspacePaths !== undefined
            ? { hiddenWorkspacePaths: options.hiddenWorkspacePaths }
            : {}),
          ...(options.contextCompaction !== undefined
            ? { contextCompaction: options.contextCompaction }
            : {}),
          ...(childModelOperations !== undefined
            ? { modelOperations: childModelOperations }
            : {}),
          ...(input.persistence !== undefined
            ? { transcriptObserver: input.persistence.transcript }
            : {}),
          onTranscriptReady: (messages) => {
            transcriptMessages = messages;
          },
          onAgentLoopAccountingUpdated: (accounting) => {
            turns = accounting.turns;
            runningPersistence?.accounting({
              usage: accounting.usage,
              turns: accounting.turns,
              costUsd: childBudget.observedSpendUsd(),
            });
            turnProgress(turns);
          },
        })) {
          if (event.type === "tool_start") {
            toolProgress(event.toolCall.tool);
          }
          if (event.type === "end") {
            turns = event.turns;
            terminal = terminalOutcomeFromStopReason(
              event.stopReason,
              childFinalText(transcriptMessages),
            );
          }
        }
      } catch (caught) {
        terminal = {
          status: terminalStatusFromError(
            caught,
            input.lifecycle.abortController.signal,
            input.lifecycle.deadlineExpired(),
          ),
          finalText: null,
          error: errorMessage(caught),
        };
      }

      usage = childBudget.observedUsage();
      costUsd = childBudget.observedSpendUsd();
      let transcriptRef = input.persistence?.transcriptRef ?? null;
      if (input.persistence === undefined) {
        let saved: ToolOutputArtifactSaveResult;
        try {
          saved = await options.transcriptStore.save({
            toolCallId: input.toolCallId,
            toolName: "delegate",
            content: transcriptContent({
              delegationId: input.delegationId,
              childRunId: input.childRunId,
              provider: options.providerId,
              model: options.model,
              systemPrompt: input.systemPrompt,
              messages: transcriptMessages,
            }),
            sourceStatus: "complete",
            purpose: "settlement",
            signal: input.lifecycle.settlementAbortController.signal,
          });
        } catch (caught) {
          saved = {
            status: "failed",
            reason: errorMessage(caught),
          };
        }
        if (saved.status === "failed") {
          terminal = {
            status: "failed",
            finalText: null,
            error: `Child transcript could not be stored: ${saved.reason}`,
          };
        } else {
          transcriptRef = saved.ref;
        }
      }
      if (input.lifecycle.deadlineExpired()) {
        terminal = {
          status: "timed_out",
          finalText: null,
          error: "Child exceeded its full lifecycle deadline.",
        };
      } else if (input.lifecycle.abortController.signal.aborted) {
        terminal = {
          status: "cancelled",
          finalText: null,
          error: "Child was cancelled before lifecycle settlement completed.",
        };
      }
      const resultBase = {
        delegationId: input.delegationId,
        childAgentId: input.childAgentId,
        childRunId: input.childRunId,
        task: input.task,
        usage,
        turns,
        costUsd,
        transcriptRef,
      };
      const result: SubagentCanonicalResult = { ...resultBase, ...terminal };
      if (runningPersistence !== undefined) {
        runningPersistence.terminal({
          ...terminal,
          usage,
          turns,
          costUsd,
        });
        commitTerminalResult(input.record, result);
        progress(result.status);
        return result;
      }
      commitTerminalResult(input.record, result);
      progress(result.status);
      return result;
    } finally {
      input.lifecycle.cleanup();
    }
  };

  const createAcceptedReceipt = (
    childBudget: SubagentChildBudgetLease<PreparedDelegationCandidate>,
    admissionLease: Pick<SubagentAdmissionLease<unknown>, "release">,
    childAgentId: AgentId,
    childRunId: SubagentRunId,
    persistence: SubagentRunPersistence | undefined,
  ): AcceptedDelegation => {
    const candidate = childBudget.value;
    const { input, delegationId, systemPrompt, userMessage } = candidate;
    const record: SubagentRunRecord = {
      delegationId,
      childAgentId,
      childRunId,
      task: input.task,
      state: { kind: "queued" },
    };
    const lifecycle = createLifecycle(input.signal);
    const releaseResources = (): void => {
      lifecycle.cleanup();
      admissionLease.release();
    };
    const cancelledBeforeStart = (): SubagentCanonicalResult => ({
      delegationId,
      childAgentId,
      childRunId,
      status: "cancelled",
      task: input.task,
      finalText: null,
      usage: zeroUsage(),
      turns: 0,
      costUsd: 0,
      transcriptRef: persistence?.transcriptRef ?? null,
      error: "Child was cancelled before execution started.",
    });
    const publishCancelledBeforeStart = (
      result: SubagentCanonicalResult,
    ): void => {
      if (persistence === undefined) {
        commitTerminalResult(record, result);
      } else {
        persistence.terminal({
          status: "cancelled",
          finalText: null,
          error: "Child was cancelled before execution started.",
          usage: result.usage,
          turns: result.turns,
          costUsd: result.costUsd,
        });
        commitTerminalResult(record, result);
      }
      publishProgress({
        status: "cancelled",
        delegationId,
        task: input.task,
        elapsedMs: elapsedSince(lifecycle.startedAt),
        deadlineMs,
      });
      releaseResources();
    };
    let promise: Promise<SubagentCanonicalResult> | undefined;
    const run = (): Promise<SubagentCanonicalResult> => {
      promise ??= Promise.resolve()
        .then(() =>
          executeAccepted({
            delegationId,
            childAgentId,
            childRunId,
            toolCallId: input.toolCallId,
            task: input.task,
            focusPaths: input.focusPaths,
            systemPrompt,
            userMessage,
            childMaxCostUsd: childBudget.maxCostUsd,
            lifecycle,
            record,
            ...(persistence !== undefined ? { persistence } : {}),
          }),
        )
        .finally(releaseResources);
      return promise;
    };
    const cancelBeforeStart = (): void => {
      if (promise !== undefined) return;
      const result = cancelledBeforeStart();
      promise = Promise.resolve(result);
      publishCancelledBeforeStart(result);
    };
    return { kind: "accepted", record, run, cancelBeforeStart };
  };

  const prepareBatch = (
    entries: readonly DelegationBatchEntry[],
  ): DelegationBatch => {
    const inputs = entries.flatMap((entry) =>
      entry.kind === "request" ? [entry.request] : [],
    );
    const preparedIds = new Set(
      inputs.map((input) => `${options.parentRunId}:${input.toolCallId}`),
    );
    const freshAcceptedIds = new Set<string>();
    const seenCandidateIds = new Set<string>();
    const ownedAccepted: AcceptedDelegation[] = [];
    const candidates: PreparedDelegationCandidate[] = [];
    const recordRejection = (
      input: DelegationRequest,
      delegationId: string,
      content: string,
    ): void => {
      let durableContent = content;
      try {
        options.lifecyclePersistence?.rejected({
          delegationId,
          parentRunId: options.parentRunId,
          parentToolCallId: input.toolCallId,
          task: input.task,
          reason: content,
        });
      } catch (caught) {
        if (caught instanceof SubagentPersistenceError) throw caught;
        durableContent = `${content} Lifecycle receipt could not be stored: ${errorMessage(caught)}`;
      }
      receipts.set(delegationId, {
        kind: "rejected",
        result: rejectedDelegation(durableContent),
      });
    };
    for (const input of inputs) {
      const delegationId = `${options.parentRunId}:${input.toolCallId}`;
      if (receipts.has(delegationId) || seenCandidateIds.has(delegationId)) {
        continue;
      }
      seenCandidateIds.add(delegationId);
      if (options.providerBlocked?.() === true) {
        recordRejection(
          input,
          delegationId,
          "Delegation rejected: the root provider auth/quota circuit is open.",
        );
        continue;
      }
      if (options.provider.abortSignalSupport !== true) {
        recordRejection(
          input,
          delegationId,
          "Delegation rejected: the configured provider does not certify AbortSignal settlement.",
        );
        continue;
      }
      const invalidFocusPath = validateWorkspacePaths(
        options.workspace,
        input.focusPaths,
      );
      if (invalidFocusPath !== null) {
        recordRejection(
          input,
          delegationId,
          `Delegation rejected: invalid focus path. ${invalidFocusPath}`,
        );
        continue;
      }
      const systemPrompt = buildReadOnlySubagentSystemPrompt({
        workspace: options.workspace,
        platform: options.platform,
        ...(options.projectInstructions !== undefined
          ? { projectInstructions: options.projectInstructions }
          : {}),
        focusPaths: input.focusPaths,
      });
      const userMessage = childTaskMessage(
        delegationId,
        input.task,
        input.focusPaths,
      );
      const childInputOptions: StreamOptions = {
        systemPrompt,
        messages: [{ role: "user", content: userMessage }],
        signal: input.signal,
        toolExposure: { kind: "auto", profile: "read-only-subagent" },
      };
      const minimumInputTokens = estimateProviderInputTokens(options.provider, {
        ...childInputOptions,
        maxOutputTokens: MIN_USEFUL_OUTPUT_TOKENS,
      });
      if (minimumInputTokens === null) {
        recordRejection(
          input,
          delegationId,
          "Delegation rejected: the child request cost cannot be estimated.",
        );
        continue;
      }
      candidates.push({
        input,
        delegationId,
        systemPrompt,
        userMessage,
        minimumInputTokens,
      });
    }

    const admissionPlan = admission.plan(candidates);
    const capacityCandidates = admissionPlan.admitted;
    for (const { value: candidate, reason } of admissionPlan.rejected) {
      recordRejection(
        candidate.input,
        candidate.delegationId,
        admissionRejectionMessage(reason),
      );
    }

    const continuationMaxOutputTokens = Math.min(
      MAIN_CONTINUATION_MAX_OUTPUT_TOKENS,
      options.modelMaxOutputTokens ?? MAIN_CONTINUATION_MAX_OUTPUT_TOKENS,
    );
    let acceptedCandidates = capacityCandidates;
    const resultOutcomes = (): readonly SubagentResultOutcome[] =>
      entries.map((entry) => {
        if (entry.kind === "result") {
          return {
            toolCallId: entry.toolCallId,
            content: { kind: "exact", value: entry.content },
          };
        }
        const input = entry.request;
        const receipt = receipts.get(
          `${options.parentRunId}:${input.toolCallId}`,
        );
        if (receipt?.kind === "rejected") {
          return {
            toolCallId: input.toolCallId,
            content: { kind: "exact", value: receipt.result.content },
          };
        }
        if (receipt?.record.state.kind === "terminal") {
          const result = receipt.record.state.result;
          return {
            toolCallId: input.toolCallId,
            content: {
              kind: "projected",
              value: (maxResultChars: number) =>
                admittedAgentResult(result, maxResultChars),
            },
          };
        }
        return {
          toolCallId: input.toolCallId,
          content: { kind: "pending" },
        };
      });
    let resultAdmission = treeBudget.planResults(resultOutcomes());
    let budgetLease: SubagentTreeBudgetLeaseResult<PreparedDelegationCandidate> =
      {
        kind: "rejected",
      };
    for (;;) {
      resultAdmission = treeBudget.planResults(resultOutcomes());
      const children: SubagentTreeBudgetCandidate<PreparedDelegationCandidate>[] =
        acceptedCandidates.map((candidate) => ({
          value: candidate,
          minimumInputTokens: candidate.minimumInputTokens,
        }));
      budgetLease = treeBudget.leaseBatch({
        resultAdmission,
        children,
        continuationMaxOutputTokens,
      });
      if (budgetLease.kind === "granted") break;
      const rejectedCandidate = acceptedCandidates.at(-1);
      if (rejectedCandidate === undefined) break;
      recordRejection(
        rejectedCandidate.input,
        rejectedCandidate.delegationId,
        "Delegation rejected: the root budget cannot fund this child while preserving one admitted aggregate main continuation.",
      );
      acceptedCandidates = acceptedCandidates.slice(0, -1);
    }

    if (budgetLease.kind === "granted") {
      const preparedAccepted: PreparedAcceptedCandidate[] = [];
      for (const childBudget of budgetLease.children) {
        const candidate = childBudget.value;
        const childAgentId: AgentId = `agent-${randomUUID()}`;
        const childRunId: SubagentRunId = `subagent-${randomUUID()}`;
        try {
          const persistence = options.lifecyclePersistence?.accepted({
            delegationId: candidate.delegationId,
            childAgentId,
            childRunId,
            parentRunId: options.parentRunId,
            parentToolCallId: candidate.input.toolCallId,
            task: candidate.input.task,
            focusPaths: candidate.input.focusPaths,
            providerId: options.providerId,
            model: options.model,
            systemPrompt: candidate.systemPrompt,
          });
          preparedAccepted.push({
            childBudget,
            childAgentId,
            childRunId,
            ...(persistence !== undefined ? { persistence } : {}),
          });
        } catch (caught) {
          if (caught instanceof SubagentPersistenceError) throw caught;
          receipts.set(candidate.delegationId, {
            kind: "rejected",
            result: rejectedDelegation(
              `Delegation rejected: lifecycle could not be stored before child admission. ${errorMessage(caught)}`,
            ),
          });
        }
      }
      const admissionLeases = admission.commit(preparedAccepted);
      for (const admissionLease of admissionLeases) {
        const accepted = admissionLease.value;
        const childBudget = accepted.childBudget;
        const candidate = childBudget.value;
        const receipt = createAcceptedReceipt(
          childBudget,
          admissionLease,
          accepted.childAgentId,
          accepted.childRunId,
          accepted.persistence,
        );
        receipts.set(candidate.delegationId, receipt);
        freshAcceptedIds.add(candidate.delegationId);
        ownedAccepted.push(receipt);
        publishProgress({
          status: "queued",
          delegationId: candidate.delegationId,
          task: candidate.input.task,
          elapsedMs: 0,
          deadlineMs,
        });
      }
    }

    return {
      executor: createDelegationExecutor(async (input) => {
        const delegationId = `${options.parentRunId}:${input.toolCallId}`;
        const receipt = receipts.get(delegationId);
        if (!preparedIds.has(delegationId) || receipt === undefined) {
          return rejectedDelegation(
            "Delegation rejected: the call was not part of the prepared tool batch.",
          );
        }
        if (receipt.kind === "rejected") {
          return {
            ...receipt.result,
            content: admittedText(
              receipt.result.content,
              resultAdmission.maxResultChars,
            ).value,
          };
        }
        const result = await receipt.run();
        const content = admittedAgentResult(
          result,
          resultAdmission.maxResultChars,
        );
        if (freshAcceptedIds.delete(delegationId)) {
          return {
            delivery: "fresh",
            ok: result.status === "completed",
            content,
            usage: result.usage,
          };
        }
        return {
          delivery: "replayed",
          ok: result.status === "completed",
          content,
        };
      }),
      close: () => {
        for (const receipt of ownedAccepted) receipt.cancelBeforeStart();
        if (budgetLease.kind === "granted") budgetLease.release();
      },
    };
  };

  const capability: DelegationCapability = {
    available: () =>
      admission.available() && options.providerBlocked?.() !== true,
    prepareBatch,
    delegate: async (input) => {
      const batch = prepareBatch([{ kind: "request", request: input }]);
      try {
        return await batch.executor.delegate(input);
      } finally {
        batch.close();
      }
    },
  };

  return {
    capability,
    activeAgentRunCount: admission.activeAgentRunCount,
    activeChildRunCount: () => admission.activeAgentRunCount() - 1,
    totalAcceptedCount: admission.totalChildRunCount,
    runSnapshots: () =>
      [...receipts.values()].flatMap((receipt) =>
        receipt.kind === "accepted" ? [runSnapshot(receipt.record)] : [],
      ),
  };
}
