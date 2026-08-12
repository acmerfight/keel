import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  type CostModel,
  calculateConservativeRequestCostUsd,
} from "../core/cost.ts";
import { errorMessage, isAbortThrow, KeelError } from "../core/error.ts";
import type { LLMProvider, StreamOptions, Usage } from "../llm/types.ts";
import { mcpProviderSchemaTarget } from "../mcp/provider-schema.ts";
import type {
  DelegationBatch,
  DelegationBatchEntry,
  DelegationCapability,
  DelegationRequest,
  DelegationToolResult,
} from "../tools/delegation.ts";
import {
  createDelegationExecutor,
  projectDelegationRejection,
} from "../tools/delegation.ts";
import { resolveWorkspaceTarget } from "../tools/workspace-path.ts";
import type { ContextCompactionOptions } from "./context-compaction.ts";
import {
  createSharedCostBudgetedProvider,
  estimateProviderInputTokens,
  MIN_USEFUL_OUTPUT_TOKENS,
  type SharedCostBudgetAccount,
  type SharedCostBudgetedProvider,
} from "./cost-budget.ts";
import {
  type AgentInjectedUserMessageQueue,
  runAgent,
  type SubagentWorkspaceRunOptions,
} from "./loop.ts";
import type {
  MainModelOperationInstrumentation,
  SubagentModelOperationInstrumentation,
} from "./model-operations.ts";
import type { ProjectInstructions } from "./prompt.ts";
import {
  appendWorkflowSkillCatalogToSystemPrompt,
  buildSubagentSystemPrompt,
} from "./prompt.ts";
import { projectSessionMessageToProvider } from "./session-ledger.ts";
import type { SessionMessage } from "./session-message.ts";
import { maxTurnFallbackPolicy } from "./stop-policy.ts";
import {
  compareSubagentCapability,
  narrowSubagentCapabilityToCeiling,
  type ReadOnlySubagentCapabilitySnapshot,
  SUBAGENT_MAX_FINAL_TEXT_CHARS,
  type SubagentCapabilitySnapshot,
  type SubagentMcpToolSelector,
  selectSubagentCapabilityMcpTools,
  selectSubagentCapabilitySkills,
  skillDescriptorFromSubagentSnapshot,
  subagentCapabilityBaseProfile,
  subagentCapabilityFingerprint,
  subagentCapabilityIsWriter,
  subagentCapabilityWithMcpTools,
  subagentCapabilityWithSkills,
  type WriterSubagentCapabilitySnapshot,
} from "./subagent-capability.ts";
import type {
  AgentId,
  SubagentAcceptedLifecycle,
  SubagentCanonicalResult,
  SubagentLifecyclePersistence,
  SubagentRunId,
  SubagentRunningPersistence,
  SubagentRunPersistence,
  SubagentTerminalOutcome,
  SubagentTerminalStatus,
} from "./subagent-lifecycle.ts";
import { SubagentPersistenceError } from "./subagent-lifecycle.ts";
import type {
  SubagentExecutionSnapshot,
  SubagentProfileRegistry,
} from "./subagent-profile.ts";
import {
  createSubagentTreeAdmission,
  type SubagentAdmissionLease,
  type SubagentAdmissionRejection,
  type SubagentTreeAdmission,
} from "./subagent-tree-admission.ts";
import {
  createSubagentTreeBudget,
  MAX_SUBAGENT_RESULT_CHARS,
  type SubagentChildBudgetLease,
  type SubagentResultContinuationBudget,
  type SubagentResultOutcome,
  type SubagentTreeBudgetCandidate,
  type SubagentTreeBudgetLeaseResult,
} from "./subagent-tree-budget.ts";
import type {
  SubagentWriteWorkspaceLease,
  SubagentWriteWorkspaceReference,
  SubagentWriteWorkspaceResult,
  SubagentWriteWorkspaceRuntime,
  SubagentWriteWorkspaceSettlement,
} from "./subagent-workspace.ts";
import type {
  AbortableToolOutputArtifactStore,
  ToolOutputArtifactSaveResult,
} from "./tool-output-artifacts.ts";

const DEFAULT_SETTLEMENT_GRACE_MS = 2_000;
const MAIN_CONTINUATION_MAX_OUTPUT_TOKENS = 4_096;
const MAX_ADMITTED_ERROR_CHARS = 2_000;
const MAX_ADMITTED_ID_CHARS = 512;
const MAX_ADMITTED_TRANSCRIPT_REF_CHARS = 512;
const MAX_ADMITTED_WORKSPACE_SUMMARY_CHARS = 1_000;
const MAX_ADMITTED_WORKSPACE_ERROR_CHARS = 1_000;
const MAX_QUEUED_INPUT_MESSAGES = 16;
const MAX_QUEUED_INPUT_CHARS = 64_000;

async function awaitWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw signal.reason;
  return await new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

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
  readonly mode: "foreground" | "background";
  readonly record: SubagentRunRecord;
  readonly run: () => Promise<SubagentCanonicalResult>;
  readonly cancelBeforeStart: () => void;
  readonly cancel: () => void;
  readonly input: SubagentBackgroundRun["input"];
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
  readonly cancel: (reason: unknown) => void;
  readonly cleanup: () => void;
}

interface RejectedDelegation {
  readonly kind: "rejected";
  readonly rejection: DelegationRejection;
}

type DelegationReceipt = AcceptedDelegation | RejectedDelegation;

interface PreparedDelegationCandidateBase {
  readonly input: DelegationRequest;
  readonly toolName: "delegate" | "agent_resume";
  readonly delegationId: string;
  readonly execution: SubagentExecutionRuntime;
  readonly roleInstructions: string;
  readonly systemPrompt: string;
  readonly userMessage: string;
  readonly minimumCostUsd: number;
  readonly priorMessages?: readonly SessionMessage[];
}

type PreparedDelegationCandidate = PreparedDelegationCandidateBase &
  (
    | {
        readonly workspaceAccess: "read_only";
        readonly capability: ReadOnlySubagentCapabilitySnapshot;
        readonly threadCapabilityCeiling: ReadOnlySubagentCapabilitySnapshot;
      }
    | {
        readonly workspaceAccess: "isolated_write";
        readonly capability: WriterSubagentCapabilitySnapshot;
        readonly threadCapabilityCeiling: WriterSubagentCapabilitySnapshot;
      }
  );

type PreparedAcceptedWorkspace =
  | {
      readonly kind: "read_only";
      readonly capability: ReadOnlySubagentCapabilitySnapshot;
    }
  | {
      readonly kind: "isolated_write";
      readonly capability: WriterSubagentCapabilitySnapshot;
      readonly lease: SubagentWriteWorkspaceLease;
    };

type PreparedWriteWorkspace = Extract<
  ReturnType<SubagentWriteWorkspaceRuntime["prepare"]>,
  { readonly kind: "prepared" }
>["workspace"];

interface PreparedAcceptedCandidateBase {
  readonly childBudget: SubagentChildBudgetLease<PreparedDelegationCandidate>;
  readonly childAgentId: AgentId;
  readonly childRunId: SubagentRunId;
  readonly systemPrompt: string;
}

type PreparedAcceptedCandidate = PreparedAcceptedCandidateBase &
  (
    | {
        readonly kind: "runnable";
        readonly workspace: PreparedAcceptedWorkspace;
        readonly persistence?: SubagentRunPersistence;
      }
    | {
        readonly kind: "terminal";
        readonly result: SubagentCanonicalResult;
      }
  );

export interface SubagentSupervisor {
  readonly capability: DelegationCapability;
  readonly resultContinuationBudget: SubagentResultContinuationBudget;
  readonly activeAgentRunCount: () => number;
  readonly activeChildRunCount: () => number;
  readonly totalAcceptedCount: () => number;
  readonly runSnapshots: () => readonly SubagentRunSnapshot[];
  readonly continuation: SubagentContinuationCapability;
}

interface SubagentContinuationRequestBase {
  readonly childAgentId: AgentId;
  readonly previousRunId: SubagentRunId;
  readonly execution: SubagentExecutionSnapshot;
  readonly toolCallId: string;
  readonly message: string;
  readonly skills: readonly string[];
  readonly mcp: readonly SubagentMcpToolSelector[];
  readonly focusPaths: readonly string[];
  readonly systemPrompt: string;
  readonly priorMessages: readonly SessionMessage[];
  readonly signal: AbortSignal;
}

export type SubagentContinuationRequest = SubagentContinuationRequestBase &
  (
    | {
        readonly workspaceAccess: "read_only";
        readonly capability: ReadOnlySubagentCapabilitySnapshot;
        readonly threadCapabilityCeiling: ReadOnlySubagentCapabilitySnapshot;
        readonly workspace: null;
      }
    | {
        readonly workspaceAccess: "isolated_write";
        readonly capability: WriterSubagentCapabilitySnapshot;
        readonly threadCapabilityCeiling: WriterSubagentCapabilitySnapshot;
        readonly workspace: SubagentWriteWorkspaceReference;
      }
  );

