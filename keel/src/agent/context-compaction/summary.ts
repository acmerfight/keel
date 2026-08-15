import { errorMessage, KeelError } from "../../core/error.ts";
import {
  appendSessionTaskProgressToSummary,
  type SessionTaskProgress,
} from "../../core/task-progress.ts";
import type {
  LLMProvider,
  LLMStopReason,
  ProviderMessage,
  ProviderRequestAttemptObserver,
  Usage,
} from "../../llm/types.ts";
import { isUntrustedMcpContentToolCall } from "../../tools/registry.ts";
import type {
  ModelOperationHandle,
  ModelOperationPurpose,
  ModelOperationRequest,
} from "../model-operations.ts";
import { combineProviderRequestAttemptObservers } from "../provider-request-attempts.ts";
import type { SessionMessage } from "../session-message.ts";
import type {
  ToolOutputArtifactCompactionArtifact,
  ToolOutputArtifactNotice,
  ToolOutputArtifactStore,
  ToolOutputArtifactsOptions,
} from "../tool-output-artifacts.ts";
import {
  checkpointEvidenceFromMessage,
  normalizeCheckpointSummary,
  renderConversationCheckpoint,
  serializeCheckpointMessageForSummaryPrompt,
} from "./checkpoint.ts";
import {
  type CompactionEvidence,
  collectToolCompactionEvidence,
  mergeCompactionEvidence,
  renderCompactionEvidenceSection,
} from "./evidence.ts";
import {
  MIN_SUMMARY_INPUT_MAX_CHARS,
  type ResolvedContextCompactionOptions,
} from "./options.ts";
import { smallerCompactionPrefixMessageCount } from "./planning.ts";
import {
  compactStaleToolOutputs,
  compactStaleToolOutputsWithArtifacts,
  type StaleToolOutputCompactionStats,
} from "./stale-tool-output.ts";
import {
  projectCompactedToolOutput,
  type ToolOutputProjectionContext,
} from "./tool-output-preview.ts";

const MAX_SUMMARY_RETRIES = 3;
const MAX_COMPACTION_EVIDENCE_CHARS = 12_000;
const MIN_COMPACTION_EVIDENCE_CHARS = 1_000;
const MIN_COMPACTION_CONVERSATION_CHARS = Math.floor(
  MIN_SUMMARY_INPUT_MAX_CHARS / 3,
);

interface TextOnlyTurn {
  readonly text: string;
  readonly usage: Usage;
  readonly stopReason: LLMStopReason;
}

interface CompactionSummaryTurn extends TextOnlyTurn {
  readonly summaryInputMaxChars: number;
  readonly summarizedMessageCount: number;
}

export type CompactionSummaryFailure =
  | {
      readonly code: "summary_truncated";
      readonly message: string;
    }
  | {
      readonly code: "summary_error";
      readonly message: string;
      readonly error: unknown;
    };

export interface CompactionSummaryErrorDetails {
  readonly error: unknown;
  readonly usage: Usage;
}

class CompactionSummaryAttemptsError extends Error {
  readonly originalError: unknown;
  readonly usage: Usage;

  constructor(error: unknown, usage: Usage) {
    super(errorMessage(error));
    this.name = "CompactionSummaryAttemptsError";
    this.originalError = error;
    this.usage = usage;
  }
}

export function compactionSummaryErrorDetails(
  error: unknown,
): CompactionSummaryErrorDetails | null {
  return error instanceof CompactionSummaryAttemptsError
    ? { error: error.originalError, usage: error.usage }
    : null;
}

type CollectCompactionSummaryResult =
  | {
      readonly complete: true;
      readonly turn: CompactionSummaryTurn;
    }
  | {
      readonly complete: false;
      readonly failure: CompactionSummaryFailure;
      readonly usage: Usage;
    };

export interface BuildCompactedMessagesResult {
  readonly messages: readonly SessionMessage[];
  readonly staleToolOutputStats: StaleToolOutputCompactionStats;
  readonly artifactNotices?: readonly ToolOutputArtifactNotice[];
  readonly artifactReports?: readonly ToolOutputArtifactCompactionArtifact[];
}

