import type { ToolCall } from "../llm/types.ts";

export const DEFAULT_TOOL_OUTPUT_ARTIFACT_MAX_INLINE_CHARS = 50_000;
export const DEFAULT_TOOL_OUTPUT_ARTIFACT_MAX_AGGREGATE_INLINE_CHARS = 200_000;
export const DEFAULT_TOOL_OUTPUT_ARTIFACT_AGGREGATE_PREVIEW_CHARS = 10_000;
export const TOOL_OUTPUT_ARTIFACT_MODEL_RECOVERY =
  "model recovery: rerun the tool with narrower parameters if needed";

export type ToolOutputArtifactSourceStatus = "complete" | "source-truncated";
export type ToolOutputArtifactToolName = ToolCall["tool"] | "unknown";
type ToolOutputArtifactPreviewKind = "prefix" | "projection";

export function sourceStatusFromToolOutputText(
  content: string,
): ToolOutputArtifactSourceStatus {
  // Current-schema fallback for tool messages without structured sourceTruncated
  // metadata. Keep in sync with active truncation markers; this is not a
  // legacy-format reader.
  return content.includes("source-truncated/lossy") ||
    content.includes(" output truncated:") ||
    content.includes("[Read output truncated at ") ||
    content.includes("[Read output stopped at ") ||
    content.includes("[bash stdout truncated:") ||
    content.includes("[bash stderr truncated:") ||
    content.includes("[git_diff stdout truncated:") ||
    content.includes("[git_diff stderr truncated:")
    ? "source-truncated"
    : "complete";
}

export function toolMessageSourceTruncationMetadata(input: {
  readonly content: string;
  readonly sourceTruncated: boolean;
}): { readonly sourceTruncated?: boolean } {
  if (input.sourceTruncated) {
    return { sourceTruncated: true };
  }
  return sourceStatusFromToolOutputText(input.content) === "source-truncated"
    ? { sourceTruncated: false }
    : {};
}

export type ToolOutputArtifactPurpose =
  | "settlement"
  | "stale-compaction"
  | "current-overflow-compaction";

export interface ToolOutputArtifactSaveInput {
  readonly toolCallId: string;
  readonly toolName: ToolOutputArtifactToolName;
  readonly content: string;
  readonly sourceStatus: ToolOutputArtifactSourceStatus;
  readonly purpose: ToolOutputArtifactPurpose;
}

export type ToolOutputArtifactSaveResult =
  | {
      readonly status: "stored";
      readonly ref: string;
      readonly contentSha256: string;
    }
  | {
      readonly status: "failed";
      readonly reason: string;
    };

export interface ToolOutputArtifactReuseInput {
  readonly ref: string;
  readonly toolCallId: string;
  readonly previewContent: string;
  readonly omittedChars: number;
  readonly previewKind: ToolOutputArtifactPreviewKind;
  readonly sourceStatus: ToolOutputArtifactSourceStatus;
  readonly contentSha256?: string;
}

export type ToolOutputArtifactReuseResult =
  | {
      readonly status: "reusable";
      readonly contentSha256: string;
    }
  | {
      readonly status: "not_reusable";
    };

export interface ToolOutputArtifactStore {
  readonly verifyReusable: (
    input: ToolOutputArtifactReuseInput,
  ) => Promise<ToolOutputArtifactReuseResult>;
  readonly save: (
    input: ToolOutputArtifactSaveInput,
  ) => Promise<ToolOutputArtifactSaveResult>;
}

export interface ToolOutputArtifactsOptions {
  readonly store: ToolOutputArtifactStore;
  readonly maxInlineChars?: number;
  readonly maxAggregateInlineChars?: number;
  readonly aggregatePreviewChars?: number;
}

export type ToolOutputArtifactNotice =
  | {
      readonly status: "stored";
      readonly ref: string;
      readonly toolCallId: string;
      readonly toolName: ToolOutputArtifactToolName;
      readonly sourceStatus: ToolOutputArtifactSourceStatus;
      readonly omittedChars: number;
    }
  | {
      readonly status: "failed";
      readonly reason: string;
      readonly toolCallId: string;
      readonly toolName: ToolOutputArtifactToolName;
      readonly omittedChars: number;
    };

