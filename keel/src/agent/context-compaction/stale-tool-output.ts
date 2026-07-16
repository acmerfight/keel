import type { Message } from "../../llm/types.ts";
import { isPostCompactionReadToolCallId } from "../post-compaction-read-id.ts";
import {
  generatedToolOutputArtifactMarker,
  isGeneratedSettledToolOutput,
  sourceStatusFromToolOutputText,
  TOOL_OUTPUT_ARTIFACT_MODEL_RECOVERY,
  type ToolOutputArtifactCompactionArtifact,
  type ToolOutputArtifactNotice,
  type ToolOutputArtifactPurpose,
  type ToolOutputArtifactSourceStatus,
  type ToolOutputArtifactStore,
  type ToolOutputArtifactToolName,
  toolOutputArtifactFailedMarker,
  toolOutputArtifactStoredMarker,
} from "../tool-output-artifacts.ts";
import { currentToolRound } from "./current-tool-round.ts";
import { estimateTextTokens } from "./token-accounting.ts";
import {
  type ProjectedToolOutput,
  projectCompactedToolOutput,
  type ToolOutputProjectionContext,
} from "./tool-output-preview.ts";

const STALE_TOOL_OUTPUT_COMPACTED_PREFIX =
  "[stale tool output compacted: approximately omitted ";
const STALE_TOOL_OUTPUT_COMPACTED_SUFFIX = " chars]";
const STALE_TOOL_OUTPUT_COMPACTED_SUFFIX_PATTERN =
  /\n\[stale tool output compacted: approximately omitted [0-9]+ chars(?:; [^\]]+)?\]$/;
const STALE_TOOL_OUTPUT_COMPACTED_OVERHEAD_CHARS =
  "\n".length +
  STALE_TOOL_OUTPUT_COMPACTED_PREFIX.length +
  String(Number.MAX_SAFE_INTEGER).length +
  STALE_TOOL_OUTPUT_COMPACTED_SUFFIX.length;
const CURRENT_TOOL_OUTPUT_COMPACTED_PREFIX =
  "[current tool output compacted after context overflow: approximately omitted ";
const CURRENT_TOOL_OUTPUT_COMPACTED_SUFFIX =
  " chars; rerun the tool with narrower parameters if needed]";
const CURRENT_TOOL_OUTPUT_COMPACTED_SUFFIX_PATTERN =
  /\n\[current tool output compacted after context overflow: approximately omitted [0-9]+ chars(?:; [^\]]+)?\]$/;
const PREFLIGHT_CURRENT_TOOL_OUTPUT_COMPACTED_PREFIX =
  "[current tool output compacted before provider request: approximately omitted ";
const PREFLIGHT_CURRENT_TOOL_OUTPUT_COMPACTED_SUFFIX =
  " chars; rerun the tool with narrower parameters if needed]";
const PREFLIGHT_CURRENT_TOOL_OUTPUT_COMPACTED_SUFFIX_PATTERN =
  /\n\[current tool output compacted before provider request: approximately omitted [0-9]+ chars(?:; [^\]]+)?\]$/;
const CURRENT_TOOL_OUTPUT_COMPACTED_MARKER_PATTERN =
  /\n\[(?:current tool output compacted after context overflow|current tool output compacted before provider request): approximately omitted ([0-9]+) chars(?:; [^\]]+)?\]$/;

export type CurrentToolOutputCompactionReason =
  | "overflow_recovery"
  | "preflight";

interface CurrentToolOutputCompactionOptions {
  readonly reason?: CurrentToolOutputCompactionReason;
  readonly settledMaxChars?: number;
  readonly allowPreflightRecompaction?: boolean;
}

export interface StaleToolOutputCompactionStats {
  readonly toolOutputsCompacted: number;
  readonly staleToolOutputsCompacted: number;
  readonly currentToolOutputsCompacted: number;
  readonly toolOutputCharsBefore: number;
  readonly toolOutputCharsAfter: number;
  readonly toolOutputEstimatedTokensBefore: number;
  readonly toolOutputEstimatedTokensAfter: number;
}