interface SubagentContinuationResult {
  readonly ok: boolean;
  readonly content: string;
}

export interface SubagentContinuationCapability {
  readonly resume: (
    request: SubagentContinuationRequest,
  ) => Promise<SubagentContinuationResult>;
}

type SubagentInputResult =
  | { readonly kind: "accepted" }
  | { readonly kind: "closed" }
  | { readonly kind: "full" };

export interface SubagentBackgroundRun {
  readonly delegationId: string;
  readonly childAgentId: AgentId;
  readonly childRunId: SubagentRunId;
  readonly task: string;
  readonly result: Promise<SubagentCanonicalResult>;
  readonly cancel: () => void;
  readonly input: (message: string) => SubagentInputResult;
}

export interface SubagentBackgroundRuntime {
  readonly signal: AbortSignal;
  readonly register: (run: SubagentBackgroundRun) => void;
}

interface CreateSubagentSupervisorOptionsBase {
  readonly workspace: string;
  readonly platform: string;
  readonly parentRunId: string;
  readonly rootBudget: SharedCostBudgetedProvider;
  readonly sharedCostBudget: SharedCostBudgetAccount;
  readonly profileRegistry: SubagentProfileRegistry;
  readonly writeWorkspace?: SubagentWriteWorkspaceRuntime;
  readonly resolveExecution: (
    execution: SubagentExecutionSnapshot,
  ) => SubagentExecutionRuntime;
  readonly admission?: SubagentTreeAdmission;
  readonly projectInstructions?: ProjectInstructions;
  readonly hiddenWorkspacePaths?: readonly string[];
  readonly modelMaxOutputTokens?: number;
  readonly modelOperations?: MainModelOperationInstrumentation;
  readonly transcriptStore: AbortableToolOutputArtifactStore;
  readonly now: () => number;
  readonly onProgress: (event: SubagentProgressEvent) => void;
  readonly settlementGraceMs?: number;
  readonly maxActiveAgentRuns?: number;
  readonly maxTotalChildRuns?: number;
  readonly providerBlocked?: () => boolean;
}

export interface SubagentExecutionRuntime {
  readonly snapshot: SubagentExecutionSnapshot;
  readonly provider: LLMProvider;
  readonly costModel: CostModel;
  readonly contextCompaction?: ContextCompactionOptions;
  readonly modelMaxOutputTokens?: number;
}

type CreateSubagentSupervisorOptions = CreateSubagentSupervisorOptionsBase &
  (
    | {
        readonly background?: never;
        readonly backgroundModelOperations?: never;
        readonly lifecyclePersistence?: SubagentLifecyclePersistence;
      }
    | {
        readonly background: SubagentBackgroundRuntime;
        readonly backgroundModelOperations:
          | MainModelOperationInstrumentation
          | undefined;
        readonly lifecyclePersistence: SubagentLifecyclePersistence;
      }
  );

function zeroUsage(): Usage {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    uncachedInputTokens: 0,
    outputTokens: 0,
  };
}

interface SubagentInputQueue extends AgentInjectedUserMessageQueue {
  readonly enqueue: (message: string) => SubagentInputResult;
  readonly close: () => readonly Extract<
    SessionMessage,
    { readonly role: "user" }
  >[];
}

function createSubagentInputQueue(): SubagentInputQueue {
  type InputMessage = Extract<SessionMessage, { readonly role: "user" }>;
  let open = true;
  let queuedChars = 0;
  let messages: InputMessage[] = [];
  const drain = (): readonly InputMessage[] => {
    const drained = messages;
    messages = [];
    queuedChars = 0;
    return drained;
  };
  const close = (): readonly InputMessage[] => {
    open = false;
    return drain();
  };
  return {
    enqueue: (message) => {
      if (!open) return { kind: "closed" };
      if (
        messages.length >= MAX_QUEUED_INPUT_MESSAGES ||
        queuedChars + message.length > MAX_QUEUED_INPUT_CHARS
      ) {
        return { kind: "full" };
      }
      messages.push({
        role: "user",
        content: message,
        origin: { type: "runtime_subagent_input" },
      });
      queuedChars += message.length;
      return { kind: "accepted" };
    },
    drain,
    closeAtTerminalBoundary: () => {
      if (messages.length > 0) {
        return { kind: "continue", messages: drain() };
      }
      open = false;
      return { kind: "closed" };
    },
    close,
  };
}

type RejectedDelegationResult = Extract<
  DelegationToolResult,
  { readonly delivery: "rejected" }
>;
interface DelegationRejection {
  readonly reason: string;
  readonly recovery: string;
}

function rejectedDelegation(
  rejection: DelegationRejection,
  maxResultChars: number,
): RejectedDelegationResult {
  return {
    delivery: "rejected",
    ok: false,
    ...rejection,
    maxResultChars,
  };
}

