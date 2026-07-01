import type { ToolCall } from "../llm/types.ts";

export type ToolOutputArtifactSourceStatus = "complete" | "source-truncated";

export type ToolOutputArtifactPurpose =
  | "settlement"
  | "stale-compaction"
  | "current-overflow-compaction";

export interface ToolOutputArtifactSaveInput {
  readonly toolCallId: string;
  readonly toolName: ToolCall["tool"] | string;
  readonly content: string;
  readonly sourceStatus: ToolOutputArtifactSourceStatus;
  readonly purpose: ToolOutputArtifactPurpose;
}

export type ToolOutputArtifactSaveResult =
  | {
      readonly status: "stored";
      readonly ref: string;
    }
  | {
      readonly status: "failed";
      readonly reason: string;
    };

export interface ToolOutputArtifactStore {
  readonly save: (
    input: ToolOutputArtifactSaveInput,
  ) => Promise<ToolOutputArtifactSaveResult>;
}

export interface ToolOutputArtifactsOptions {
  readonly store: ToolOutputArtifactStore;
  readonly maxInlineChars?: number;
}

export type ToolOutputArtifactNotice =
  | {
      readonly status: "stored";
      readonly ref: string;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly sourceStatus: ToolOutputArtifactSourceStatus;
      readonly omittedChars: number;
    }
  | {
      readonly status: "failed";
      readonly reason: string;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly omittedChars: number;
    };

export interface ToolOutputArtifactSettlementResult {
  readonly content: string;
  readonly notice?: ToolOutputArtifactNotice;
}

const TOOL_OUTPUT_ARTIFACT_MARKER_PATTERN =
  /\[(?:tool output shortened|stale tool output compacted|current tool output compacted after context overflow): [^\]]*full output artifact: (tool-output:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+); inspect with: keel artifacts show \1; source status: (?:complete|source-truncated\/lossy before artifact capture)(?:; model recovery: rerun the tool with narrower parameters if needed)?\]/u;

function oneLineReason(reason: string): string {
  return reason.trim().replace(/\s+/gu, " ") || "unknown storage error";
}

export function isArtifactBackedToolOutput(text: string): boolean {
  return TOOL_OUTPUT_ARTIFACT_MARKER_PATTERN.test(text);
}

export function toolOutputArtifactStoredMarker(
  ref: string,
  sourceStatus: ToolOutputArtifactSourceStatus,
): string {
  const sourceStatusText =
    sourceStatus === "complete"
      ? "source status: complete"
      : "source status: source-truncated/lossy before artifact capture";
  return `full output artifact: ${ref}; inspect with: keel artifacts show ${ref}; ${sourceStatusText}`;
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
  readonly toolName: ToolCall["tool"] | string;
  readonly content: string;
  readonly sourceStatus: ToolOutputArtifactSourceStatus;
  readonly purpose: ToolOutputArtifactPurpose;
}): Promise<ToolOutputArtifactSettlementResult> {
  if (
    options.content.length <= options.maxInlineChars ||
    isArtifactBackedToolOutput(options.content)
  ) {
    return { content: options.content };
  }

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
    )}]`;
    return {
      content: `${preview}\n${marker}`,
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
    notice: {
      status: "failed",
      reason: saveResult.reason,
      toolCallId: options.toolCallId,
      toolName: options.toolName,
      omittedChars,
    },
  };
}