export interface StaleToolOutputCompactionResult {
  readonly messages: readonly Message[];
  readonly stats: StaleToolOutputCompactionStats;
  readonly artifactNotices?: readonly ToolOutputArtifactNotice[];
  readonly artifactReports?: readonly ToolOutputArtifactCompactionArtifact[];
}

interface StaleToolOutputCompactionEntry {
  readonly message: Message;
  readonly stats: StaleToolOutputCompactionStats;
  readonly artifactNotice?: ToolOutputArtifactNotice;
  readonly artifactReport?: ToolOutputArtifactCompactionArtifact;
}

type ToolOutputCompactionAttempt =
  | {
      readonly status: "accepted";
      readonly entry: StaleToolOutputCompactionEntry;
    }
  | {
      readonly status: "rejected";
      readonly entry: StaleToolOutputCompactionEntry;
      readonly pendingStoredArtifactRef?: string;
    };

export const EMPTY_STALE_TOOL_OUTPUT_COMPACTION_STATS: StaleToolOutputCompactionStats =
  {
    toolOutputsCompacted: 0,
    staleToolOutputsCompacted: 0,
    currentToolOutputsCompacted: 0,
    toolOutputCharsBefore: 0,
    toolOutputCharsAfter: 0,
    toolOutputEstimatedTokensBefore: 0,
    toolOutputEstimatedTokensAfter: 0,
  };

type ToolOutputCompactionStatsScope = "current" | "stale";

function toolOutputCompactionStats(
  originalContent: string,
  compactedContent: string,
  scope: ToolOutputCompactionStatsScope,
): StaleToolOutputCompactionStats {
  return {
    toolOutputsCompacted: 1,
    staleToolOutputsCompacted: scope === "stale" ? 1 : 0,
    currentToolOutputsCompacted: scope === "current" ? 1 : 0,
    toolOutputCharsBefore: originalContent.length,
    toolOutputCharsAfter: compactedContent.length,
    toolOutputEstimatedTokensBefore: estimateTextTokens(originalContent),
    toolOutputEstimatedTokensAfter: estimateTextTokens(compactedContent),
  };
}

export function mergeStaleToolOutputCompactionStats(
  left: StaleToolOutputCompactionStats,
  right: StaleToolOutputCompactionStats,
): StaleToolOutputCompactionStats {
  return {
    toolOutputsCompacted:
      left.toolOutputsCompacted + right.toolOutputsCompacted,
    staleToolOutputsCompacted:
      left.staleToolOutputsCompacted + right.staleToolOutputsCompacted,
    currentToolOutputsCompacted:
      left.currentToolOutputsCompacted + right.currentToolOutputsCompacted,
    toolOutputCharsBefore:
      left.toolOutputCharsBefore + right.toolOutputCharsBefore,
    toolOutputCharsAfter:
      left.toolOutputCharsAfter + right.toolOutputCharsAfter,
    toolOutputEstimatedTokensBefore:
      left.toolOutputEstimatedTokensBefore +
      right.toolOutputEstimatedTokensBefore,
    toolOutputEstimatedTokensAfter:
      left.toolOutputEstimatedTokensAfter +
      right.toolOutputEstimatedTokensAfter,
  };
}

function staleToolOutputCompactedMarker(
  omittedChars: number,
  artifactMarker?: string,
): string {
  if (artifactMarker !== undefined) {
    return `${STALE_TOOL_OUTPUT_COMPACTED_PREFIX}${omittedChars} chars; ${artifactMarker}]`;
  }
  return `${STALE_TOOL_OUTPUT_COMPACTED_PREFIX}${omittedChars}${STALE_TOOL_OUTPUT_COMPACTED_SUFFIX}`;
}

