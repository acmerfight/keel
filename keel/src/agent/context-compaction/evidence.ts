import type {
  Message,
  ToolCall,
  UserMessageContextCompactionEvidence,
} from "../../llm/types.ts";
import { isMcpToolCall, toolCallLabel } from "../../tools/registry.ts";
import {
  generatedToolOutputArtifactMarker,
  sourceStatusFromToolOutputText,
  type ToolOutputArtifactStore,
} from "../tool-output-artifacts.ts";

export type CompactionEvidence = UserMessageContextCompactionEvidence;

const EVIDENCE_HEADING = "Evidence retained:";
const EVIDENCE_OMITTED_PREFIX = "... omitted from evidence list: ";
const FIELD_SEPARATOR = " | ";
const LABEL_MAX_CHARS = 220;
const WHY_MAX_CHARS = 220;
const ARTIFACT_STORAGE_FAILED_PATTERN =
  /artifact storage failed: ([^\];]+); lossy/u;

function oneLineField(text: string, maxChars: number): string {
  const normalized = text.trim().replace(/\s+/gu, " ").replaceAll("|", "/");
  return normalized.length <= maxChars
    ? normalized
    : `${normalized.slice(0, Math.max(0, maxChars - 3))}...`;
}

function toolCallsById(
  messages: readonly Message[],
): ReadonlyMap<string, ToolCall> {
  const toolCalls = new Map<string, ToolCall>();
  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }
    for (const toolCall of message.toolCalls) {
      toolCalls.set(toolCall.id, toolCall);
    }
  }
  return toolCalls;
}

function sourceHandleForToolCall(toolCall: ToolCall): string | null {
  if (isMcpToolCall(toolCall)) return null;
  switch (toolCall.tool) {
    case "read": {
      const windowParts: string[] = [];
      if (toolCall.offset !== undefined) {
        windowParts.push(`offset=${toolCall.offset}`);
      }
      if (toolCall.limit !== undefined) {
        windowParts.push(`limit=${toolCall.limit}`);
      }
      return windowParts.length === 0
        ? `read:${toolCall.path}`
        : `read:${toolCall.path}@${windowParts.join(",")}`;
    }
    case "grep":
      return toolCall.path === undefined
        ? `grep:${toolCall.pattern}`
        : `grep:${toolCall.pattern} in ${toolCall.path}`;
    case "glob":
      return toolCall.path === undefined
        ? `glob:${toolCall.pattern}`
        : `glob:${toolCall.pattern} in ${toolCall.path}`;
    case "ls":
      return toolCall.path === undefined ? "ls:." : `ls:${toolCall.path}`;
    case "git_status":
      return toolCall.paths === undefined || toolCall.paths.length === 0
        ? "git_status:all changes"
        : `git_status:${toolCall.paths.join(" ")}`;
    case "git_diff": {
      const pathLabel =
        toolCall.paths === undefined || toolCall.paths.length === 0
          ? ""
          : ` ${toolCall.paths.join(" ")}`;
      if (toolCall.baseRef !== undefined) {
        const separator = toolCall.mergeBase === true ? "..." : "..";
        return `git_diff:${toolCall.baseRef}${separator}${
          toolCall.headRef ?? "HEAD"
        }${pathLabel}`;
      }
      return toolCall.paths === undefined || toolCall.paths.length === 0
        ? "git_diff:all changes"
        : `git_diff:${toolCall.paths.join(" ")}`;
    }
    case "update_plan":
    case "update_goal":
    case "memory_add":
    case "memory_forget":
    case "memory_propose":
    case "mcp_search":
    case "skill_resource":
    case "skill_search":
    case "skill":
    case "bash":
    case "edit":
    case "write":
    case "apply_patch":
      return null;
  }
}

function evidenceLabel(
  toolCall: ToolCall | undefined,
  toolCallId: string,
): string {
  return oneLineField(
    toolCall === undefined
      ? `tool call ${toolCallId}`
      : toolCallLabel(toolCall),
    LABEL_MAX_CHARS,
  );
}

function sourceStatusForEvidence(
  message: Extract<Message, { readonly role: "tool" }>,
): "complete" | "source-truncated" {
  if (message.sourceTruncated !== undefined) {
    return message.sourceTruncated ? "source-truncated" : "complete";
  }
  return sourceStatusFromToolOutputText(message.content);
}

function sourceStatusLabel(status: "complete" | "source-truncated"): string {
  return status === "complete"
    ? "complete"
    : "source-truncated/lossy before artifact capture";
}

function artifactStorageFailureReason(text: string): string | null {
  const match = ARTIFACT_STORAGE_FAILED_PATTERN.exec(text);
  return match?.[1] ?? null;
}