function toolContextForSummaryInput(
  messages: readonly SessionMessage[],
  toolCallId: string,
): ToolOutputProjectionContext {
  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }
    const toolCall = message.toolCalls.find(
      (candidate) => candidate.id === toolCallId,
    );
    if (toolCall !== undefined) {
      return { toolCall };
    }
  }
  return { toolCall: null };
}

function summaryToolOutputPreview(options: {
  readonly messages: readonly SessionMessage[];
  readonly message: Extract<SessionMessage, { readonly role: "tool" }>;
  readonly toolOutputMaxChars: number;
}): string {
  if (options.message.content.length <= options.toolOutputMaxChars) {
    return options.message.content;
  }
  const projection = projectCompactedToolOutput({
    text: options.message.content,
    maxChars: options.toolOutputMaxChars,
    context: toolContextForSummaryInput(
      options.messages,
      options.message.toolCallId,
    ),
    purpose: "summary-input",
  });
  return `${projection.preview}\n[truncated ${projection.omittedChars} chars from summary input preview]`;
}

function serializeMessage(
  messages: readonly SessionMessage[],
  message: SessionMessage,
  toolOutputMaxChars: number,
): string {
  switch (message.role) {
    case "user": {
      const checkpoint = serializeCheckpointMessageForSummaryPrompt(message);
      if (checkpoint !== null) {
        return checkpoint;
      }
      return `<message role="user">\n${message.content}\n</message>`;
    }
    case "assistant": {
      const { toolCalls } = message;
      const toolCallText =
        toolCalls.length === 0
          ? ""
          : `\n<tool-calls>\n${JSON.stringify(toolCalls)}\n</tool-calls>`;
      return `<message role="assistant">\n${message.content}${toolCallText}\n</message>`;
    }
    case "tool":
      return `<message role="tool" tool_call_id="${message.toolCallId}">\n${summaryToolOutputPreview(
        {
          messages,
          message,
          toolOutputMaxChars,
        },
      )}\n</message>`;
  }
}

function normalizeFocusInstruction(
  focusInstruction: string | undefined,
): string | undefined {
  const trimmed = focusInstruction?.trim();
  if (trimmed === undefined || trimmed === "") {
    return undefined;
  }
  return trimmed;
}

function checkpointEvidenceFromMessages(
  messages: readonly SessionMessage[],
): readonly CompactionEvidence[] {
  return messages.flatMap((message) =>
    message.role === "user" ? checkpointEvidenceFromMessage(message) : [],
  );
}

function checkpointContainsUntrustedMcpContent(
  messages: readonly SessionMessage[],
): boolean {
  return messages.some(
    (message) =>
      (message.role === "assistant" &&
        message.toolCalls.some(isUntrustedMcpContentToolCall)) ||
      (message.role === "user" &&
        message.contextCompaction?.untrustedMcpContent === true),
  );
}

function compactionEvidenceForMessages(options: {
  readonly messages: readonly SessionMessage[];
  readonly toolOutputMaxChars: number;
  readonly artifactStore: ToolOutputArtifactStore | undefined;
}): Promise<readonly CompactionEvidence[]> {
  return collectToolCompactionEvidence(
    options.messages,
    options.toolOutputMaxChars,
    options.artifactStore,
  ).then((toolEvidence) =>
    mergeCompactionEvidence(
      checkpointEvidenceFromMessages(options.messages),
      toolEvidence,
    ),
  );
}

async function renderCompactionEvidenceForMessages(options: {
  readonly messages: readonly SessionMessage[];
  readonly toolOutputMaxChars: number;
  readonly summaryInputMaxChars: number;
  readonly artifactStore: ToolOutputArtifactStore | undefined;
}): Promise<string> {
  const evidence = await compactionEvidenceForMessages(options);
  return evidence.length === 0
    ? ""
    : renderCompactionEvidenceSection(evidence, {
        maxChars: compactionEvidenceMaxChars(options.summaryInputMaxChars),
      });
}

