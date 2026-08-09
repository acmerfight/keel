import { randomUUID } from "node:crypto";
import type { CostModel } from "../core/cost.ts";
import { errorMessage, isAbortThrow, KeelError } from "../core/error.ts";
import type { ReadResourceObservation } from "../core/resource-observation.ts";
import { copyReadResourceObservation } from "../core/resource-observation.ts";
import type { LLMProvider, StreamOptions, Usage } from "../llm/types.ts";
import type {
  DelegationCapability,
  DelegationToolResult,
} from "../tools/delegation.ts";
import { resolveWorkspaceTarget } from "../tools/workspace-path.ts";
import type { ContextCompactionOptions } from "./context-compaction.ts";
import {
  createSharedCostBudgetedProvider,
  estimateProviderInputTokens,
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
  AbortableToolOutputArtifactStore,
  ToolOutputArtifactSaveResult,
} from "./tool-output-artifacts.ts";

const DEFAULT_CHILD_DEADLINE_MS = 120_000;
const DEFAULT_SETTLEMENT_GRACE_MS = 2_000;
const DEFAULT_CHILD_MAX_TURNS = 16;
const MAIN_CONTINUATION_MAX_OUTPUT_TOKENS = 4_096;
const MAX_ADMITTED_FINAL_TEXT_CHARS = 4_000;
const MAX_ADMITTED_OBSERVED_RESOURCES = 20;
const MAX_ADMITTED_RESOURCE_PATH_CHARS = 500;
const MAX_ADMITTED_ERROR_CHARS = 2_000;
const MAX_ADMITTED_ID_CHARS = 512;
const MAX_ADMITTED_TRANSCRIPT_REF_CHARS = 512;
const MAX_ADMITTED_RESULT_CHARS = 24_000;
const MAIN_CONTINUATION_TOOL_RESULT_TOKEN_RESERVE =
  MAX_ADMITTED_RESULT_CHARS + 512;
const MAX_AGGREGATE_FALLBACK_TEXT_CHARS = 1_000;

type AgentTerminalStatus =
  | "completed"
  | "failed"
  | "turn_limited"
  | "timed_out"
  | "budget_limited"
  | "provider_blocked"
  | "cancelled";

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

interface ObservedSubagentResource {
  readonly path: string;
  readonly offset?: number;
  readonly limit?: number;
  readonly observation: ReadResourceObservation;
}

interface SubagentCanonicalResultBase {
  readonly delegationId: string;
  readonly childRunId: string;
  readonly task: string;
  readonly observedResources: readonly ObservedSubagentResource[];
  readonly usage: Usage;
  readonly turns: number;
  readonly costUsd: number;
  readonly transcriptRef: string | null;
}

type SubagentCanonicalResult = SubagentCanonicalResultBase &
  ChildTerminalOutcome;

type ChildTerminalOutcome =
  | {
      readonly status: "completed";
      readonly finalText: string;
      readonly error: null;
    }
  | {
      readonly status: Exclude<AgentTerminalStatus, "completed">;
      readonly finalText: null;
      readonly error: string;
    };

interface AcceptedDelegation {
  readonly kind: "accepted";
  readonly promise: Promise<
    Extract<DelegationToolResult, { readonly delivery: "fresh" }>
  >;
  readonly record: SubagentRunRecord;
}