function currentToolOutputCompactedMarker(
  omittedChars: number,
  artifactMarker?: string,
  reason: CurrentToolOutputCompactionReason = "overflow_recovery",
): string {
  const markerPrefix =
    reason === "preflight"
      ? PREFLIGHT_CURRENT_TOOL_OUTPUT_COMPACTED_PREFIX
      : CURRENT_TOOL_OUTPUT_COMPACTED_PREFIX;
  const markerSuffix =
    reason === "preflight"
      ? PREFLIGHT_CURRENT_TOOL_OUTPUT_COMPACTED_SUFFIX
      : CURRENT_TOOL_OUTPUT_COMPACTED_SUFFIX;
  if (artifactMarker !== undefined) {
    const markerWithRecovery = artifactMarker.includes(
      TOOL_OUTPUT_ARTIFACT_MODEL_RECOVERY,
    )
      ? artifactMarker
      : `${artifactMarker}; ${TOOL_OUTPUT_ARTIFACT_MODEL_RECOVERY}`;
    return `${markerPrefix}${omittedChars} chars; ${markerWithRecovery}]`;
  }
  return `${markerPrefix}${omittedChars}${markerSuffix}`;
}

function isAlreadyCompactedStaleToolOutput(
  text: string,
  maxChars: number,
): boolean {
  return (
    STALE_TOOL_OUTPUT_COMPACTED_SUFFIX_PATTERN.test(text) &&
    text.length <= maxChars + STALE_TOOL_OUTPUT_COMPACTED_OVERHEAD_CHARS
  );
}

export function isCompactedCurrentToolOutput(text: string): boolean {
  return (
    CURRENT_TOOL_OUTPUT_COMPACTED_SUFFIX_PATTERN.test(text) ||
    PREFLIGHT_CURRENT_TOOL_OUTPUT_COMPACTED_SUFFIX_PATTERN.test(text)
  );
}

function isAlreadyCompactedCurrentToolOutput(options: {
  readonly text: string;
  readonly reason: CurrentToolOutputCompactionReason;
  readonly allowPreflightRecompaction: boolean;
}): boolean {
  return (
    isCompactedCurrentToolOutput(options.text) &&
    !canOverflowRecoveryRecompactPreflightCurrentToolOutput(options)
  );
}

function canOverflowRecoveryRecompactPreflightCurrentToolOutput(options: {
  readonly text: string;
  readonly reason: CurrentToolOutputCompactionReason;
  readonly allowPreflightRecompaction: boolean;
}): boolean {
  return (
    options.reason === "overflow_recovery" &&
    options.allowPreflightRecompaction &&
    PREFLIGHT_CURRENT_TOOL_OUTPUT_COMPACTED_SUFFIX_PATTERN.test(options.text)
  );
}

function compactStaleToolOutput(
  projection: ProjectedToolOutput,
  artifactMarker?: string,
): string {
  return `${projection.preview}\n${staleToolOutputCompactedMarker(
    projection.omittedChars,
    artifactMarker,
  )}`;
}

function compactCurrentToolOutput(
  projection: ProjectedToolOutput,
  artifactMarker?: string,
  reason?: CurrentToolOutputCompactionReason,
  omittedChars = projection.omittedChars,
): string {
  return `${projection.preview}\n${currentToolOutputCompactedMarker(
    omittedChars,
    artifactMarker,
    reason,
  )}`;
}

function omittedCharsForCurrentOutputRecompaction(
  content: string,
  projectedOmittedChars: number,
): number {
  const marker = CURRENT_TOOL_OUTPUT_COMPACTED_MARKER_PATTERN.exec(content);
  if (marker === null) {
    return projectedOmittedChars;
  }
  const existingOmittedChars = Number(marker[1]);
  if (!Number.isSafeInteger(existingOmittedChars)) {
    return projectedOmittedChars;
  }
  const retainedPreviewChars = Math.min(
    content.length,
    Math.max(0, content.length - projectedOmittedChars),
  );
  return (
    existingOmittedChars + Math.max(0, marker.index - retainedPreviewChars)
  );
}