export interface ToolOutputArtifactSettlementResult {
  readonly content: string;
  readonly notice: ToolOutputArtifactNotice;
  readonly sourceTruncated: boolean;
}

export interface GeneratedToolOutputArtifactMarker {
  readonly ref: string;
  readonly marker: string;
  readonly markerIndex: number;
  readonly omittedChars: number;
  readonly previewKind: ToolOutputArtifactPreviewKind;
  readonly sourceStatus: ToolOutputArtifactSourceStatus;
  readonly contentSha256?: string;
}

const TOOL_OUTPUT_ARTIFACT_MARKER_SUFFIX_PATTERN =
  /\n\[(tool output shortened|tool output projected|stale tool output compacted|current tool output compacted after context overflow): (?:approximately )?omitted ([0-9]+) chars; full output artifact: (tool-output:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+); inspect with: keel artifacts show \3(?:; sha256: ([a-f0-9]{64}))?; source status: (complete|source-truncated\/lossy before artifact capture)(?:; model recovery: rerun the tool with narrower parameters if needed)?\]$/u;
const TOOL_OUTPUT_ARTIFACT_FAILED_MARKER_SUFFIX_PATTERN =
  /\n\[(?:tool output shortened|tool output projected|stale tool output compacted|current tool output compacted after context overflow): [^\]]*artifact storage failed: .*; lossy; rerun the tool with narrower parameters if needed(?:; model recovery: rerun the tool with narrower parameters if needed)?\]$/u;

function oneLineReason(reason: string): string {
  return reason.trim().replace(/\s+/gu, " ") || "unknown storage error";
}

function isGeneratedArtifactBackedToolOutput(
  text: string,
  maxInlineChars: number,
): boolean {
  const marker = generatedToolOutputArtifactMarker(text);
  return marker !== null && marker.markerIndex <= maxInlineChars;
}

export function isGeneratedSettledToolOutput(
  text: string,
  maxInlineChars: number,
): boolean {
  if (isGeneratedArtifactBackedToolOutput(text, maxInlineChars)) {
    return true;
  }
  const failedMarker =
    TOOL_OUTPUT_ARTIFACT_FAILED_MARKER_SUFFIX_PATTERN.exec(text);
  return failedMarker !== null && failedMarker.index <= maxInlineChars;
}

export function toolOutputArtifactStoredMarker(
  ref: string,
  sourceStatus: ToolOutputArtifactSourceStatus,
  contentSha256?: string,
): string {
  const sourceStatusText =
    sourceStatus === "complete"
      ? "source status: complete"
      : "source status: source-truncated/lossy before artifact capture";
  const sha256Text =
    contentSha256 === undefined ? "" : `; sha256: ${contentSha256}`;
  return `full output artifact: ${ref}; inspect with: keel artifacts show ${ref}${sha256Text}; ${sourceStatusText}; ${TOOL_OUTPUT_ARTIFACT_MODEL_RECOVERY}`;
}

export function generatedToolOutputArtifactMarker(
  text: string,
): GeneratedToolOutputArtifactMarker | null {
  const marker = TOOL_OUTPUT_ARTIFACT_MARKER_SUFFIX_PATTERN.exec(text);
  if (marker === null) {
    return null;
  }
  const [
    ,
    rawMarkerKind = "",
    rawOmittedChars = "",
    ref = "",
    contentSha256,
    rawSourceStatus,
  ] = marker;
  const omittedChars = Number(rawOmittedChars);
  if (!Number.isSafeInteger(omittedChars)) {
    return null;
  }
  const previewKind =
    rawMarkerKind === "tool output shortened" ? "prefix" : "projection";
  const sourceStatus =
    rawSourceStatus === "complete" ? "complete" : "source-truncated";
  return {
    ref,
    marker: toolOutputArtifactStoredMarker(ref, sourceStatus, contentSha256),
    markerIndex: marker.index,
    omittedChars,
    previewKind,
    sourceStatus,
    ...(contentSha256 === undefined ? {} : { contentSha256 }),
  };
}