async function verifiedArtifactEvidence(options: {
  readonly message: Extract<Message, { readonly role: "tool" }>;
  readonly toolCall: ToolCall | undefined;
  readonly store: ToolOutputArtifactStore | undefined;
}): Promise<CompactionEvidence | null> {
  const artifact = generatedToolOutputArtifactMarker(options.message.content);
  if (artifact === null || options.store === undefined) {
    return null;
  }

  try {
    const verification = await options.store.verifyReusable({
      ref: artifact.ref,
      toolCallId: options.message.toolCallId,
      previewContent: options.message.content.slice(0, artifact.markerIndex),
      omittedChars: artifact.omittedChars,
      previewKind: artifact.previewKind,
      sourceStatus: artifact.sourceStatus,
      ...(artifact.contentSha256 === undefined
        ? {}
        : { contentSha256: artifact.contentSha256 }),
    });
    if (verification.status !== "reusable") {
      return null;
    }
    const label = evidenceLabel(options.toolCall, options.message.toolCallId);
    return {
      handle: artifact.ref,
      label,
      source: sourceStatusLabel(artifact.sourceStatus),
      inspectCommand: `keel artifacts show ${artifact.ref}`,
      why: oneLineField(
        artifact.sourceStatus === "complete"
          ? "full tool output is available after compaction"
          : "artifact is available, but the original producer output was already truncated before capture",
        WHY_MAX_CHARS,
      ),
    };
  } catch {
    return null;
  }
}

async function toolMessageEvidence(options: {
  readonly message: Extract<Message, { readonly role: "tool" }>;
  readonly toolCall: ToolCall | undefined;
  readonly toolOutputMaxChars: number;
  readonly store: ToolOutputArtifactStore | undefined;
}): Promise<CompactionEvidence | null> {
  const artifactEvidence = await verifiedArtifactEvidence(options);
  if (artifactEvidence !== null) {
    return artifactEvidence;
  }

  const label = evidenceLabel(options.toolCall, options.message.toolCallId);
  const failedReason = artifactStorageFailureReason(options.message.content);
  if (failedReason !== null) {
    return {
      handle: `tool-call:${options.message.toolCallId}`,
      label,
      source: "lossy artifact storage failure",
      why: oneLineField(
        `artifact storage failed: ${failedReason}; exact output is not recoverable after compaction`,
        WHY_MAX_CHARS,
      ),
    };
  }

  const sourceStatus = sourceStatusForEvidence(options.message);
  const summaryInputOmitted =
    options.message.content.length > options.toolOutputMaxChars;
  if (sourceStatus === "complete" && !summaryInputOmitted) {
    return null;
  }

  const sourceHandle =
    options.toolCall === undefined
      ? null
      : sourceHandleForToolCall(options.toolCall);
  return {
    handle: sourceHandle ?? `tool-call:${options.message.toolCallId}`,
    label,
    source: sourceStatusLabel(sourceStatus),
    why: oneLineField(
      sourceHandle === null
        ? "summary input omitted part of this tool output, and exact output must be rerun if needed"
        : "summary input omitted part of this tool output; rerun or narrow this source if exact detail matters",
      WHY_MAX_CHARS,
    ),
  };
}

export function collectToolCompactionEvidence(
  messages: readonly Message[],
  toolOutputMaxChars: number,
  store?: ToolOutputArtifactStore,
): Promise<readonly CompactionEvidence[]> {
  const toolCalls = toolCallsById(messages);
  return Promise.all(
    messages.map(async (message) => {
      if (message.role !== "tool") {
        return null;
      }
      return await toolMessageEvidence({
        message,
        toolCall: toolCalls.get(message.toolCallId),
        toolOutputMaxChars,
        store,
      });
    }),
  ).then((evidence) => evidence.filter((item) => item !== null));
}

export function mergeCompactionEvidence(
  ...sources: readonly (readonly CompactionEvidence[])[]
): readonly CompactionEvidence[] {
  const merged: CompactionEvidence[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    for (const evidence of source) {
      const key = [
        evidence.handle,
        evidence.label,
        evidence.source,
        evidence.inspectCommand ?? "",
      ].join("\u0000");
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(evidence);
    }
  }
  return merged;
}

function fieldPart(name: string, value: string): string {
  return `${name}: ${oneLineField(value, 300)}`;
}

function renderCompactionEvidenceLine(evidence: CompactionEvidence): string {
  return [
    `- ${oneLineField(evidence.handle, 180)}`,
    fieldPart("label", evidence.label),
    fieldPart("source", evidence.source),
    ...(evidence.inspectCommand === undefined
      ? []
      : [fieldPart("inspect", evidence.inspectCommand)]),
    fieldPart("why", evidence.why),
  ].join(FIELD_SEPARATOR);
}