interface SubagentRunRecord {
  readonly delegationId: string;
  readonly childRunId: string;
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
      readonly childRunId: string;
      readonly task: string;
      readonly state: "queued" | "running";
      readonly terminal: null;
    }
  | {
      readonly delegationId: string;
      readonly childRunId: string;
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

export interface SubagentSupervisor {
  readonly capability: DelegationCapability;
  readonly activeRunCount: () => number;
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
  readonly now: () => number;
  readonly onProgress: (event: SubagentProgressEvent) => void;
  readonly deadlineMs?: number;
  readonly settlementGraceMs?: number;
  readonly maxTurns?: number;
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
    "Return one concise final answer with the findings, exact workspace paths you inspected, and remaining uncertainty.",
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
  return text.length <= maxChars
    ? { value: text, truncated: false }
    : {
        value: `${text.slice(0, maxChars - 3)}...`,
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

function admittedAgentResult(result: SubagentCanonicalResult): string {
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
  const observedResources = result.observedResources
    .slice(0, MAX_ADMITTED_OBSERVED_RESOURCES)
    .map((resource) => ({
      resource,
      path: admittedText(resource.path, MAX_ADMITTED_RESOURCE_PATH_CHARS),
    }));
  const truncated =
    delegationId.truncated ||
    admittedResultText.truncated ||
    result.observedResources.length > MAX_ADMITTED_OBSERVED_RESOURCES ||
    observedResources.some((item) => item.path.truncated) ||
    (result.transcriptRef !== null && transcriptRef === null);
  const projection = {
    delegationId: delegationId.value,
    status: result.status,
    transcriptRef,
    childLimitReached: true,
    truncated,
    ...admittedTerminalText(result, admittedResultText.value),
    observedResources: observedResources.map(({ resource, path }) => ({
      path: path.value,
      ...(resource.offset !== undefined ? { offset: resource.offset } : {}),
      ...(resource.limit !== undefined ? { limit: resource.limit } : {}),
    })),
  };
  const serialized = JSON.stringify(projection);
  if (serialized.length <= MAX_ADMITTED_RESULT_CHARS) return serialized;
  return JSON.stringify({
    delegationId: delegationId.value,
    status: result.status,
    transcriptRef,
    childLimitReached: true,
    truncated: true,
    ...admittedTerminalText(
      result,
      admittedText(rawText, MAX_AGGREGATE_FALLBACK_TEXT_CHARS).value,
    ),
    observedResources: [],
  });
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

function observedChildResources(
  messages: readonly SessionMessage[],
): readonly ObservedSubagentResource[] {
  const readCalls = new Map<
    string,
    {
      readonly path: string;
      readonly offset?: number;
      readonly limit?: number;
    }
  >();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const toolCall of message.toolCalls) {
      /* v8 ignore start -- the fixed read-only child catalog cannot produce MCP calls; keep the guard for the wider SessionMessage contract. */
      if ("kind" in toolCall) continue;
      /* v8 ignore stop */
      if (toolCall.tool !== "read") continue;
      readCalls.set(toolCall.id, {
        path: toolCall.path,
        ...(toolCall.offset !== undefined ? { offset: toolCall.offset } : {}),
        ...(toolCall.limit !== undefined ? { limit: toolCall.limit } : {}),
      });
    }
  }
  const resources: ObservedSubagentResource[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    if (message.role !== "tool" || message.resourceObservation === undefined)
      continue;
    /* v8 ignore next -- successful read observations are emitted from the same canonical tool call ledger; retain fail-closed handling if that internal invariant changes. */
    const readCall = readCalls.get(message.toolCallId);
    /* v8 ignore next -- see the canonical read-observation invariant above. */
    if (readCall === undefined) continue;
    const key = JSON.stringify(readCall);
    if (seen.has(key)) continue;
    seen.add(key);
    resources.push({
      ...readCall,
      observation: copyReadResourceObservation(message.resourceObservation),
    });
  }
  return resources;
}

function transcriptContent(input: {
  readonly delegationId: string;
  readonly childRunId: string;
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
): ChildTerminalOutcome {
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
    observedResources: result.observedResources.map((resource) => ({
      ...resource,
      observation: copyReadResourceObservation(resource.observation),
    })),
    usage: { ...result.usage },
  };
}

function runSnapshot(record: SubagentRunRecord): SubagentRunSnapshot {
  if (record.state.kind === "terminal") {
    return {
      delegationId: record.delegationId,
      childRunId: record.childRunId,
      task: record.task,
      state: "terminal",
      terminal: cloneCanonicalResult(record.state.result),
    };
  }
  return {
    delegationId: record.delegationId,
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
  let activeRuns = 0;
  let acceptedRuns = 0;
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
    readonly childRunId: string;
    readonly toolCallId: string;
    readonly task: string;
    readonly focusPaths: readonly string[];
    readonly systemPrompt: string;
    readonly userMessage: string;
    readonly childMaxCostUsd: number;
    readonly lifecycle: ChildLifecycle;
    readonly record: SubagentRunRecord;
  }): Promise<
    Extract<DelegationToolResult, { readonly delivery: "fresh" }>
  > => {
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
    input.record.state = { kind: "running" };
    progress("running");
    try {
      let transcriptMessages: readonly SessionMessage[] = [];
      let usage = zeroUsage();
      let turns = 0;
      let costUsd = 0;
      let terminal: ChildTerminalOutcome = {
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
          onTranscriptReady: (messages) => {
            transcriptMessages = messages;
          },
          onAgentLoopTurnCompleted: (accounting) => {
            turns = accounting.turns;
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
      const observedResources = observedChildResources(transcriptMessages);
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
      const resultBase: SubagentCanonicalResultBase = {
        delegationId: input.delegationId,
        childRunId: input.childRunId,
        task: input.task,
        observedResources,
        usage,
        turns,
        costUsd,
        transcriptRef: saved.status === "stored" ? saved.ref : null,
      };
      const result: SubagentCanonicalResult = { ...resultBase, ...terminal };
      commitTerminalResult(input.record, result);
      progress(result.status);
      return {
        delivery: "fresh",
        ok: result.status === "completed",
        content: admittedAgentResult(result),
        usage,
      };
    } finally {
      input.lifecycle.cleanup();
      activeRuns--;
    }
  };

  const capability: DelegationCapability = {
    available: () => acceptedRuns === 0,
    delegate: async (input) => {
      const delegationId = `${options.parentRunId}:${input.toolCallId}`;
      const existing = receipts.get(delegationId);
      if (existing?.kind === "rejected") return existing.result;
      if (existing?.kind === "accepted") {
        const result = await existing.promise;
        return {
          delivery: "replayed",
          ok: result.ok,
          content: result.content,
        };
      }

      if (options.provider.abortSignalSupport !== true) {
        const result = rejectedDelegation(
          "Delegation rejected: the configured provider does not certify AbortSignal settlement.",
        );
        receipts.set(delegationId, { kind: "rejected", result });
        return result;
      }

      const invalidFocusPath = validateWorkspacePaths(
        options.workspace,
        input.focusPaths,
      );
      if (invalidFocusPath !== null) {
        const result = rejectedDelegation(
          `Delegation rejected: invalid focus path. ${invalidFocusPath}`,
        );
        receipts.set(delegationId, { kind: "rejected", result });
        return result;
      }
      if (acceptedRuns >= 1) {
        const result = rejectedDelegation(
          "Delegation rejected: Slice 1 permits only one accepted child per root run.",
        );
        receipts.set(delegationId, { kind: "rejected", result });
        return result;
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
      const minimumChildInputTokens = estimateProviderInputTokens(
        options.provider,
        childInputOptions,
      );
      const continuationMaxOutputTokens = Math.min(
        MAIN_CONTINUATION_MAX_OUTPUT_TOKENS,
        options.modelMaxOutputTokens ?? MAIN_CONTINUATION_MAX_OUTPUT_TOKENS,
      );
      const continuationLease =
        minimumChildInputTokens === null
          ? { kind: "rejected" as const }
          : options.rootBudget.leaseContinuation({
              additionalInputTokens:
                MAIN_CONTINUATION_TOOL_RESULT_TOKEN_RESERVE,
              maxOutputTokens: continuationMaxOutputTokens,
              minimumChildInputTokens,
            });
      if (continuationLease.kind !== "granted") {
        const result = rejectedDelegation(
          "Delegation rejected: the root budget cannot fund a child while preserving an admitted main continuation lease.",
        );
        receipts.set(delegationId, { kind: "rejected", result });
        return result;
      }

      const childRunId = `subagent-${randomUUID()}`;
      acceptedRuns++;
      const record: SubagentRunRecord = {
        delegationId,
        childRunId,
        task: input.task,
        state: { kind: "queued" },
      };
      let startExecution: (lifecycle: ChildLifecycle) => void = () => {};
      const promise = new Promise<
        Extract<DelegationToolResult, { readonly delivery: "fresh" }>
      >((resolve, reject) => {
        startExecution = (lifecycle) => {
          void executeAccepted({
            delegationId,
            childRunId,
            toolCallId: input.toolCallId,
            task: input.task,
            focusPaths: input.focusPaths,
            systemPrompt,
            userMessage,
            childMaxCostUsd: continuationLease.childMaxCostUsd,
            lifecycle,
            record,
          })
            /* v8 ignore start -- executeAccepted normalizes provider, tool, storage, cancellation, and observer failures; this is the last-resort promise containment boundary. */
            .catch(
              (
                caught,
              ): Extract<
                DelegationToolResult,
                { readonly delivery: "fresh" }
              > => {
                const usage = zeroUsage();
                const result: SubagentCanonicalResult = {
                  delegationId,
                  childRunId,
                  status: "failed",
                  task: input.task,
                  finalText: null,
                  observedResources: [],
                  usage,
                  turns: 0,
                  costUsd: 0,
                  transcriptRef: null,
                  error: `Unexpected child lifecycle failure: ${errorMessage(caught)}`,
                };
                if (record.state.kind !== "terminal")
                  commitTerminalResult(record, result);
                publishProgress({
                  status: "failed",
                  delegationId,
                  task: input.task,
                  elapsedMs: elapsedSince(lifecycle.startedAt),
                  deadlineMs,
                });
                return {
                  delivery: "fresh",
                  ok: false,
                  content: admittedAgentResult(result),
                  usage,
                };
              },
            )
            /* v8 ignore stop */
            .then(resolve, reject);
        };
      });
      const receipt: AcceptedDelegation = {
        kind: "accepted",
        promise,
        record,
      };
      receipts.set(delegationId, receipt);
      const lifecycle = createLifecycle(input.signal);
      activeRuns++;
      publishProgress({
        status: "queued",
        delegationId,
        task: input.task,
        elapsedMs: 0,
        deadlineMs,
      });
      startExecution(lifecycle);
      return promise;
    },
  };

  return {
    capability,
    activeRunCount: () => activeRuns,
    totalAcceptedCount: () => acceptedRuns,
    runSnapshots: () =>
      [...receipts.values()].flatMap((receipt) =>
        receipt.kind === "accepted" ? [runSnapshot(receipt.record)] : [],
      ),
  };
}