export function toolOutputArtifactFailedMarker(reason: string): string {
  return `artifact storage failed: ${oneLineReason(
    reason,
  )}; lossy; rerun the tool with narrower parameters if needed`;
}

export async function settleOversizedToolOutput(options: {
  readonly store: ToolOutputArtifactStore;
  readonly maxInlineChars: number;
  readonly toolCallId: string;
  readonly toolName: ToolOutputArtifactToolName;
  readonly content: string;
  readonly sourceStatus: ToolOutputArtifactSourceStatus;
  readonly purpose: ToolOutputArtifactPurpose;
}): Promise<ToolOutputArtifactSettlementResult> {
  const saveResult = await options.store.save({
    toolCallId: options.toolCallId,
    toolName: options.toolName,
    content: options.content,
    sourceStatus: options.sourceStatus,
    purpose: options.purpose,
  });
  const omittedChars = options.content.length - options.maxInlineChars;
  const preview = options.content.slice(0, options.maxInlineChars);
  if (saveResult.status === "stored") {
    const marker = `[tool output shortened: omitted ${omittedChars} chars; ${toolOutputArtifactStoredMarker(
      saveResult.ref,
      options.sourceStatus,
      saveResult.contentSha256,
    )}]`;
    return {
      content: `${preview}\n${marker}`,
      sourceTruncated: options.sourceStatus === "source-truncated",
      notice: {
        status: "stored",
        ref: saveResult.ref,
        toolCallId: options.toolCallId,
        toolName: options.toolName,
        sourceStatus: options.sourceStatus,
        omittedChars,
      },
    };
  }
  const marker = `[tool output shortened: omitted ${omittedChars} chars; ${toolOutputArtifactFailedMarker(
    saveResult.reason,
  )}]`;
  return {
    content: `${preview}\n${marker}`,
    sourceTruncated: true,
    notice: {
      status: "failed",
      reason: saveResult.reason,
      toolCallId: options.toolCallId,
      toolName: options.toolName,
      omittedChars,
    },
  };
}

export async function settleProjectedToolOutput(options: {
  readonly store: ToolOutputArtifactStore;
  readonly toolCallId: string;
  readonly toolName: ToolOutputArtifactToolName;
  readonly previewContent: string;
  readonly artifactContent: string;
  readonly sourceStatus: ToolOutputArtifactSourceStatus;
  readonly purpose: ToolOutputArtifactPurpose;
}): Promise<ToolOutputArtifactSettlementResult> {
  const saveResult = await options.store.save({
    toolCallId: options.toolCallId,
    toolName: options.toolName,
    content: options.artifactContent,
    sourceStatus: options.sourceStatus,
    purpose: options.purpose,
  });
  const omittedChars = Math.max(
    0,
    options.artifactContent.length - options.previewContent.length,
  );
  if (saveResult.status === "stored") {
    const marker = `[tool output projected: omitted ${omittedChars} chars; ${toolOutputArtifactStoredMarker(
      saveResult.ref,
      options.sourceStatus,
      saveResult.contentSha256,
    )}]`;
    return {
      content: `${options.previewContent}\n${marker}`,
      sourceTruncated: options.sourceStatus === "source-truncated",
      notice: {
        status: "stored",
        ref: saveResult.ref,
        toolCallId: options.toolCallId,
        toolName: options.toolName,
        sourceStatus: options.sourceStatus,
        omittedChars,
      },
    };
  }
  const marker = `[tool output projected: omitted ${omittedChars} chars; ${toolOutputArtifactFailedMarker(
    saveResult.reason,
  )}]`;
  return {
    content: `${options.previewContent}\n${marker}`,
    sourceTruncated: true,
    notice: {
      status: "failed",
      reason: saveResult.reason,
      toolCallId: options.toolCallId,
      toolName: options.toolName,
      omittedChars,
    },
  };
}