function shouldCompactStaleToolOutput(
  message: Message,
  messageIndex: number,
  lastAssistantIndex: number,
  toolOutputMaxChars: number,
): boolean {
  return (
    message.role === "tool" &&
    messageIndex < lastAssistantIndex &&
    message.content.length > toolOutputMaxChars &&
    !isGeneratedSettledToolOutput(message.content, toolOutputMaxChars) &&
    !isAlreadyCompactedStaleToolOutput(message.content, toolOutputMaxChars)
  );
}

function shouldCompactCurrentToolOutput(
  message: Message,
  messageIndex: number,
  currentToolOutputIndexes: ReadonlySet<number>,
  toolOutputMaxChars: number,
  settledMaxChars: number,
  reason: CurrentToolOutputCompactionReason,
  allowPreflightRecompaction: boolean,
): boolean {
  const allowSettledPreflightRecompaction =
    canOverflowRecoveryRecompactPreflightCurrentToolOutput({
      text: message.content,
      reason,
      allowPreflightRecompaction,
    });
  return (
    message.role === "tool" &&
    currentToolOutputIndexes.has(messageIndex) &&
    !(
      reason === "preflight" &&
      isPostCompactionReadToolCallId(message.toolCallId)
    ) &&
    message.content.length > toolOutputMaxChars &&
    (allowSettledPreflightRecompaction ||
      !isGeneratedSettledToolOutput(message.content, settledMaxChars)) &&
    !isAlreadyCompactedCurrentToolOutput({
      text: message.content,
      reason,
      allowPreflightRecompaction,
    })
  );
}

function sourceStatusForCompaction(
  message: Extract<Message, { readonly role: "tool" }>,
): ToolOutputArtifactSourceStatus {
  if (message.sourceTruncated !== undefined) {
    return message.sourceTruncated ? "source-truncated" : "complete";
  }
  return sourceStatusFromToolOutputText(message.content);
}

function toolContextForToolOutput(
  messages: readonly Message[],
  toolCallId: string,
): ToolOutputProjectionContext {
  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }
    const toolCall = message.toolCalls.find(
      (candidate) => candidate.id === toolCallId,
    );
    /* v8 ignore next: valid tool-result ledgers preserve the matching assistant tool call; corrupted histories fall through below. */
    if (toolCall !== undefined) {
      return { toolCall };
    }
  }
  /* v8 ignore next: valid tool-result ledgers preserve the matching assistant tool call; this labels corrupted current-schema histories. */
  return { toolCall: null };
}

function artifactToolNameForContext(
  context: ToolOutputProjectionContext,
): ToolOutputArtifactToolName {
  return context.toolCall === null ? "unknown" : context.toolCall.tool;
}

function rejectedToolOutputCompactionAttempt(options: {
  readonly message: Message;
  readonly artifactReport?: ToolOutputArtifactCompactionArtifact;
}): ToolOutputCompactionAttempt {
  const pendingStoredArtifactRef =
    options.artifactReport?.status === "stored"
      ? options.artifactReport.ref
      : undefined;
  return {
    status: "rejected",
    entry: {
      message: options.message,
      stats: EMPTY_STALE_TOOL_OUTPUT_COMPACTION_STATS,
    },
    ...(pendingStoredArtifactRef === undefined
      ? {}
      : { pendingStoredArtifactRef }),
  };
}