function compactionEvidenceMaxChars(summaryInputMaxChars: number): number {
  if (summaryInputMaxChars <= 0) {
    return 0;
  }
  if (summaryInputMaxChars < MIN_SUMMARY_INPUT_MAX_CHARS) {
    return summaryInputMaxChars;
  }
  const conversationReserveChars = Math.max(
    MIN_COMPACTION_CONVERSATION_CHARS,
    Math.floor(summaryInputMaxChars / 3),
  );
  const maxEvidenceAfterConversationReserve =
    summaryInputMaxChars - conversationReserveChars;
  return Math.min(
    maxEvidenceAfterConversationReserve,
    Math.min(
      MAX_COMPACTION_EVIDENCE_CHARS,
      Math.max(
        MIN_COMPACTION_EVIDENCE_CHARS,
        Math.floor(summaryInputMaxChars / 3),
      ),
    ),
  );
}

function selectSummaryInput(
  serializedMessages: readonly string[],
  maxChars: number,
): { readonly context: string; readonly omittedCount: number } {
  let remaining = Math.max(0, maxChars);
  const selected: string[] = [];

  const indexedMessages = Array.from(serializedMessages.entries()).reverse();
  for (const [index, message] of indexedMessages) {
    const separatorChars = selected.length === 0 ? 0 : 2;
    if (message.length + separatorChars <= remaining) {
      selected.push(message);
      remaining -= message.length + separatorChars;
      continue;
    }

    if (remaining > 200) {
      selected.push(
        `[earlier content in this message omitted]\n${message.slice(-remaining)}`,
      );
      selected.reverse();
      return { context: selected.join("\n\n"), omittedCount: index };
    }
    selected.reverse();
    return { context: selected.join("\n\n"), omittedCount: index + 1 };
  }

  selected.reverse();
  return { context: selected.join("\n\n"), omittedCount: 0 };
}

async function buildSummaryPrompt(
  messages: readonly SessionMessage[],
  options: ResolvedContextCompactionOptions,
  summaryInputMaxChars = options.summaryInputMaxChars,
  focusInstruction?: string,
  artifactStore?: ToolOutputArtifactStore,
): Promise<string> {
  const normalizedFocusInstruction =
    normalizeFocusInstruction(focusInstruction);
  const evidenceSection = await renderCompactionEvidenceForMessages({
    messages,
    toolOutputMaxChars: options.toolOutputMaxChars,
    summaryInputMaxChars,
    artifactStore,
  });
  const selected = selectSummaryInput(
    messages.map((message) =>
      serializeMessage(messages, message, options.toolOutputMaxChars),
    ),
    Math.max(0, summaryInputMaxChars - evidenceSection.length),
  );
  const promptParts = [
    "Create a compact checkpoint summary for an ongoing coding-agent conversation.",
    "Do not call tools. Output concise Markdown only.",
    "Preserve exact file paths, commands, errors, user constraints, current task state, decisions, and next steps.",
  ];
  if (normalizedFocusInstruction !== undefined) {
    promptParts.push(
      `User manual compaction focus instruction:\n${normalizedFocusInstruction}`,
    );
  }
  if (evidenceSection !== "") {
    promptParts.push(
      [
        "Source-backed evidence handles that must survive this checkpoint.",
        "When a summary claim depends on exact tool output, file content, search results, or diffs, keep the relevant handle and inspect command.",
      ].join("\n"),
      evidenceSection,
    );
  }
  promptParts.push(
    "Use these sections in order: Current Task, Constraints, Completed, In Progress, Relevant Files, Commands and Tests, Errors and Fixes, Next Steps.",
    "<conversation>",
  );
  if (selected.omittedCount > 0) {
    promptParts.push(
      `[${selected.omittedCount} older message(s) omitted to fit the compaction request]`,
    );
  }
  promptParts.push(selected.context, "</conversation>");
  return promptParts.join("\n\n");
}

