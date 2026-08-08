import { randomUUID } from "node:crypto";
import type { CostModel } from "../core/cost.ts";
import { errorMessage, isAbortThrow, KeelError } from "../core/error.ts";
import type { LLMProvider, Usage } from "../llm/types.ts";
import type {
  DelegationCapability,
  DelegationToolResult,
  SubmittedAgentResult,
} from "../tools/delegation.ts";
import { createAgentResultSubmissionCapability } from "../tools/delegation.ts";
import { resolveWorkspaceTarget } from "../tools/workspace-path.ts";
import type { ContextCompactionOptions } from "./context-compaction.ts";
import {
  createSharedCostBudgetedProvider,
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
const MAIN_SYNTHESIS_RESERVE_FRACTION = 0.25;
const MAX_ADMITTED_SUMMARY_CHARS = 4_000;
const MAX_ADMITTED_EVIDENCE = 10;
const MAX_ADMITTED_EVIDENCE_DETAIL_CHARS = 500;
const MAX_ADMITTED_RISKS = 5;
const MAX_ADMITTED_RISK_CHARS = 500;
const MAX_ADMITTED_ERROR_CHARS = 2_000;
const MAX_ADMITTED_ID_CHARS = 512;
const MAX_ADMITTED_TRANSCRIPT_REF_CHARS = 512;
const MAX_ADMITTED_RESULT_CHARS = 24_000;
const MAX_AGGREGATE_FALLBACK_SUMMARY_CHARS = 1_000;

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

interface SubagentCanonicalResult {
  readonly delegationId: string;
  readonly childRunId: string;
  readonly status: AgentTerminalStatus;
  readonly task: string;
  readonly submitted: SubmittedAgentResult | null;
  readonly usage: Usage;
  readonly turns: number;
  readonly costUsd: number;
  readonly transcriptRef: string | null;
  readonly error: string | null;
}

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
  readonly rootMaxCostUsd: number;
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
    "Submit the result through submit_agent_result when the investigation is complete.",
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

function admittedAgentResult(result: SubagentCanonicalResult): string {
  const submitted = result.status === "completed" ? result.submitted : null;
  const rawSummary =
    submitted === null
      ? (result.error ?? "The child did not submit a usable result.")
      : submitted.summary;
  const summaryLimit =
    submitted === null ? MAX_ADMITTED_ERROR_CHARS : MAX_ADMITTED_SUMMARY_CHARS;
  const delegationId = admittedText(result.delegationId, MAX_ADMITTED_ID_CHARS);
  const summary = admittedText(rawSummary, summaryLimit);
  const transcriptRefText =
    result.transcriptRef === null
      ? null
      : admittedText(result.transcriptRef, MAX_ADMITTED_TRANSCRIPT_REF_CHARS);
  const transcriptRef =
    transcriptRefText?.truncated === false ? transcriptRefText.value : null;
  const evidence =
    submitted?.evidence.slice(0, MAX_ADMITTED_EVIDENCE).map((item) => {
      const path = admittedText(item.path, 500);
      const detail = admittedText(
        item.detail,
        MAX_ADMITTED_EVIDENCE_DETAIL_CHARS,
      );
      return { item, path, detail };
    }) ?? [];
  const risks =
    submitted?.risks
      .slice(0, MAX_ADMITTED_RISKS)
      .map((risk) => admittedText(risk, MAX_ADMITTED_RISK_CHARS)) ?? [];
  const truncated =
    delegationId.truncated ||
    summary.truncated ||
    (submitted?.evidence.length ?? 0) > MAX_ADMITTED_EVIDENCE ||
    evidence.some((item) => item.path.truncated || item.detail.truncated) ||
    (submitted?.risks.length ?? 0) > MAX_ADMITTED_RISKS ||
    risks.some((risk) => risk.truncated) ||
    (result.transcriptRef !== null && transcriptRef === null);
  const projection = {
    delegationId: delegationId.value,
    status: result.status,
    transcriptRef,
    truncated,
    summary: summary.value,
    evidence: evidence.map(({ item, path, detail }) => ({
      path: path.value,
      ...(item.line !== undefined ? { line: item.line } : {}),
      detail: detail.value,
    })),
    risks: risks.map((risk) => risk.value),
  };
  const serialized = JSON.stringify(projection);
  if (serialized.length <= MAX_ADMITTED_RESULT_CHARS) return serialized;
  return JSON.stringify({
    delegationId: delegationId.value,
    status: result.status,
    transcriptRef,
    truncated: true,
    summary: admittedText(rawSummary, MAX_AGGREGATE_FALLBACK_SUMMARY_CHARS)
      .value,
    evidence: [],
    risks: [],
  });
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

function terminalStatusFromStopReason(
  stopReason: string,
  submitted: SubmittedAgentResult | null,
): AgentTerminalStatus {
  if (stopReason === "turn_limit") return "turn_limited";
  if (stopReason === "cost_budget") return "budget_limited";
  if (stopReason === "completed" && submitted !== null) return "completed";
  return "failed";
}

function terminalStatusFromError(
  error: unknown,
  signal: AbortSignal,
  deadlineExpired: boolean,
): AgentTerminalStatus {
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
    submitted:
      result.submitted === null
        ? null
        : {
            summary: result.submitted.summary,
            evidence: result.submitted.evidence.map((evidence) => ({
              ...evidence,
            })),
            risks: [...result.submitted.risks],
          },
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
      const submission = createAgentResultSubmissionCapability();
      const systemPrompt = buildReadOnlySubagentSystemPrompt({
        workspace: options.workspace,
        platform: options.platform,
        ...(options.projectInstructions !== undefined
          ? { projectInstructions: options.projectInstructions }
          : {}),
        focusPaths: input.focusPaths,
      });
      let transcriptMessages: readonly SessionMessage[] = [];
      let usage = zeroUsage();
      let turns = 0;
      let costUsd = 0;
      let status: AgentTerminalStatus = "failed";
      let error: string | null = null;
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
          userMessage: childTaskMessage(
            input.delegationId,
            input.task,
            input.focusPaths,
          ),
          userMessageOrigin: { type: "runtime_subagent_delegation" },
          systemPrompt,
          signal: input.lifecycle.abortController.signal,
          bash: { kind: "disabled" },
          toolProfile: "read-only-subagent",
          agentResultSubmission: submission,
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
            status = terminalStatusFromStopReason(
              event.stopReason,
              submission.accepted(),
            );
            if (status === "failed") {
              error = "Child ended without submit_agent_result.";
            }
          }
        }
      } catch (caught) {
        status = terminalStatusFromError(
          caught,
          input.lifecycle.abortController.signal,
          input.lifecycle.deadlineExpired(),
        );
        error = errorMessage(caught);
      }

      usage = childBudget.observedUsage();
      costUsd = childBudget.observedSpendUsd();

      const submitted = submission.accepted();
      if (
        submitted !== null &&
        validateWorkspacePaths(
          options.workspace,
          submitted.evidence.map((evidence) => evidence.path),
        ) !== null
      ) {
        status = "failed";
        error = "Submitted evidence includes an invalid workspace path.";
      }
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
            systemPrompt,
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
        status = "failed";
        error = `Child transcript could not be stored: ${saved.reason}`;
      }
      if (input.lifecycle.deadlineExpired()) {
        status = "timed_out";
        error = "Child exceeded its full lifecycle deadline.";
      } else if (input.lifecycle.abortController.signal.aborted) {
        status = "cancelled";
        error = "Child was cancelled before lifecycle settlement completed.";
      }
      const result: SubagentCanonicalResult = {
        delegationId: input.delegationId,
        childRunId: input.childRunId,
        status,
        task: input.task,
        submitted,
        usage,
        turns,
        costUsd,
        transcriptRef: saved.status === "stored" ? saved.ref : null,
        error,
      };
      commitTerminalResult(input.record, result);
      progress(status);
      return {
        delivery: "fresh",
        ok: status === "completed",
        content: admittedAgentResult(result),
        usage,
      };
    } finally {
      input.lifecycle.cleanup();
      activeRuns--;
    }
  };

  const capability: DelegationCapability = {
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
      const remainingUsd = options.rootBudget.remainingUsd();
      const synthesisReserveUsd =
        options.rootMaxCostUsd * MAIN_SYNTHESIS_RESERVE_FRACTION;
      const childMaxCostUsd = remainingUsd - synthesisReserveUsd;
      if (childMaxCostUsd <= 0) {
        const result = rejectedDelegation(
          "Delegation rejected: the root budget cannot fund a child while preserving the main synthesis reserve.",
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
            childMaxCostUsd,
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
                  submitted: null,
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