function admissionRejection(
  reason: SubagentAdmissionRejection,
): DelegationRejection {
  switch (reason) {
    case "active_limit":
      return {
        reason:
          "Delegation rejected: the root-inclusive active agent limit is reached.",
        recovery:
          "Wait for or cancel a running child, or continue the investigation in Main before delegating again.",
      };
    case "total_limit":
      return {
        reason:
          "Delegation rejected: the total child limit for this root run is reached.",
        recovery:
          "Continue the investigation in Main because this root run cannot admit another child.",
      };
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

function selectRequestedCapability<
  Capability extends SubagentCapabilitySnapshot,
>(
  capability: Capability,
  skills: readonly string[],
  mcp: readonly SubagentMcpToolSelector[],
):
  | { readonly kind: "selected"; readonly capability: Capability }
  | { readonly kind: "skills_rejected" }
  | { readonly kind: "mcp_rejected" } {
  const skillCapability = selectSubagentCapabilitySkills(capability, skills);
  if (skillCapability === null) return { kind: "skills_rejected" };
  const selected = selectSubagentCapabilityMcpTools(skillCapability, mcp);
  return selected === null
    ? { kind: "mcp_rejected" }
    : { kind: "selected", capability: selected };
}

function childHiddenWorkspacePaths(
  parentWorkspace: string,
  childWorkspace: string,
  paths: readonly string[],
): readonly string[] {
  if (paths.length === 0) return [];
  const parentRoot = resolve(parentWorkspace);
  return paths.flatMap((path) => {
    const absolute = isAbsolute(path)
      ? resolve(path)
      : resolve(parentRoot, path);
    const fromParent = relative(parentRoot, absolute);
    if (
      fromParent === ".." ||
      fromParent.startsWith(`..${sep}`) ||
      isAbsolute(fromParent)
    ) {
      return [];
    }
    return [resolve(childWorkspace, fromParent)];
  });
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

interface ProjectedWriteWorkspace {
  readonly kind: "isolated_write";
  readonly baseCommit: string;
  readonly branch: string;
  readonly disposition: SubagentWriteWorkspaceResult["disposition"];
  readonly worktreePath: string | null;
  readonly patchRef: string | null;
  readonly patchSha256: string | null;
  readonly patchSourceTruncated: boolean;
  readonly summary?: string;
  readonly error?: string;
  readonly worktreePathOmitted?: true;
}

interface WriteWorkspaceProjection {
  readonly value: ProjectedWriteWorkspace | null;
  readonly truncated: boolean;
}

function writeWorkspaceProjections(
  workspace: SubagentWriteWorkspaceResult | null,
): readonly WriteWorkspaceProjection[] {
  if (workspace === null) return [{ value: null, truncated: false }];
  const summary = admittedText(
    workspace.summary,
    MAX_ADMITTED_WORKSPACE_SUMMARY_CHARS,
  );
  const workspaceError =
    workspace.error === null
      ? null
      : admittedText(workspace.error, MAX_ADMITTED_WORKSPACE_ERROR_CHARS);
  const core = {
    kind: workspace.kind,
    baseCommit: workspace.baseCommit,
    branch: workspace.branch,
    disposition: workspace.disposition,
    patchRef: workspace.patchRef,
    patchSha256: workspace.patchSha256,
    patchSourceTruncated: workspace.patchSourceTruncated,
  } satisfies Omit<
    ProjectedWriteWorkspace,
    "error" | "summary" | "worktreePath" | "worktreePathOmitted"
  >;
  const withPath = {
    ...core,
    worktreePath: workspace.worktreePath,
  } satisfies ProjectedWriteWorkspace;
  const projections: WriteWorkspaceProjection[] = [
    {
      value: {
        ...withPath,
        summary: summary.value,
        ...(workspaceError === null ? {} : { error: workspaceError.value }),
      },
      truncated: summary.truncated || workspaceError?.truncated === true,
    },
  ];
  if (workspaceError !== null) {
    projections.push({
      value: { ...withPath, error: workspaceError.value },
      truncated: true,
    });
  }
  projections.push({ value: withPath, truncated: true });
  if (workspace.worktreePath !== null) {
    projections.push({
      value: {
        ...core,
        worktreePath: null,
        worktreePathOmitted: true,
      },
      truncated: true,
    });
  }
  return projections;
}

export function projectSubagentResult(
  result: SubagentCanonicalResult,
  maxResultChars = MAX_SUBAGENT_RESULT_CHARS,
): string {
  const rawText =
    result.status === "completed" ? result.finalText : result.error;
  const textLimit =
    result.status === "completed"
      ? SUBAGENT_MAX_FINAL_TEXT_CHARS
      : MAX_ADMITTED_ERROR_CHARS;
  const delegationId = admittedText(result.delegationId, MAX_ADMITTED_ID_CHARS);
  const agentId = admittedText(result.childAgentId, MAX_ADMITTED_ID_CHARS);
  const runId = admittedText(result.childRunId, MAX_ADMITTED_ID_CHARS);
  const admittedResultText = admittedText(rawText, textLimit);
  const transcriptRefText =
    result.transcriptRef === null
      ? null
      : admittedText(result.transcriptRef, MAX_ADMITTED_TRANSCRIPT_REF_CHARS);
  const transcriptRef =
    transcriptRefText?.truncated === false ? transcriptRefText.value : null;
  const truncated =
    delegationId.truncated ||
    agentId.truncated ||
    runId.truncated ||
    admittedResultText.truncated ||
    (result.transcriptRef !== null && transcriptRef === null);
  const serialize = (
    admittedDelegationId: string,
    value: string,
    admittedTranscriptRef: string | null,
    workspace: ProjectedWriteWorkspace | null,
    isTruncated: boolean,
  ): string =>
    JSON.stringify({
      delegationId: admittedDelegationId,
      agentId: agentId.value,
      runId: runId.value,
      status: result.status,
      transcriptRef: admittedTranscriptRef,
      pendingInputCount: result.pendingInputCount,
      workspace,
      truncated: isTruncated,
      ...admittedTerminalText(result, value),
    });
  const workspaceProjections = writeWorkspaceProjections(result.workspace);
  for (const workspace of workspaceProjections) {
    const serialized = serialize(
      delegationId.value,
      admittedResultText.value,
      transcriptRef,
      workspace.value,
      truncated || workspace.truncated,
    );
    if (serialized.length <= maxResultChars) return serialized;

    let low = 0;
    let high = Math.min(rawText.length, textLimit);
    let fitted = serialize(delegationId.value, "", null, workspace.value, true);
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = serialize(
        delegationId.value,
        admittedText(rawText, middle).value,
        null,
        workspace.value,
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
  }

  const minimumWorkspace = workspaceProjections.at(-1)?.value ?? null;
  let low = 0;
  let high = Math.min(result.delegationId.length, MAX_ADMITTED_ID_CHARS);
  let identityFitted = "0".slice(0, maxResultChars);
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = serialize(
      admittedText(result.delegationId, middle).value,
      "",
      null,
      minimumWorkspace,
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

function childFinalText(
  messages: readonly SessionMessage[],
  maxChars: number,
): string | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (
      message?.role === "assistant" &&
      message.toolCalls.length === 0 &&
      message.content.trim() !== ""
    ) {
      return admittedText(message.content.trim(), maxChars).value;
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
    workspace: result.workspace === null ? null : { ...result.workspace },
  };
}

function failedWriteWorkspaceLocation(
  reference: SubagentWriteWorkspaceLease["reference"],
  worktreePath: string | null,
):
  | { readonly worktreePath: null; readonly workspaceRoot: null }
  | { readonly worktreePath: string; readonly workspaceRoot: string } {
  return worktreePath === null
    ? { worktreePath: null, workspaceRoot: null }
    : { worktreePath, workspaceRoot: reference.workspaceRoot };
}

async function finalizeWriteWorkspace(input: {
  readonly lease: SubagentWriteWorkspaceLease;
  readonly settlement: SubagentWriteWorkspaceSettlement;
  readonly toolCallId: string;
  readonly toolName: "delegate" | "agent_resume";
  readonly store: AbortableToolOutputArtifactStore;
  readonly signal: AbortSignal;
}): Promise<{
  readonly result: SubagentWriteWorkspaceResult;
  readonly terminalFailure: string | null;
}> {
  const reference = input.lease.reference;
  const base = {
    kind: reference.kind,
    leaseId: reference.leaseId,
    baseCommit: reference.baseCommit,
    branch: reference.branch,
  };
  if (input.settlement.disposition === "preserved") {
    const storedPatch = await input.store.save({
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      content: input.settlement.patch.content,
      sourceStatus: input.settlement.patch.sourceTruncated
        ? "source-truncated"
        : "complete",
      purpose: "settlement",
      signal: input.signal,
    });
    if (storedPatch.status === "stored") {
      return {
        result: {
          ...base,
          disposition: "preserved",
          worktreePath: input.settlement.worktreePath,
          workspaceRoot: reference.workspaceRoot,
          patchRef: storedPatch.ref,
          patchSha256: storedPatch.contentSha256,
          patchSourceTruncated: input.settlement.patch.sourceTruncated,
          summary: input.settlement.patch.summary,
          error: null,
        },
        terminalFailure: null,
      };
    }
    const error = `Child patch artifact could not be stored: ${storedPatch.reason}`;
    return {
      result: {
        ...base,
        disposition: "preserved",
        worktreePath: input.settlement.worktreePath,
        workspaceRoot: reference.workspaceRoot,
        patchRef: null,
        patchSha256: null,
        patchSourceTruncated: input.settlement.patch.sourceTruncated,
        summary: input.settlement.patch.summary,
        error,
      },
      terminalFailure: error,
    };
  }
  let patchFields:
    | {
        readonly patchRef: null;
        readonly patchSha256: null;
        readonly patchSourceTruncated: boolean;
      }
    | {
        readonly patchRef: string;
        readonly patchSha256: string;
        readonly patchSourceTruncated: boolean;
      } = {
    patchRef: null,
    patchSha256: null,
    patchSourceTruncated: false,
  };
  let artifactFailure = "";
  if (input.settlement.patch !== null) {
    const storedPatch = await input.store.save({
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      content: input.settlement.patch.content,
      sourceStatus: input.settlement.patch.sourceTruncated
        ? "source-truncated"
        : "complete",
      purpose: "settlement",
      signal: input.signal,
    });
    patchFields =
      storedPatch.status === "stored"
        ? {
            patchRef: storedPatch.ref,
            patchSha256: storedPatch.contentSha256,
            patchSourceTruncated: input.settlement.patch.sourceTruncated,
          }
        : {
            patchRef: null,
            patchSha256: null,
            patchSourceTruncated: input.settlement.patch.sourceTruncated,
          };
    if (storedPatch.status === "failed") {
      artifactFailure = ` Patch artifact storage also failed: ${storedPatch.reason}`;
    }
  }
  const error = `${input.settlement.error}${artifactFailure}`;
  return {
    result: {
      ...base,
      disposition: "cleanup_failed",
      ...failedWriteWorkspaceLocation(reference, input.settlement.worktreePath),
      ...patchFields,
      summary:
        input.settlement.patch?.summary ?? "workspace requires inspection",
      error,
    },
    terminalFailure: error,
  };
}

function cancelUnusedWriteWorkspace(
  lease: SubagentWriteWorkspaceLease,
): SubagentWriteWorkspaceResult {
  const settlement = lease.settle();
  const reference = lease.reference;
  const base = {
    kind: reference.kind,
    leaseId: reference.leaseId,
    baseCommit: reference.baseCommit,
    branch: reference.branch,
  };
  const error =
    settlement.disposition === "cleanup_failed"
      ? settlement.error
      : "Unused child worktree changed before execution and was preserved without an artifact.";
  return {
    ...base,
    disposition: "cleanup_failed",
    ...failedWriteWorkspaceLocation(reference, settlement.worktreePath),
    patchRef: null,
    patchSha256: null,
    patchSourceTruncated: settlement.patch?.sourceTruncated ?? false,
    summary: settlement.patch?.summary ?? "workspace requires inspection",
    error,
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
  const admission =
    options.admission ??
    createSubagentTreeAdmission({
      ...(options.maxActiveAgentRuns !== undefined
        ? { maxActiveAgentRuns: options.maxActiveAgentRuns }
        : {}),
      ...(options.maxTotalChildRuns !== undefined
        ? { maxTotalChildRuns: options.maxTotalChildRuns }
        : {}),
    });
  const treeBudget = createSubagentTreeBudget({
    rootBudget: options.rootBudget,
  });
  const continuationMaxOutputTokens = Math.min(
    MAIN_CONTINUATION_MAX_OUTPUT_TOKENS,
    options.modelMaxOutputTokens ?? MAIN_CONTINUATION_MAX_OUTPUT_TOKENS,
  );
  const effectiveChildSystemPrompt = (
    systemPrompt: string,
    capability: SubagentCapabilitySnapshot,
  ): string =>
    appendWorkflowSkillCatalogToSystemPrompt(
      systemPrompt,
      capability.skills.map(skillDescriptorFromSubagentSnapshot),
    );
  const childToolExposure = (capability: SubagentCapabilitySnapshot) => ({
    kind: "auto" as const,
    profile: "subagent" as const,
    capability,
    ...(capability.mcpTools.length > 0
      ? {
          mcp: {
            snapshotId: subagentCapabilityFingerprint(capability),
            catalogAvailable: true,
            tools: [],
          },
        }
      : {}),
  });
  const resultContinuationBudget: SubagentResultContinuationBudget = {
    lease: (toolCallIds) => {
      const resultAdmission = treeBudget.planResults(
        toolCallIds.map((toolCallId) => ({
          toolCallId,
          content: { kind: "pending" },
        })),
      );
      const lease = treeBudget.leaseBatch({
        resultAdmission,
        children: [],
        continuationMaxOutputTokens,
      });
      return lease.kind === "rejected"
        ? lease
        : {
            kind: "granted",
            maxResultChars: resultAdmission.maxResultChars,
            continuation: lease.continuation,
            release: lease.release,
          };
    },
  };
  const settlementGraceMs =
    options.settlementGraceMs ?? DEFAULT_SETTLEMENT_GRACE_MS;
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
  const createLifecycle = (
    parentSignal: AbortSignal,
    deadlineMs: number,
  ): ChildLifecycle => {
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
      cancel: beginCancellation,
      cleanup: () => {
        clearTimeout(executionDeadline);
        if (settlementDeadline !== null) clearTimeout(settlementDeadline);
        parentSignal.removeEventListener("abort", parentAbort);
      },
    };
  };

  type ExecuteAcceptedInputBase = {
    readonly mode: "foreground" | "background";
    readonly delegationId: string;
    readonly childAgentId: AgentId;
    readonly childRunId: SubagentRunId;
    readonly toolCallId: string;
    readonly toolName: "delegate" | "agent_resume";
    readonly task: string;
    readonly focusPaths: readonly string[];
    readonly systemPrompt: string;
    readonly userMessage: string;
    readonly priorMessages?: readonly SessionMessage[];
    readonly execution: SubagentExecutionRuntime;
    readonly inputQueue: SubagentInputQueue;
    readonly childMaxCostUsd: number;
    readonly lifecycle: ChildLifecycle;
    readonly record: SubagentRunRecord;
    readonly persistence?: SubagentRunPersistence;
  };

  type ExecuteAcceptedInput =
    | (ExecuteAcceptedInputBase & {
        readonly workspace: {
          readonly kind: "read_only";
          readonly capability: ReadOnlySubagentCapabilitySnapshot;
        };
      })
    | (ExecuteAcceptedInputBase & {
        readonly workspace: {
          readonly kind: "isolated_write";
          readonly capability: WriterSubagentCapabilitySnapshot;
          readonly lease: SubagentWriteWorkspaceLease;
        };
      });

  const executeAccepted = async (
    input: ExecuteAcceptedInput,
  ): Promise<SubagentCanonicalResult> => {
    const capability = input.workspace.capability;
    const progress = (
      status: Exclude<SubagentProgressEvent["status"], "tool" | "turn">,
    ): void => {
      publishProgress({
        status,
        delegationId: input.delegationId,
        task: input.task,
        elapsedMs: elapsedSince(input.lifecycle.startedAt),
        deadlineMs: capability.deadlineMs,
      });
    };
    const toolProgress = (tool: string): void => {
      publishProgress({
        status: "tool",
        delegationId: input.delegationId,
        task: input.task,
        tool,
        elapsedMs: elapsedSince(input.lifecycle.startedAt),
        deadlineMs: capability.deadlineMs,
      });
    };
    const turnProgress = (turn: number): void => {
      publishProgress({
        status: "turn",
        delegationId: input.delegationId,
        task: input.task,
        turn,
        elapsedMs: elapsedSince(input.lifecycle.startedAt),
        deadlineMs: capability.deadlineMs,
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
        provider: input.execution.provider,
        model: input.execution.costModel,
        maxCostUsd: input.childMaxCostUsd,
        sharedAccount: options.sharedCostBudget,
        ...(input.execution.modelMaxOutputTokens !== undefined
          ? {
              modelMaxOutputTokens: input.execution.modelMaxOutputTokens,
            }
          : {}),
      });
      const childInstrumentation =
        input.mode === "background"
          ? options.backgroundModelOperations
          : options.modelOperations;
      const childModelOperations:
        | SubagentModelOperationInstrumentation
        | undefined =
        childInstrumentation === undefined
          ? undefined
          : {
              ...childInstrumentation,
              provider: input.execution.snapshot.providerId,
              model: input.execution.snapshot.model,
              costModel: input.execution.costModel,
              attribution: {
                type: "subagent",
                delegationId: input.delegationId,
                childRunId: input.childRunId,
                profile: capability.profile,
                effort: input.execution.snapshot.effort,
              },
            };
      const childInput =
        input.priorMessages === undefined
          ? {
              userMessageOrigin: {
                type: "runtime_subagent_delegation" as const,
              },
            }
          : {
              userMessageOrigin: { type: "runtime_subagent_input" as const },
              priorMessages: input.priorMessages,
            };
      const skillActivation =
        options.profileRegistry.skillRuntime.kind === "enabled"
          ? options.profileRegistry.skillRuntime.createActivation(capability)
          : undefined;
      const childMcpRuntime =
        options.profileRegistry.mcpRuntime.kind === "enabled"
          ? options.profileRegistry.mcpRuntime.createRuntime(
              capability,
              input.execution.snapshot,
            )
          : undefined;
      const childWorkspace =
        input.workspace.kind === "isolated_write"
          ? input.workspace.lease.reference.workspaceRoot
          : options.workspace;
      let childWorkspaceAuthority: SubagentWorkspaceRunOptions;
      if (input.workspace.kind === "isolated_write") {
        childWorkspaceAuthority = {
          workspaceAccess: "isolated_write",
          workspaceLease: input.workspace.lease,
          subagentCapability: input.workspace.capability,
        };
      } else {
        childWorkspaceAuthority = {
          workspaceAccess: "read_only",
          subagentCapability: input.workspace.capability,
        };
      }
      const hiddenWorkspacePaths =
        input.workspace.kind === "isolated_write"
          ? childHiddenWorkspacePaths(
              options.workspace,
              childWorkspace,
              options.hiddenWorkspacePaths ?? [],
            )
          : options.hiddenWorkspacePaths;
      try {
        for await (const event of runAgent({
          workspace: childWorkspace,
          provider: input.execution.provider,
          userMessage: input.userMessage,
          ...childInput,
          systemPrompt: effectiveChildSystemPrompt(
            input.systemPrompt,
            capability,
          ),
          signal: input.lifecycle.abortController.signal,
          bash: { kind: "disabled" },
          toolProfile: "subagent",
          ...childWorkspaceAuthority,
          ...(skillActivation !== undefined ? { skillActivation } : {}),
          ...(childMcpRuntime !== undefined
            ? {
                mcp: {
                  runtime: childMcpRuntime,
                  schemaTarget: mcpProviderSchemaTarget(
                    input.execution.snapshot.providerId,
                    input.execution.snapshot.model,
                  ),
                },
              }
            : {}),
          stopPolicy: maxTurnFallbackPolicy(capability.maxTurns),
          costTracking: {
            model: input.execution.costModel,
            maxCostUsd: input.childMaxCostUsd,
            ...(input.execution.modelMaxOutputTokens !== undefined
              ? {
                  modelMaxOutputTokens: input.execution.modelMaxOutputTokens,
                }
              : {}),
          },
          costBudgetProvider: childBudget.provider,
          injectedUserMessages: input.inputQueue,
          ...(hiddenWorkspacePaths !== undefined
            ? { hiddenWorkspacePaths }
            : {}),
          ...(input.execution.contextCompaction !== undefined
            ? { contextCompaction: input.execution.contextCompaction }
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
              childFinalText(transcriptMessages, capability.maxFinalTextChars),
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
      } finally {
        try {
          if (childMcpRuntime !== undefined) {
            const closeSignal = AbortSignal.any([
              input.lifecycle.settlementAbortController.signal,
              AbortSignal.timeout(settlementGraceMs),
            ]);
            await awaitWithAbort(
              childMcpRuntime.close(closeSignal),
              closeSignal,
            );
          }
        } catch (caught) {
          terminal = {
            status: "failed",
            finalText: null,
            error: `Child MCP runtime could not close: ${errorMessage(caught)}`,
          };
        }
      }

      const unprocessedInput = input.inputQueue.close();
      if (unprocessedInput.length > 0) {
        runningPersistence?.pendingInput(unprocessedInput);
        transcriptMessages = [...transcriptMessages, ...unprocessedInput];
      }
      const pendingInputCount = unprocessedInput.length;

      usage = childBudget.observedUsage();
      costUsd = childBudget.observedSpendUsd();
      let transcriptRef = input.persistence?.transcriptRef ?? null;
      if (input.persistence === undefined) {
        let saved: ToolOutputArtifactSaveResult;
        try {
          saved = await options.transcriptStore.save({
            toolCallId: input.toolCallId,
            toolName: input.toolName,
            content: transcriptContent({
              delegationId: input.delegationId,
              childRunId: input.childRunId,
              provider: input.execution.snapshot.providerId,
              model: input.execution.snapshot.model,
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
      let workspace: SubagentWriteWorkspaceResult | null = null;
      if (input.workspace.kind === "isolated_write") {
        const finalizedWorkspace = await finalizeWriteWorkspace({
          lease: input.workspace.lease,
          settlement: input.workspace.lease.settle(),
          toolCallId: input.toolCallId,
          toolName: input.toolName,
          store: options.transcriptStore,
          signal: input.lifecycle.settlementAbortController.signal,
        });
        workspace = finalizedWorkspace.result;
        if (finalizedWorkspace.terminalFailure !== null) {
          terminal = {
            status: "failed",
            finalText: null,
            error: finalizedWorkspace.terminalFailure,
          };
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
        pendingInputCount,
        workspace,
      };
      const result: SubagentCanonicalResult = { ...resultBase, ...terminal };
      if (runningPersistence !== undefined) {
        runningPersistence.terminal({
          ...terminal,
          usage,
          turns,
          costUsd,
          pendingInputCount,
          workspace,
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
    workspace: PreparedAcceptedWorkspace,
    systemPrompt: string,
  ): AcceptedDelegation => {
    const candidate = childBudget.value;
    const {
      input,
      delegationId,
      capability,
      execution,
      toolName,
      userMessage,
    } = candidate;
    const record: SubagentRunRecord = {
      delegationId,
      childAgentId,
      childRunId,
      task: input.task,
      state: { kind: "queued" },
    };
    const inputQueue = createSubagentInputQueue();
    const lifecycle = createLifecycle(
      input.mode === "background" && options.background !== undefined
        ? options.background.signal
        : input.signal,
      capability.deadlineMs,
    );
    const releaseResources = (): void => {
      lifecycle.cleanup();
      admissionLease.release();
    };
    const cancelledBeforeStart = (): SubagentCanonicalResult & {
      readonly error: string;
    } => {
      const workspaceResult =
        workspace.kind === "isolated_write"
          ? cancelUnusedWriteWorkspace(workspace.lease)
          : null;
      return {
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
        pendingInputCount: 0,
        workspace: workspaceResult,
        error:
          workspaceResult?.error ??
          "Child was cancelled before execution started.",
      };
    };
    const publishCancelledBeforeStart = (
      result: SubagentCanonicalResult & { readonly error: string },
    ): void => {
      if (persistence === undefined) {
        commitTerminalResult(record, result);
      } else {
        persistence.terminal({
          status: "cancelled",
          finalText: null,
          error: result.error,
          usage: result.usage,
          turns: result.turns,
          costUsd: result.costUsd,
          pendingInputCount: result.pendingInputCount,
          workspace: result.workspace,
        });
        commitTerminalResult(record, result);
      }
      publishProgress({
        status: "cancelled",
        delegationId,
        task: input.task,
        elapsedMs: elapsedSince(lifecycle.startedAt),
        deadlineMs: capability.deadlineMs,
      });
      releaseResources();
    };
    let promise: Promise<SubagentCanonicalResult> | undefined;
    const run = (): Promise<SubagentCanonicalResult> => {
      promise ??= Promise.resolve()
        .then(() => {
          const acceptedInput = {
            mode: input.mode,
            delegationId,
            childAgentId,
            childRunId,
            toolCallId: input.toolCallId,
            toolName,
            task: input.task,
            focusPaths: input.focusPaths,
            execution,
            systemPrompt,
            userMessage,
            ...(candidate.priorMessages !== undefined
              ? { priorMessages: candidate.priorMessages }
              : {}),
            inputQueue,
            childMaxCostUsd: childBudget.maxCostUsd,
            lifecycle,
            record,
            ...(persistence !== undefined ? { persistence } : {}),
          };
          if (workspace.kind === "isolated_write") {
            return executeAccepted({ ...acceptedInput, workspace });
          }
          return executeAccepted({ ...acceptedInput, workspace });
        })
        .finally(releaseResources);
      return promise;
    };
    const cancelBeforeStart = (): void => {
      if (promise !== undefined) return;
      const result = cancelledBeforeStart();
      promise = Promise.resolve(result);
      publishCancelledBeforeStart(result);
    };
    const cancel = (): void => {
      lifecycle.cancel(new Error("background subagent cancelled"));
    };
    return {
      kind: "accepted",
      mode: input.mode,
      record,
      run,
      cancelBeforeStart,
      cancel,
      input: inputQueue.enqueue,
    };
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
      rejection: DelegationRejection,
    ): void => {
      let durableRejection = rejection;
      try {
        options.lifecyclePersistence?.rejected({
          delegationId,
          parentRunId: options.parentRunId,
          parentToolCallId: input.toolCallId,
          task: input.task,
          reason: rejection.reason,
        });
      } catch (caught) {
        if (caught instanceof SubagentPersistenceError) throw caught;
        durableRejection = {
          ...rejection,
          reason: `${rejection.reason} Lifecycle receipt could not be stored: ${errorMessage(caught)}`,
        };
      }
      receipts.set(delegationId, {
        kind: "rejected",
        rejection: durableRejection,
      });
    };
    for (const input of inputs) {
      const delegationId = `${options.parentRunId}:${input.toolCallId}`;
      if (receipts.has(delegationId) || seenCandidateIds.has(delegationId)) {
        continue;
      }
      seenCandidateIds.add(delegationId);
      if (options.providerBlocked?.() === true) {
        recordRejection(input, delegationId, {
          reason:
            "Delegation rejected: the root provider auth/quota circuit is open.",
          recovery:
            "Continue in Main without delegating; retry only after provider access is restored.",
        });
        continue;
      }
      if (input.mode === "background" && options.background === undefined) {
        recordRejection(input, delegationId, {
          reason:
            "Delegation rejected: background mode requires a saved interactive session owner.",
          recovery:
            "Use foreground delegation, or start a saved interactive session before requesting background mode.",
        });
        continue;
      }
      if (
        input.mode === "background" &&
        options.background?.signal.aborted === true
      ) {
        recordRejection(input, delegationId, {
          reason:
            "Delegation rejected: the saved interactive session owner is shutting down.",
          recovery:
            "Start or resume a saved interactive session before requesting background mode again.",
        });
        continue;
      }
      const invalidFocusPath = validateWorkspacePaths(
        options.workspace,
        input.focusPaths,
      );
      if (invalidFocusPath !== null) {
        recordRejection(input, delegationId, {
          reason: `Delegation rejected: invalid focus path. ${invalidFocusPath}`,
          recovery:
            "Correct or omit the invalid workspace-relative focus path before delegating again.",
        });
        continue;
      }
      const profile = options.profileRegistry.resolve(input.profile);
      if (profile === undefined) {
        recordRejection(input, delegationId, {
          reason: `Delegation rejected: unknown subagent profile ${JSON.stringify(input.profile)}.`,
          recovery:
            "Select an exact profile name from the delegate tool schema before delegating again.",
        });
        continue;
      }
      const profileSelection = subagentCapabilityIsWriter(profile.capability)
        ? {
            workspaceAccess: "isolated_write" as const,
            threadCapabilityCeiling: profile.capability,
            selection: selectRequestedCapability(
              profile.capability,
              input.skills ?? [],
              input.mcp,
            ),
          }
        : {
            workspaceAccess: "read_only" as const,
            threadCapabilityCeiling: profile.capability,
            selection: selectRequestedCapability(
              profile.capability,
              input.skills ?? [],
              input.mcp,
            ),
          };
      if (profileSelection.selection.kind === "skills_rejected") {
        recordRejection(input, delegationId, {
          reason: `Delegation rejected: profile ${JSON.stringify(input.profile)} does not allow every requested workflow Skill.`,
          recovery:
            "Select only Skill names advertised for that exact profile, or omit the Skill lease.",
        });
        continue;
      }
      if (profileSelection.selection.kind === "mcp_rejected") {
        recordRejection(input, delegationId, {
          reason: `Delegation rejected: profile ${JSON.stringify(input.profile)} does not allow every requested MCP tool.`,
          recovery:
            "Select only MCP tools advertised for that exact profile, or omit the MCP lease.",
        });
        continue;
      }
      const capability = profileSelection.selection.capability;
      if (profileSelection.workspaceAccess === "isolated_write") {
        if (input.mode !== "foreground") {
          recordRejection(input, delegationId, {
            reason:
              "Delegation rejected: writer is foreground-only in this slice.",
            recovery:
              "Retry as one foreground writer, or use a read-only profile for attached background work.",
          });
          continue;
        }
        if (inputs.length !== 1) {
          recordRejection(input, delegationId, {
            reason:
              "Delegation rejected: a writer must be the only child in its tool round.",
            recovery:
              "Delegate exactly one foreground writer, then inspect its patch before starting other child work.",
          });
          continue;
        }
      }
      const execution = options.resolveExecution(profile.execution);
      if (execution.provider.abortSignalSupport !== true) {
        recordRejection(input, delegationId, {
          reason:
            "Delegation rejected: the selected child provider does not certify AbortSignal settlement.",
          recovery:
            "Continue in Main, or select a child model whose provider certifies cancellation settlement.",
        });
        continue;
      }
      const systemPrompt = buildSubagentSystemPrompt({
        workspace:
          profileSelection.workspaceAccess === "isolated_write"
            ? "<isolated child worktree assigned at admission>"
            : options.workspace,
        platform: options.platform,
        ...(options.projectInstructions !== undefined
          ? { projectInstructions: options.projectInstructions }
          : {}),
        focusPaths: input.focusPaths,
        profile: capability.profile,
        roleInstructions: profile.roleInstructions,
        maxFinalTextChars: capability.maxFinalTextChars,
        workspaceAccess: profileSelection.workspaceAccess,
      });
      const userMessage = childTaskMessage(
        delegationId,
        input.task,
        input.focusPaths,
      );
      const childInputOptions: StreamOptions = {
        systemPrompt: effectiveChildSystemPrompt(systemPrompt, capability),
        messages: [{ role: "user", content: userMessage }],
        signal: input.signal,
        toolExposure: childToolExposure(capability),
      };
      const minimumInputTokens = estimateProviderInputTokens(
        execution.provider,
        {
          ...childInputOptions,
          maxOutputTokens: MIN_USEFUL_OUTPUT_TOKENS,
        },
      );
      if (minimumInputTokens === null) {
        recordRejection(input, delegationId, {
          reason:
            "Delegation rejected: the child request cost cannot be estimated.",
          recovery:
            "Continue in Main, or select a provider and model with known token estimation before delegating again.",
        });
        continue;
      }
      const candidateBase = {
        input,
        toolName: "delegate" as const,
        delegationId,
        execution,
        roleInstructions: profile.roleInstructions,
        systemPrompt,
        userMessage,
        minimumCostUsd: calculateConservativeRequestCostUsd(
          minimumInputTokens,
          MIN_USEFUL_OUTPUT_TOKENS,
          execution.costModel,
        ),
      };
      if (profileSelection.workspaceAccess === "isolated_write") {
        candidates.push({
          ...candidateBase,
          workspaceAccess: profileSelection.workspaceAccess,
          capability: profileSelection.selection.capability,
          threadCapabilityCeiling: profileSelection.threadCapabilityCeiling,
        });
      } else {
        candidates.push({
          ...candidateBase,
          workspaceAccess: profileSelection.workspaceAccess,
          capability: profileSelection.selection.capability,
          threadCapabilityCeiling: profileSelection.threadCapabilityCeiling,
        });
      }
    }

    const admissionPlan = admission.plan(candidates);
    const capacityCandidates = admissionPlan.admitted;
    for (const { value: candidate, reason } of admissionPlan.rejected) {
      recordRejection(
        candidate.input,
        candidate.delegationId,
        admissionRejection(reason),
      );
    }

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
            content: {
              kind: "projected",
              value: (maxResultChars: number) =>
                projectDelegationRejection({
                  ...receipt.rejection,
                  maxResultChars,
                }),
            },
          };
        }
        if (receipt?.record.state.kind === "terminal") {
          const result = receipt.record.state.result;
          return {
            toolCallId: input.toolCallId,
            content: {
              kind: "projected",
              value: (maxResultChars: number) =>
                projectSubagentResult(result, maxResultChars),
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
          minimumCostUsd: candidate.minimumCostUsd,
        }));
      budgetLease = treeBudget.leaseBatch({
        resultAdmission,
        children,
        continuationMaxOutputTokens,
      });
      if (budgetLease.kind === "granted") break;
      const rejectedCandidate = acceptedCandidates.at(-1);
      if (rejectedCandidate === undefined) break;
      recordRejection(rejectedCandidate.input, rejectedCandidate.delegationId, {
        reason:
          "Delegation rejected: the root budget cannot fund this child while preserving one admitted aggregate main continuation.",
        recovery:
          "Do not retry with the same session budget. Continue the investigation in Main, or ask the user to start a new run with a higher --max-cost.",
      });
      acceptedCandidates = acceptedCandidates.slice(0, -1);
    }

    if (budgetLease.kind === "granted") {
      const preparedAccepted: PreparedAcceptedCandidate[] = [];
      for (const childBudget of budgetLease.children) {
        const candidate = childBudget.value;
        const childAgentId: AgentId = `agent-${randomUUID()}`;
        const childRunId: SubagentRunId = `subagent-${randomUUID()}`;
        let workspaceAuthority:
          | {
              readonly kind: "read_only";
              readonly capability: ReadOnlySubagentCapabilitySnapshot;
              readonly threadCapabilityCeiling: ReadOnlySubagentCapabilitySnapshot;
            }
          | {
              readonly kind: "isolated_write";
              readonly capability: WriterSubagentCapabilitySnapshot;
              readonly threadCapabilityCeiling: WriterSubagentCapabilitySnapshot;
              readonly prepared: PreparedWriteWorkspace;
            };
        if (candidate.workspaceAccess === "isolated_write") {
          const preparation = options.writeWorkspace?.prepare({
            childRunId,
            signal: candidate.input.signal,
          });
          if (preparation === undefined || preparation.kind === "rejected") {
            recordRejection(candidate.input, candidate.delegationId, {
              reason:
                preparation?.reason ??
                "Writer delegation rejected because workspace isolation is unavailable.",
              recovery:
                preparation?.recovery ??
                "Continue in Main without delegating the write.",
            });
            continue;
          }
          workspaceAuthority = {
            kind: "isolated_write",
            capability: candidate.capability,
            threadCapabilityCeiling: candidate.threadCapabilityCeiling,
            prepared: preparation.workspace,
          };
        } else {
          workspaceAuthority = {
            kind: "read_only",
            capability: candidate.capability,
            threadCapabilityCeiling: candidate.threadCapabilityCeiling,
          };
        }
        const acceptedSystemPrompt =
          workspaceAuthority.kind === "isolated_write"
            ? buildSubagentSystemPrompt({
                workspace: workspaceAuthority.prepared.reference.workspaceRoot,
                platform: options.platform,
                ...(options.projectInstructions !== undefined
                  ? { projectInstructions: options.projectInstructions }
                  : {}),
                focusPaths: candidate.input.focusPaths,
                profile: candidate.capability.profile,
                roleInstructions: candidate.roleInstructions,
                maxFinalTextChars: candidate.capability.maxFinalTextChars,
                workspaceAccess: "isolated_write",
              })
            : candidate.systemPrompt;
        try {
          const acceptedLifecycleBase = {
            delegationId: candidate.delegationId,
            childAgentId,
            childRunId,
            parentRunId: options.parentRunId,
            parentToolCallId: candidate.input.toolCallId,
            task: candidate.input.task,
            focusPaths: candidate.input.focusPaths,
            providerId: candidate.execution.snapshot.providerId,
            model: candidate.execution.snapshot.model,
            effort: candidate.execution.snapshot.effort,
            systemPrompt: acceptedSystemPrompt,
            lineage: { kind: "root" },
          } as const;
          let acceptedLifecycle: SubagentAcceptedLifecycle;
          if (workspaceAuthority.kind === "isolated_write") {
            acceptedLifecycle = {
              ...acceptedLifecycleBase,
              mode: "foreground",
              threadCapabilityCeiling:
                workspaceAuthority.threadCapabilityCeiling,
              capability: workspaceAuthority.capability,
              workspace: workspaceAuthority.prepared.reference,
            };
          } else {
            acceptedLifecycle = {
              ...acceptedLifecycleBase,
              mode: candidate.input.mode,
              threadCapabilityCeiling:
                workspaceAuthority.threadCapabilityCeiling,
              capability: workspaceAuthority.capability,
              workspace: null,
            };
          }
          const persistence =
            options.lifecyclePersistence?.accepted(acceptedLifecycle);
          if (workspaceAuthority.kind === "isolated_write") {
            const activation = workspaceAuthority.prepared.activate();
            if (activation.kind === "failed") {
              if (persistence === undefined) {
                recordRejection(candidate.input, candidate.delegationId, {
                  reason: `Writer delegation rejected during isolated workspace activation: ${activation.error}`,
                  recovery: activation.recovery,
                });
                continue;
              }
              const reference = workspaceAuthority.prepared.reference;
              const workspaceResult: SubagentWriteWorkspaceResult = {
                kind: reference.kind,
                leaseId: reference.leaseId,
                baseCommit: reference.baseCommit,
                branch: reference.branch,
                disposition: "cleanup_failed",
                ...failedWriteWorkspaceLocation(
                  reference,
                  activation.worktreePath,
                ),
                patchRef: null,
                patchSha256: null,
                patchSourceTruncated: false,
                summary: "writer workspace activation failed",
                error: activation.error,
              };
              const result: SubagentCanonicalResult = {
                delegationId: candidate.delegationId,
                childAgentId,
                childRunId,
                status: "failed",
                task: candidate.input.task,
                finalText: null,
                usage: zeroUsage(),
                turns: 0,
                costUsd: 0,
                transcriptRef: persistence.transcriptRef,
                pendingInputCount: 0,
                workspace: workspaceResult,
                error: `Writer workspace activation failed: ${activation.error}`,
              };
              persistence.running().terminal({
                status: result.status,
                finalText: result.finalText,
                error: result.error,
                usage: result.usage,
                turns: result.turns,
                costUsd: result.costUsd,
                pendingInputCount: result.pendingInputCount,
                workspace: result.workspace,
              });
              preparedAccepted.push({
                kind: "terminal",
                childBudget,
                childAgentId,
                childRunId,
                systemPrompt: acceptedSystemPrompt,
                result,
              });
              continue;
            }
            preparedAccepted.push({
              kind: "runnable",
              childBudget,
              childAgentId,
              childRunId,
              systemPrompt: acceptedSystemPrompt,
              workspace: {
                kind: "isolated_write",
                capability: workspaceAuthority.capability,
                lease: activation.lease,
              },
              ...(persistence !== undefined ? { persistence } : {}),
            });
            continue;
          }
          preparedAccepted.push({
            kind: "runnable",
            childBudget,
            childAgentId,
            childRunId,
            systemPrompt: acceptedSystemPrompt,
            workspace: {
              kind: "read_only",
              capability: workspaceAuthority.capability,
            },
            ...(persistence !== undefined ? { persistence } : {}),
          });
        } catch (caught) {
          if (caught instanceof SubagentPersistenceError) {
            throw caught;
          }
          receipts.set(candidate.delegationId, {
            kind: "rejected",
            rejection: {
              reason: `Delegation rejected: lifecycle could not be stored before child admission. ${errorMessage(caught)}`,
              recovery:
                "Continue in Main without delegating; retry only after saved-session persistence is healthy.",
            },
          });
        }
      }
      const admissionLeases = admission.commit(preparedAccepted);
      for (const admissionLease of admissionLeases) {
        const accepted = admissionLease.value;
        const childBudget = accepted.childBudget;
        const candidate = childBudget.value;
        const terminalInputQueue = createSubagentInputQueue();
        if (accepted.kind === "terminal") terminalInputQueue.close();
        const receipt: AcceptedDelegation =
          accepted.kind === "terminal"
            ? {
                kind: "accepted",
                mode: candidate.input.mode,
                record: {
                  delegationId: candidate.delegationId,
                  childAgentId: accepted.childAgentId,
                  childRunId: accepted.childRunId,
                  task: candidate.input.task,
                  state: {
                    kind: "terminal",
                    result: cloneCanonicalResult(accepted.result),
                  },
                },
                run: async () => cloneCanonicalResult(accepted.result),
                cancelBeforeStart: () => {},
                cancel: () => {},
                input: terminalInputQueue.enqueue,
              }
            : createAcceptedReceipt(
                childBudget,
                admissionLease,
                accepted.childAgentId,
                accepted.childRunId,
                accepted.persistence,
                accepted.workspace,
                accepted.systemPrompt,
              );
        if (accepted.kind === "terminal") admissionLease.release();
        receipts.set(candidate.delegationId, receipt);
        freshAcceptedIds.add(candidate.delegationId);
        ownedAccepted.push(receipt);
        publishProgress({
          status:
            accepted.kind === "terminal" ? accepted.result.status : "queued",
          delegationId: candidate.delegationId,
          task: candidate.input.task,
          elapsedMs: 0,
          deadlineMs: candidate.capability.deadlineMs,
        });
      }
    }

    return {
      executor: createDelegationExecutor(async (input) => {
        const delegationId = `${options.parentRunId}:${input.toolCallId}`;
        const receipt = receipts.get(delegationId);
        if (!preparedIds.has(delegationId) || receipt === undefined) {
          return rejectedDelegation(
            {
              reason:
                "Delegation rejected: the call was not part of the prepared tool batch.",
              recovery:
                "Delegate in a new isolated tool round, or continue the investigation in Main.",
            },
            resultAdmission.maxResultChars,
          );
        }
        if (receipt.kind === "rejected") {
          return rejectedDelegation(
            receipt.rejection,
            resultAdmission.maxResultChars,
          );
        }
        if (receipt.mode === "background") {
          const result = receipt.run();
          if (freshAcceptedIds.delete(delegationId)) {
            options.background?.register({
              delegationId: receipt.record.delegationId,
              childAgentId: receipt.record.childAgentId,
              childRunId: receipt.record.childRunId,
              task: receipt.record.task,
              result,
              cancel: receipt.cancel,
              input: receipt.input,
            });
            return {
              delivery: "background",
              ok: true,
              content: admittedText(
                JSON.stringify({
                  delegationId: receipt.record.delegationId,
                  agentId: receipt.record.childAgentId,
                  runId: receipt.record.childRunId,
                  status: receipt.record.state.kind,
                }),
                resultAdmission.maxResultChars,
              ).value,
            };
          }
          return {
            delivery: "replayed",
            ok: true,
            content: admittedText(
              JSON.stringify({
                delegationId: receipt.record.delegationId,
                agentId: receipt.record.childAgentId,
                runId: receipt.record.childRunId,
                status:
                  receipt.record.state.kind === "terminal"
                    ? receipt.record.state.result.status
                    : receipt.record.state.kind,
              }),
              resultAdmission.maxResultChars,
            ).value,
          };
        }
        const result = await receipt.run();
        const content = projectSubagentResult(
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
      ...(budgetLease.kind === "granted"
        ? { continuation: budgetLease.continuation }
        : {}),
      close: () => {
        for (const receipt of ownedAccepted) receipt.cancelBeforeStart();
        if (budgetLease.kind === "granted") budgetLease.release();
      },
    };
  };

  const capability: DelegationCapability = {
    mode: options.background === undefined ? "foreground" : "background",
    profileCatalog: options.profileRegistry.catalog,
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

  const continuation: SubagentContinuationCapability = {
    resume: async (request) => {
      const delegationId = `${options.parentRunId}:${request.toolCallId}`;
      const existing = receipts.get(delegationId);
      if (existing?.kind === "accepted") {
        if (existing.mode === "foreground") {
          const result = await existing.run();
          return {
            ok: result.status === "completed",
            content: projectSubagentResult(result),
          };
        }
        return {
          ok: true,
          content: JSON.stringify({
            agentId: existing.record.childAgentId,
            runId: existing.record.childRunId,
            status:
              existing.record.state.kind === "terminal"
                ? existing.record.state.result.status
                : existing.record.state.kind,
          }),
        };
      }
      if (existing?.kind === "rejected") {
        return { ok: false, content: existing.rejection.reason };
      }
      const reject = (reason: string): SubagentContinuationResult => {
        receipts.set(delegationId, {
          kind: "rejected",
          rejection: {
            reason,
            recovery:
              "Keep the prior result, then retry only after the reported admission condition changes.",
          },
        });
        return { ok: false, content: reason };
      };
      if (options.background === undefined) {
        return reject(
          "Agent resume requires an attached saved-session background owner.",
        );
      }
      if (options.background.signal.aborted) {
        return reject(
          "Agent resume rejected because the saved-session owner is shutting down.",
        );
      }
      if (options.providerBlocked?.() === true) {
        return reject(
          "Agent resume rejected because provider access is blocked.",
        );
      }
      const invalidFocusPath = validateWorkspacePaths(
        options.workspace,
        request.focusPaths,
      );
      if (invalidFocusPath !== null) {
        return reject(`Agent resume rejected: ${invalidFocusPath}`);
      }
      const baseProfile = subagentCapabilityBaseProfile(request.capability);
      const currentPolicy = options.profileRegistry.resolveBuiltin(baseProfile);
      const currentSkills =
        options.profileRegistry.skillRuntime.kind === "enabled"
          ? options.profileRegistry.skillRuntime.resolveCurrent(
              request.threadCapabilityCeiling.skills,
            )
          : [];
      const currentMcpTools =
        options.profileRegistry.mcpRuntime.kind === "enabled"
          ? await options.profileRegistry.mcpRuntime.resolveCurrent(
              request.threadCapabilityCeiling.mcpTools,
            )
          : [];
      const currentCapabilityCeiling = subagentCapabilityWithMcpTools(
        subagentCapabilityWithSkills(currentPolicy.capability, currentSkills),
        currentMcpTools,
      );
      const selectCapability = <Capability extends SubagentCapabilitySnapshot>(
        previous: Capability,
      ) => {
        const currentlyAllowed = narrowSubagentCapabilityToCeiling(
          previous,
          currentCapabilityCeiling,
        );
        const withSkills = selectSubagentCapabilitySkills(
          currentlyAllowed,
          request.skills,
        );
        if (withSkills === null) return { kind: "skills_rejected" } as const;
        const capability = selectSubagentCapabilityMcpTools(
          withSkills,
          request.mcp,
        );
        return capability === null
          ? ({ kind: "mcp_rejected" } as const)
          : ({ kind: "selected", capability } as const);
      };
      const selection =
        request.workspaceAccess === "isolated_write"
          ? (() => {
              const selected = selectCapability(request.capability);
              return selected.kind === "selected"
                ? {
                    kind: "isolated_write" as const,
                    capability: selected.capability,
                    previousWorkspace: request.workspace,
                    threadCapabilityCeiling: request.threadCapabilityCeiling,
                  }
                : selected;
            })()
          : (() => {
              const selected = selectCapability(request.capability);
              return selected.kind === "selected"
                ? {
                    kind: "read_only" as const,
                    capability: selected.capability,
                    threadCapabilityCeiling: request.threadCapabilityCeiling,
                  }
                : selected;
            })();
      if (selection.kind === "skills_rejected") {
        return reject(
          "Agent resume rejected because its task Skill lease is outside the previous Run, Thread ceiling, or current policy.",
        );
      }
      if (selection.kind === "mcp_rejected") {
        return reject(
          "Agent resume rejected because its task MCP lease is outside the previous Run, Thread ceiling, or current policy.",
        );
      }
      const capability = selection.capability;
      const capabilityRelations = [
        compareSubagentCapability(capability, request.capability),
        compareSubagentCapability(
          capability,
          selection.threadCapabilityCeiling,
        ),
        compareSubagentCapability(capability, currentCapabilityCeiling),
      ];
      const expansion = capabilityRelations.find(
        (relation) => relation.kind === "expansion",
      );
      if (expansion?.kind === "expansion") {
        return reject(
          `Agent resume rejected because its effective ${expansion.dimension} would expand authority.`,
        );
      }
      const execution = options.resolveExecution(request.execution);
      if (execution.provider.abortSignalSupport !== true) {
        return reject(
          "Agent resume rejected because the selected child provider does not certify cancellation settlement.",
        );
      }
      const minimumInputTokens = estimateProviderInputTokens(
        execution.provider,
        {
          systemPrompt: effectiveChildSystemPrompt(
            request.systemPrompt,
            capability,
          ),
          messages: [
            ...request.priorMessages.map(projectSessionMessageToProvider),
            { role: "user", content: request.message },
          ],
          signal: request.signal,
          toolExposure: childToolExposure(capability),
          maxOutputTokens: MIN_USEFUL_OUTPUT_TOKENS,
        },
      );
      if (minimumInputTokens === null) {
        return reject(
          "Agent resume rejected because the child request cost cannot be estimated.",
        );
      }
      const minimumCostUsd = calculateConservativeRequestCostUsd(
        minimumInputTokens,
        MIN_USEFUL_OUTPUT_TOKENS,
        execution.costModel,
      );
      const remainingCostUsd = options.rootBudget.remainingUsd();
      if (remainingCostUsd < minimumCostUsd) {
        return reject(
          "Agent resume rejected because the remaining root budget cannot admit the child request.",
        );
      }
      const candidateBase = {
        input: {
          toolCallId: request.toolCallId,
          profile: capability.profile,
          mode:
            selection.kind === "isolated_write"
              ? ("foreground" as const)
              : ("background" as const),
          task: request.message,
          focusPaths: request.focusPaths,
          skills: capability.skills.map((skill) => skill.qualifiedName),
          mcp: request.mcp,
          signal: request.signal,
        },
        toolName: "agent_resume" as const,
        delegationId,
        execution,
        roleInstructions: currentPolicy.roleInstructions,
        systemPrompt: request.systemPrompt,
        userMessage: request.message,
        minimumCostUsd,
        priorMessages: request.priorMessages,
      };
      const candidate: PreparedDelegationCandidate =
        selection.kind === "isolated_write"
          ? {
              ...candidateBase,
              input: { ...candidateBase.input, mode: "foreground" },
              workspaceAccess: selection.kind,
              capability: selection.capability,
              threadCapabilityCeiling: selection.threadCapabilityCeiling,
            }
          : {
              ...candidateBase,
              input: { ...candidateBase.input, mode: "background" },
              workspaceAccess: selection.kind,
              capability: selection.capability,
              threadCapabilityCeiling: selection.threadCapabilityCeiling,
            };
      const admissionPlan = admission.plan([candidate]);
      const admitted = admissionPlan.admitted[0];
      if (admitted === undefined) {
        const reason = admissionPlan.rejected[0]?.reason;
        return reject(
          reason === "total_limit"
            ? "Agent resume rejected because the saved session reached its total child Run limit."
            : "Agent resume rejected because the saved session reached its active child Run limit.",
        );
      }
      const childRunId: SubagentRunId = `subagent-${randomUUID()}`;
      let workspaceSelection:
        | {
            readonly kind: "read_only";
            readonly capability: ReadOnlySubagentCapabilitySnapshot;
            readonly threadCapabilityCeiling: ReadOnlySubagentCapabilitySnapshot;
          }
        | {
            readonly kind: "isolated_write";
            readonly capability: WriterSubagentCapabilitySnapshot;
            readonly threadCapabilityCeiling: WriterSubagentCapabilitySnapshot;
            readonly lease: SubagentWriteWorkspaceLease;
          };
      if (selection.kind === "isolated_write") {
        if (options.writeWorkspace === undefined) {
          return reject(
            "Agent resume rejected because writer workspace isolation is unavailable.",
          );
        }
        const reacquisition = options.writeWorkspace.reacquire({
          childRunId,
          previous: selection.previousWorkspace,
          signal: request.signal,
        });
        if (reacquisition.kind === "rejected") {
          return reject(reacquisition.reason);
        }
        workspaceSelection = {
          kind: "isolated_write",
          capability: selection.capability,
          threadCapabilityCeiling: selection.threadCapabilityCeiling,
          lease: reacquisition.lease,
        };
      } else {
        workspaceSelection = {
          kind: "read_only",
          capability: selection.capability,
          threadCapabilityCeiling: selection.threadCapabilityCeiling,
        };
      }
      let persistence: SubagentRunPersistence;
      try {
        const acceptedBase = {
          delegationId,
          childAgentId: request.childAgentId,
          childRunId,
          parentRunId: options.parentRunId,
          parentToolCallId: request.toolCallId,
          task: request.message,
          focusPaths: request.focusPaths,
          providerId: execution.snapshot.providerId,
          model: execution.snapshot.model,
          effort: execution.snapshot.effort,
          systemPrompt: request.systemPrompt,
          lineage: {
            kind: "continuation" as const,
            previousRunId: request.previousRunId,
          },
        };
        persistence = options.lifecyclePersistence.accepted(
          workspaceSelection.kind === "isolated_write"
            ? {
                ...acceptedBase,
                mode: "foreground",
                threadCapabilityCeiling:
                  workspaceSelection.threadCapabilityCeiling,
                capability: workspaceSelection.capability,
                workspace: workspaceSelection.lease.reference,
              }
            : {
                ...acceptedBase,
                mode: "background",
                threadCapabilityCeiling:
                  workspaceSelection.threadCapabilityCeiling,
                capability: workspaceSelection.capability,
                workspace: null,
              },
        );
      } catch (caught) {
        if (caught instanceof SubagentPersistenceError) throw caught;
        return reject(
          `Agent resume rejected because lifecycle acceptance failed: ${errorMessage(caught)}`,
        );
      }
      const admissionLease = admission.commitOne(admitted);
      const acceptedWorkspace: PreparedAcceptedWorkspace =
        workspaceSelection.kind === "isolated_write"
          ? {
              kind: "isolated_write",
              capability: workspaceSelection.capability,
              lease: workspaceSelection.lease,
            }
          : {
              kind: "read_only",
              capability: workspaceSelection.capability,
            };
      const receipt = createAcceptedReceipt(
        {
          value: candidate,
          maxCostUsd: remainingCostUsd,
          maxResultChars: MAX_SUBAGENT_RESULT_CHARS,
        },
        admissionLease,
        request.childAgentId,
        childRunId,
        persistence,
        acceptedWorkspace,
        request.systemPrompt,
      );
      receipts.set(delegationId, receipt);
      publishProgress({
        status: "queued",
        delegationId,
        task: request.message,
        elapsedMs: 0,
        deadlineMs: capability.deadlineMs,
      });
      const result = receipt.run();
      if (workspaceSelection.kind === "isolated_write") {
        const settled = await result;
        return {
          ok: settled.status === "completed",
          content: projectSubagentResult(settled),
        };
      }
      options.background.register({
        delegationId,
        childAgentId: request.childAgentId,
        childRunId,
        task: request.message,
        result,
        cancel: receipt.cancel,
        input: receipt.input,
      });
      return {
        ok: true,
        content: JSON.stringify({
          agentId: request.childAgentId,
          runId: childRunId,
          status: receipt.record.state.kind,
        }),
      };
    },
  };

  return {
    capability,
    continuation,
    resultContinuationBudget,
    activeAgentRunCount: admission.activeAgentRunCount,
    activeChildRunCount: () => admission.activeAgentRunCount() - 1,
    totalAcceptedCount: admission.totalChildRunCount,
    runSnapshots: () =>
      [...receipts.values()].flatMap((receipt) =>
        receipt.kind === "accepted" ? [runSnapshot(receipt.record)] : [],
      ),
  };
}