function buildToolOutputCompactionAttempt(options: {
  readonly message: Message;
  readonly compactedContent: string;
  readonly scope: ToolOutputCompactionStatsScope;
  readonly artifactNotice?: ToolOutputArtifactNotice;
  readonly artifactReport?: ToolOutputArtifactCompactionArtifact;
}): ToolOutputCompactionAttempt {
  if (options.compactedContent.length >= options.message.content.length) {
    return rejectedToolOutputCompactionAttempt({
      message: options.message,
      ...(options.artifactReport === undefined
        ? {}
        : { artifactReport: options.artifactReport }),
    });
  }
  return {
    status: "accepted",
    entry: {
      message: {
        ...options.message,
        content: options.compactedContent,
      },
      stats: toolOutputCompactionStats(
        options.message.content,
        options.compactedContent,
        options.scope,
      ),
      ...(options.artifactNotice === undefined
        ? {}
        : { artifactNotice: options.artifactNotice }),
      ...(options.artifactReport === undefined
        ? {}
        : { artifactReport: options.artifactReport }),
    },
  };
}

async function settleArtifactToolOutputCompactionAttempt(
  attempt: ToolOutputCompactionAttempt,
  store: ToolOutputArtifactStore,
): Promise<StaleToolOutputCompactionEntry> {
  if (
    attempt.status === "rejected" &&
    attempt.pendingStoredArtifactRef !== undefined
  ) {
    await store.discard(attempt.pendingStoredArtifactRef);
  }
  return attempt.entry;
}

function settleToolOutputCompactionAttempt(
  attempt: ToolOutputCompactionAttempt,
): StaleToolOutputCompactionEntry {
  return attempt.entry;
}

async function artifactMarkerForCompactedToolOutput(options: {
  readonly store: ToolOutputArtifactStore;
  readonly message: Extract<Message, { readonly role: "tool" }>;
  readonly toolCallId: string;
  readonly toolName: ToolOutputArtifactToolName;
  readonly content: string;
  readonly omittedChars: number;
  readonly purpose: ToolOutputArtifactPurpose;
}): Promise<{
  readonly marker: string;
  readonly omittedChars: number;
  readonly notice?: ToolOutputArtifactNotice;
  readonly report: ToolOutputArtifactCompactionArtifact;
}> {
  const existingArtifact = generatedToolOutputArtifactMarker(options.content);
  if (existingArtifact !== null) {
    try {
      const verification = await options.store.verifyReusable({
        ref: existingArtifact.ref,
        toolCallId: options.toolCallId,
        previewContent: options.content.slice(0, existingArtifact.markerIndex),
        omittedChars: existingArtifact.omittedChars,
        previewKind: existingArtifact.previewKind,
        sourceStatus: existingArtifact.sourceStatus,
        ...(existingArtifact.contentSha256 === undefined
          ? {}
          : { contentSha256: existingArtifact.contentSha256 }),
      });
      if (verification.status === "reusable") {
        const retainedPreviewChars = Math.min(
          options.content.length,
          Math.max(0, options.content.length - options.omittedChars),
        );
        const originalOmittedChars =
          existingArtifact.omittedChars +
          Math.max(0, existingArtifact.markerIndex - retainedPreviewChars);
        return {
          marker: toolOutputArtifactStoredMarker(
            existingArtifact.ref,
            existingArtifact.sourceStatus,
            verification.contentSha256,
          ),
          omittedChars: originalOmittedChars,
          report: {
            status: "reused",
            ref: existingArtifact.ref,
            toolCallId: options.toolCallId,
            toolName: options.toolName,
            sourceStatus: existingArtifact.sourceStatus,
            omittedChars: originalOmittedChars,
          },
        };
      }
    } catch {}
  }

  const sourceStatus = sourceStatusForCompaction(options.message);
  const saveResult = await options.store.save({
    toolCallId: options.toolCallId,
    toolName: options.toolName,
    content: options.content,
    sourceStatus,
    purpose: options.purpose,
  });
  if (saveResult.status === "stored") {
    return {
      marker: toolOutputArtifactStoredMarker(
        saveResult.ref,
        sourceStatus,
        saveResult.contentSha256,
      ),
      omittedChars: options.omittedChars,
      notice: {
        status: "stored",
        ref: saveResult.ref,
        toolCallId: options.toolCallId,
        toolName: options.toolName,
        sourceStatus,
        omittedChars: options.omittedChars,
      },
      report: {
        status: "stored",
        ref: saveResult.ref,
        toolCallId: options.toolCallId,
        toolName: options.toolName,
        sourceStatus,
        omittedChars: options.omittedChars,
      },
    };
  }
  return {
    marker: toolOutputArtifactFailedMarker(saveResult.reason),
    omittedChars: options.omittedChars,
    notice: {
      status: "failed",
      reason: saveResult.reason,
      toolCallId: options.toolCallId,
      toolName: options.toolName,
      omittedChars: options.omittedChars,
    },
    report: {
      status: "failed",
      reason: saveResult.reason,
      toolCallId: options.toolCallId,
      toolName: options.toolName,
      sourceStatus,
      omittedChars: options.omittedChars,
    },
  };
}