export async function buildCompactedMessages(
  messages: readonly SessionMessage[],
  firstRetainedIndex: number,
  summary: string,
  options: ResolvedContextCompactionOptions,
  toolOutputArtifacts?: ToolOutputArtifactsOptions,
  summaryInputMaxChars = options.summaryInputMaxChars,
  taskProgress?: SessionTaskProgress,
): Promise<BuildCompactedMessagesResult> {
  const recentMessages = messages.slice(firstRetainedIndex);
  const checkpointSourceMessages = messages.slice(0, firstRetainedIndex);
  const recent =
    toolOutputArtifacts === undefined
      ? compactStaleToolOutputs(recentMessages, options.toolOutputMaxChars)
      : await compactStaleToolOutputsWithArtifacts(
          recentMessages,
          options.toolOutputMaxChars,
          toolOutputArtifacts.store,
        );
  const checkpointEvidence = await compactionEvidenceForMessages({
    messages: checkpointSourceMessages,
    toolOutputMaxChars: options.toolOutputMaxChars,
    artifactStore: toolOutputArtifacts?.store,
  });
  const untrustedMcpContent = checkpointContainsUntrustedMcpContent(
    checkpointSourceMessages,
  );
  const checkpoint = renderConversationCheckpoint({
    summary: normalizeCheckpointSummary(
      appendSessionTaskProgressToSummary(summary, taskProgress),
    ),
    noLaterMessages: recent.messages.length === 0,
    evidence: checkpointEvidence,
    evidenceMaxChars: compactionEvidenceMaxChars(summaryInputMaxChars),
  });
  return {
    messages: [
      {
        role: "user",
        content: checkpoint,
        origin: { type: "compaction_checkpoint" },
        ...(checkpointEvidence.length === 0 && !untrustedMcpContent
          ? {}
          : {
              contextCompaction: {
                evidence: checkpointEvidence,
                ...(untrustedMcpContent ? { untrustedMcpContent: true } : {}),
              },
            }),
      },
      ...recent.messages,
    ],
    staleToolOutputStats: recent.stats,
    ...(recent.artifactNotices !== undefined &&
    recent.artifactNotices.length > 0
      ? { artifactNotices: recent.artifactNotices }
      : {}),
    ...(recent.artifactReports !== undefined &&
    recent.artifactReports.length > 0
      ? { artifactReports: recent.artifactReports }
      : {}),
  };
}

async function collectTextOnlyTurn(options: {
  readonly provider: LLMProvider;
  readonly systemPrompt: string;
  readonly messages: readonly ProviderMessage[];
  readonly signal: AbortSignal;
  readonly operation: ModelOperationHandle | null;
  readonly providerRequestAttempts?: ProviderRequestAttemptObserver;
}): Promise<TextOnlyTurn> {
  let text = "";
  let usage: Usage | null = null;
  let stopReason: LLMStopReason | null = null;
  const providerRequestAttempts = combineProviderRequestAttemptObservers([
    options.providerRequestAttempts,
    options.operation?.providerRequestAttempts,
  ]);
  for await (const event of options.provider.stream({
    systemPrompt: options.systemPrompt,
    messages: options.messages,
    signal: options.signal,
    toolExposure: { kind: "none" },
    ...(providerRequestAttempts === undefined
      ? {}
      : { providerRequestAttempts }),
  })) {
    switch (event.type) {
      case "text":
        text += event.text;
        break;
      case "reasoning":
        break;
      case "tool_call":
        throw new KeelError(
          "provider_protocol_error",
          `${options.provider.id} returned a tool call during context compaction`,
        );
      case "provider_retry":
        break;
      case "stop":
        usage = event.usage;
        stopReason = event.reason;
        break;
    }
  }
  if (usage === null || stopReason === null) {
    throw new KeelError(
      "agent_missing_stop",
      "LLM stream ended without stop event",
    );
  }
  return { text, usage, stopReason };
}

const ZERO_USAGE: Usage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  uncachedInputTokens: 0,
  outputTokens: 0,
};

function addUsage(left: Usage, right: Usage): Usage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    uncachedInputTokens: left.uncachedInputTokens + right.uncachedInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
  };
}

function isProviderContextOverflow(error: unknown): boolean {
  return (
    error instanceof KeelError && error.code === "provider_context_overflow"
  );
}

type CompactionModelOperationRequest = ModelOperationRequest<
  Extract<
    ModelOperationPurpose,
    "context_compaction" | "manual_compaction" | "model_switch_compaction"
  >
>;