function joinedEvidenceLines(lines: readonly string[]): string {
  return lines.join("\n");
}

function evidenceOmittedLine(count: number): string {
  return `${EVIDENCE_OMITTED_PREFIX}${count} older ${count === 1 ? "handle" : "handles"} to fit the compaction budget`;
}

function renderEvidenceLinesWithOmission(options: {
  readonly evidenceLines: readonly string[];
  readonly omittedCount: number;
}): string {
  return joinedEvidenceLines([
    EVIDENCE_HEADING,
    ...(options.omittedCount === 0
      ? []
      : [evidenceOmittedLine(options.omittedCount)]),
    ...options.evidenceLines,
  ]);
}

function renderBoundedCompactionEvidenceSection(
  evidenceLines: readonly string[],
  maxChars: number,
): string {
  if (maxChars <= 0) {
    return "";
  }

  const allLines = renderEvidenceLinesWithOmission({
    evidenceLines,
    omittedCount: 0,
  });
  if (allLines.length <= maxChars) {
    return allLines;
  }

  let selectedLines: readonly string[] = [];
  for (let index = evidenceLines.length - 1; index >= 0; index--) {
    const nextLines = evidenceLines.slice(index);
    const candidate = renderEvidenceLinesWithOmission({
      evidenceLines: nextLines,
      omittedCount: index,
    });
    if (candidate.length > maxChars) {
      break;
    }
    selectedLines = nextLines;
  }

  if (selectedLines.length > 0) {
    return renderEvidenceLinesWithOmission({
      evidenceLines: selectedLines,
      omittedCount: evidenceLines.length - selectedLines.length,
    });
  }

  const newestOnly = joinedEvidenceLines([
    EVIDENCE_HEADING,
    ...evidenceLines.slice(-1),
  ]);
  if (newestOnly.length <= maxChars) {
    return newestOnly;
  }

  const omittedOnly = joinedEvidenceLines([
    EVIDENCE_HEADING,
    evidenceOmittedLine(evidenceLines.length),
  ]);
  if (omittedOnly.length <= maxChars) {
    return omittedOnly;
  }

  return "";
}

export function renderCompactionEvidenceSection(
  evidence: readonly CompactionEvidence[],
  options?: { readonly maxChars?: number },
): string {
  const evidenceLines = evidence.map((item) =>
    renderCompactionEvidenceLine(item),
  );
  if (options?.maxChars !== undefined) {
    return renderBoundedCompactionEvidenceSection(
      evidenceLines,
      options.maxChars,
    );
  }
  return renderEvidenceLinesWithOmission({ evidenceLines, omittedCount: 0 });
}

function parsedField(
  parts: ReadonlyMap<string, string>,
  name: string,
): string | null {
  return parts.get(name) ?? null;
}

function parseCompactionEvidenceLine(line: string): CompactionEvidence | null {
  if (!line.startsWith("- ")) {
    return null;
  }
  const [rawHandle, ...rawParts] = line.slice(2).split(FIELD_SEPARATOR);
  if (rawHandle === undefined || rawHandle.trim() === "") {
    return null;
  }
  const parts = new Map<string, string>();
  for (const rawPart of rawParts) {
    const separatorIndex = rawPart.indexOf(": ");
    if (separatorIndex <= 0) {
      return null;
    }
    parts.set(
      rawPart.slice(0, separatorIndex),
      rawPart.slice(separatorIndex + 2),
    );
  }
  const label = parsedField(parts, "label");
  const source = parsedField(parts, "source");
  const why = parsedField(parts, "why");
  if (label === null || source === null || why === null) {
    return null;
  }
  const inspect = parsedField(parts, "inspect");
  return inspect === null
    ? { handle: rawHandle, label, source, why }
    : { handle: rawHandle, label, source, why, inspectCommand: inspect };
}

export function parseCompactionEvidenceSection(
  lines: readonly string[],
): readonly CompactionEvidence[] | null {
  if (lines.length === 0) {
    return [];
  }
  const [heading, ...evidenceLines] = lines;
  if (heading !== EVIDENCE_HEADING) {
    return null;
  }
  const evidence: CompactionEvidence[] = [];
  for (const line of evidenceLines) {
    if (line.startsWith(EVIDENCE_OMITTED_PREFIX)) {
      continue;
    }
    const parsed = parseCompactionEvidenceLine(line);
    if (parsed === null) {
      return null;
    }
    evidence.push(parsed);
  }
  return evidence;
}