export function compactStaleToolOutputs(
  messages: readonly Message[],
  toolOutputMaxChars: number,
): StaleToolOutputCompactionResult {
  const lastAssistantIndex = messages.findLastIndex(
    (message) => message.role === "assistant",
  );
  const needsCompaction = messages.some((message, index) =>
    shouldCompactStaleToolOutput(
      message,
      index,
      lastAssistantIndex,
      toolOutputMaxChars,
    ),
  );
  if (!needsCompaction) {
    return {
      messages,
      stats: EMPTY_STALE_TOOL_OUTPUT_COMPACTION_STATS,
    };
  }
  const compactedEntries = messages.map(
    (message, index): StaleToolOutputCompactionEntry => {
      if (
        message.role !== "tool" ||
        !shouldCompactStaleToolOutput(
          message,
          index,
          lastAssistantIndex,
          toolOutputMaxChars,
        )
      ) {
        return {
          message,
          stats: EMPTY_STALE_TOOL_OUTPUT_COMPACTION_STATS,
        };
      }
      const projection = projectCompactedToolOutput({
        text: message.content,
        maxChars: toolOutputMaxChars,
        context: toolContextForToolOutput(messages, message.toolCallId),
      });
      const compactedContent = compactStaleToolOutput(projection);
      return settleToolOutputCompactionAttempt(
        buildToolOutputCompactionAttempt({
          message,
          compactedContent,
          scope: "stale",
        }),
      );
    },
  );
  const stats = compactedEntries.reduce(
    (total, entry) => mergeStaleToolOutputCompactionStats(total, entry.stats),
    EMPTY_STALE_TOOL_OUTPUT_COMPACTION_STATS,
  );
  const compactedMessages = compactedEntries.map((entry) => entry.message);
  return {
    messages: compactedMessages,
    stats,
  };
}