interface CollectCompactionSummaryOptions {
  readonly provider: LLMProvider;
  readonly systemPrompt: string;
  readonly messagesToSummarize: readonly SessionMessage[];
  readonly signal: AbortSignal;
  readonly contextCompaction: ResolvedContextCompactionOptions;
  readonly toolOutputArtifacts?: ToolOutputArtifactsOptions;
  readonly focusInstruction?: string;
  readonly modelOperation?: CompactionModelOperationRequest;
  readonly providerRequestAttempts?: ProviderRequestAttemptObserver;
}

function beginCompactionModelOperation(
  request: CompactionModelOperationRequest | null,
): ModelOperationHandle | null {
  if (request === null) {
    return null;
  }
  switch (request.purpose) {
    case "context_compaction":
      return request.instrumentation.recorder.beginModelOperation({
        ...request.instrumentation,
        purpose: request.purpose,
        recoveryFor: request.recoveryFor,
      });
    case "manual_compaction":
    case "model_switch_compaction":
      return request.instrumentation.recorder.beginModelOperation({
        ...request.instrumentation,
        purpose: request.purpose,
        recoveryFor: null,
      });
  }
}

export async function collectCompactionSummary(
  options: CollectCompactionSummaryOptions,
): Promise<CollectCompactionSummaryResult> {
  const operation = beginCompactionModelOperation(
    options.modelOperation ?? null,
  );
  let result: CollectCompactionSummaryResult;
  try {
    result = await collectCompactionSummaryAttempts(options, operation);
  } catch (error) {
    const details = compactionSummaryErrorDetails(error);
    operation?.finishFromError(details?.error ?? error);
    throw error;
  }
  operation?.finish({
    outcome: result.complete ? "completed" : "terminal_error",
  });
  return result;
}

async function collectCompactionSummaryAttempts(
  options: CollectCompactionSummaryOptions,
  operation: ModelOperationHandle | null,
): Promise<CollectCompactionSummaryResult> {
  let summaryInputMaxChars = options.contextCompaction.summaryInputMaxChars;
  let messagesToSummarize = options.messagesToSummarize;
  let usage = ZERO_USAGE;

  let retryCount = 0;
  let attemptCount = 0;
  let completedAttemptCount = 0;
  while (true) {
    const prompt = buildSummaryPrompt(
      messagesToSummarize,
      options.contextCompaction,
      summaryInputMaxChars,
      options.focusInstruction,
      options.toolOutputArtifacts?.store,
    );
    attemptCount++;
    try {
      const turn = await collectTextOnlyTurn({
        provider: options.provider,
        systemPrompt: options.systemPrompt,
        messages: [{ role: "user", content: await prompt }],
        signal: options.signal,
        operation,
        ...(options.providerRequestAttempts === undefined
          ? {}
          : { providerRequestAttempts: options.providerRequestAttempts }),
      });
      completedAttemptCount++;
      usage = addUsage(usage, turn.usage);
      if (turn.stopReason === "stop") {
        return {
          complete: true,
          turn: {
            ...turn,
            usage,
            summaryInputMaxChars,
            summarizedMessageCount: messagesToSummarize.length,
          },
        };
      }

      const smallerMessageCount =
        smallerCompactionPrefixMessageCount(messagesToSummarize);
      if (retryCount === MAX_SUMMARY_RETRIES || smallerMessageCount === null) {
        const attemptLabel = attemptCount === 1 ? "attempt" : "attempts";
        return {
          complete: false,
          failure: {
            code: "summary_truncated",
            message: `${options.provider.id} returned length-truncated context compaction summaries after ${attemptCount} ${attemptLabel}.`,
          },
          usage,
        };
      }
      retryCount++;
      messagesToSummarize = messagesToSummarize.slice(0, smallerMessageCount);
    } catch (error) {
      if (!isProviderContextOverflow(error)) {
        throw completedAttemptCount === 0
          ? error
          : new CompactionSummaryAttemptsError(error, usage);
      }
      const reduced = Math.floor(summaryInputMaxChars / 2);
      if (
        retryCount === MAX_SUMMARY_RETRIES ||
        reduced < MIN_SUMMARY_INPUT_MAX_CHARS
      ) {
        throw completedAttemptCount === 0
          ? error
          : new CompactionSummaryAttemptsError(error, usage);
      }
      retryCount++;
      summaryInputMaxChars = reduced;
    }
  }
}