export async function compactStaleToolOutputsWithArtifacts(
  messages: readonly Message[],
  toolOutputMaxChars: number,
  store: ToolOutputArtifactStore,
): Promise<StaleToolOutputCompactionResult> {
  const lastAssistantIndex = messages.findLastIndex(
    (message) => message.role === "assistant",
  );
  const needsCompaction = messages.some((message, index) =>
    shouldCompactStaleToolOutput(
      message,
      index,
      lastAssistantIndex,
      toolOutputMaxChars,
    ),
  );
  if (!needsCompaction) {
    return {
      messages,
      stats: EMPTY_STALE_TOOL_OUTPUT_COMPACTION_STATS,
    };
  }
  const compactedEntries = await Promise.all(
    messages.map(
      async (message, index): Promise<StaleToolOutputCompactionEntry> => {
        if (
          message.role !== "tool" ||
          !shouldCompactStaleToolOutput(
            message,
            index,
            lastAssistantIndex,
            toolOutputMaxChars,
          )
        ) {
          return {
            message,
            stats: EMPTY_STALE_TOOL_OUTPUT_COMPACTION_STATS,
          };
        }
        const context = toolContextForToolOutput(messages, message.toolCallId);
        const projection = projectCompactedToolOutput({
          text: message.content,
          maxChars: toolOutputMaxChars,
          context,
        });
        const artifact = await artifactMarkerForCompactedToolOutput({
          store,
          message,
          toolCallId: message.toolCallId,
          toolName: artifactToolNameForContext(context),
          content: message.content,
          omittedChars: projection.omittedChars,
          purpose: "stale-compaction",
        });
        const compactedContent = compactStaleToolOutput(
          projection,
          artifact.marker,
        );
        return await settleArtifactToolOutputCompactionAttempt(
          buildToolOutputCompactionAttempt({
            message,
            compactedContent,
            scope: "stale",
            ...(artifact.notice === undefined
              ? {}
              : { artifactNotice: artifact.notice }),
            artifactReport: artifact.report,
          }),
          store,
        );
      },
    ),
  );
  const stats = compactedEntries.reduce(
    (total, entry) => mergeStaleToolOutputCompactionStats(total, entry.stats),
    EMPTY_STALE_TOOL_OUTPUT_COMPACTION_STATS,
  );
  const compactedMessages = compactedEntries.map((entry) => entry.message);
  const artifactNotices = compactedEntries.flatMap((entry) =>
    entry.artifactNotice === undefined ? [] : [entry.artifactNotice],
  );
  const artifactReports = compactedEntries.flatMap((entry) =>
    entry.artifactReport === undefined ? [] : [entry.artifactReport],
  );
  return {
    messages: compactedMessages,
    stats,
    artifactReports,
    ...(artifactNotices.length === 0 ? {} : { artifactNotices }),
  };
}

export function compactCurrentToolOutputs(
  messages: readonly Message[],
  toolOutputMaxChars: number,
  options?: CurrentToolOutputCompactionOptions,
): StaleToolOutputCompactionResult {
  const reason = options?.reason ?? "overflow_recovery";
  const settledMaxChars = options?.settledMaxChars ?? toolOutputMaxChars;
  const allowPreflightRecompaction =
    options?.allowPreflightRecompaction === true;
  const currentToolOutputIndexes = new Set(
    currentToolRound(messages)?.toolOutputs.map(
      (toolOutput) => toolOutput.messageIndex,
    ) ?? [],
  );
  const needsCompaction = messages.some((message, index) =>
    shouldCompactCurrentToolOutput(
      message,
      index,
      currentToolOutputIndexes,
      toolOutputMaxChars,
      settledMaxChars,
      reason,
      allowPreflightRecompaction,
    ),
  );
  if (!needsCompaction) {
    return {
      messages,
      stats: EMPTY_STALE_TOOL_OUTPUT_COMPACTION_STATS,
    };
  }

  const compactedEntries = messages.map(
    (message, index): StaleToolOutputCompactionEntry => {
      if (
        message.role !== "tool" ||
        !shouldCompactCurrentToolOutput(
          message,
          index,
          currentToolOutputIndexes,
          toolOutputMaxChars,
          settledMaxChars,
          reason,
          allowPreflightRecompaction,
        )
      ) {
        return {
          message,
          stats: EMPTY_STALE_TOOL_OUTPUT_COMPACTION_STATS,
        };
      }
      const projection = projectCompactedToolOutput({
        text: message.content,
        maxChars: toolOutputMaxChars,
        context: toolContextForToolOutput(messages, message.toolCallId),
      });
      const compactedContent = compactCurrentToolOutput(
        projection,
        undefined,
        reason,
        omittedCharsForCurrentOutputRecompaction(
          message.content,
          projection.omittedChars,
        ),
      );
      return settleToolOutputCompactionAttempt(
        buildToolOutputCompactionAttempt({
          message,
          compactedContent,
          scope: "current",
        }),
      );
    },
  );
  const stats = compactedEntries.reduce(
    (total, entry) => mergeStaleToolOutputCompactionStats(total, entry.stats),
    EMPTY_STALE_TOOL_OUTPUT_COMPACTION_STATS,
  );
  const compactedMessages = compactedEntries.map((entry) => entry.message);
  return {
    messages: compactedMessages,
    stats,
  };
}

export async function compactCurrentToolOutputsWithArtifacts(
  messages: readonly Message[],
  toolOutputMaxChars: number,
  store: ToolOutputArtifactStore,
  options?: CurrentToolOutputCompactionOptions,
): Promise<StaleToolOutputCompactionResult> {
  const reason = options?.reason ?? "overflow_recovery";
  const settledMaxChars = options?.settledMaxChars ?? toolOutputMaxChars;
  const allowPreflightRecompaction =
    options?.allowPreflightRecompaction === true;
  const currentToolOutputIndexes = new Set(
    currentToolRound(messages)?.toolOutputs.map(
      (toolOutput) => toolOutput.messageIndex,
    ) ?? [],
  );
  const needsCompaction = messages.some((message, index) =>
    shouldCompactCurrentToolOutput(
      message,
      index,
      currentToolOutputIndexes,
      toolOutputMaxChars,
      settledMaxChars,
      reason,
      allowPreflightRecompaction,
    ),
  );
  if (!needsCompaction) {
    return {
      messages,
      stats: EMPTY_STALE_TOOL_OUTPUT_COMPACTION_STATS,
    };
  }

  const compactedEntries = await Promise.all(
    messages.map(
      async (message, index): Promise<StaleToolOutputCompactionEntry> => {
        if (
          message.role !== "tool" ||
          !shouldCompactCurrentToolOutput(
            message,
            index,
            currentToolOutputIndexes,
            toolOutputMaxChars,
            settledMaxChars,
            reason,
            allowPreflightRecompaction,
          )
        ) {
          return {
            message,
            stats: EMPTY_STALE_TOOL_OUTPUT_COMPACTION_STATS,
          };
        }
        const context = toolContextForToolOutput(messages, message.toolCallId);
        const projection = projectCompactedToolOutput({
          text: message.content,
          maxChars: toolOutputMaxChars,
          context,
        });
        const artifact = await artifactMarkerForCompactedToolOutput({
          store,
          message,
          toolCallId: message.toolCallId,
          toolName: artifactToolNameForContext(context),
          content: message.content,
          omittedChars: projection.omittedChars,
          purpose:
            reason === "preflight"
              ? "current-preflight-compaction"
              : "current-overflow-compaction",
        });
        const compactedContent = compactCurrentToolOutput(
          projection,
          artifact.marker,
          reason,
          artifact.omittedChars,
        );
        return await settleArtifactToolOutputCompactionAttempt(
          buildToolOutputCompactionAttempt({
            message,
            compactedContent,
            scope: "current",
            ...(artifact.notice === undefined
              ? {}
              : { artifactNotice: artifact.notice }),
            artifactReport: artifact.report,
          }),
          store,
        );
      },
    ),
  );
  const stats = compactedEntries.reduce(
    (total, entry) => mergeStaleToolOutputCompactionStats(total, entry.stats),
    EMPTY_STALE_TOOL_OUTPUT_COMPACTION_STATS,
  );
  const compactedMessages = compactedEntries.map((entry) => entry.message);
  const artifactNotices = compactedEntries.flatMap((entry) =>
    entry.artifactNotice === undefined ? [] : [entry.artifactNotice],
  );
  const artifactReports = compactedEntries.flatMap((entry) =>
    entry.artifactReport === undefined ? [] : [entry.artifactReport],
  );
  return {
    messages: compactedMessages,
    stats,
    artifactReports,
    ...(artifactNotices.length === 0 ? {} : { artifactNotices }),
  };
}
