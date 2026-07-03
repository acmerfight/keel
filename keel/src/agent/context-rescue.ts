import { errorMessage, KeelError } from "../core/error.ts";
import type { Message } from "../llm/types.ts";
import {
  type ContextCompactionOptions,
  type ContextCompactionRequestMetadata,
  contextCompactionTokenBudget,
  estimateContextMessageTokens,
  estimateContextRequestTokens,
  estimateContextTextTokens,
} from "./context-compaction.ts";
import {
  generatedFailedToolOutputArtifactMarker,
  generatedToolOutputArtifactMarker,
  sourceStatusFromToolOutputText,
  type ToolOutputArtifactSourceStatus,
  type ToolOutputArtifactsOptions,
  type ToolOutputArtifactToolName,
} from "./tool-output-artifacts.ts";

export type ContextRescueReason =
  | "no_safe_compaction_split"
  | "summary_request_overflow"
  | "overflow_recovery_failed"
  | "model_switch_target_overflow";

interface ContextRescueTopConsumer {
  readonly label: string;
  readonly estimatedTokens: number;
  readonly chars: number;
}

interface ContextRescueArtifactRef {
  readonly ref: string;
  readonly inspectCommand: string;
  readonly sourceStatus: ToolOutputArtifactSourceStatus;
  readonly toolCallId?: string;
  readonly toolName: ToolOutputArtifactToolName;
}

interface ContextRescueUnverifiedArtifactMarker {
  readonly ref: string;
  readonly inspectCommand: string;
  readonly sourceStatus: ToolOutputArtifactSourceStatus;
  readonly reason: string;
  readonly toolCallId?: string;
  readonly toolName: ToolOutputArtifactToolName;
}

interface ContextRescueLossyState {
  readonly label: string;
  readonly reason: string;
  readonly toolCallId?: string;
  readonly toolName: ToolOutputArtifactToolName;
}

interface ContextRescueRecentState {
  readonly label: string;
  readonly preview: string;
  readonly chars: number;
  readonly truncated: boolean;
}

export interface ContextRescueReport {
  readonly reason: ContextRescueReason;
  readonly reasonDetail: string;
  readonly estimatedTokens: number;
  readonly contextWindowTokens?: number;
  readonly reserveTokens: number;
  readonly targetTokens?: number;
  readonly overageTokens?: number;
  readonly messageCount: number;
  readonly topConsumers: readonly ContextRescueTopConsumer[];
  readonly artifactRefs: readonly ContextRescueArtifactRef[];
  readonly unverifiedArtifactMarkers: readonly ContextRescueUnverifiedArtifactMarker[];
  readonly lossyStates: readonly ContextRescueLossyState[];
  readonly recentState: readonly ContextRescueRecentState[];
  readonly nextSteps: readonly string[];
}

export function isProviderContextOverflowError(error: unknown): boolean {
  return (
    error instanceof KeelError && error.code === "provider_context_overflow"
  );
}

export function contextRescueReasonDetail(error: unknown): string {
  return errorMessage(error);
}

function toolNamesByCallId(
  messages: readonly Message[],
): ReadonlyMap<string, ToolOutputArtifactToolName> {
  const names = new Map<string, ToolOutputArtifactToolName>();
  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }
    for (const toolCall of message.toolCalls) {
      names.set(toolCall.id, toolCall.tool);
    }
  }
  return names;
}

function toolNameFor(
  toolNames: ReadonlyMap<string, ToolOutputArtifactToolName>,
  toolCallId: string,
): ToolOutputArtifactToolName {
  return toolNames.get(toolCallId) ?? "unknown";
}

function roleLabel(role: Message["role"], count: number): string {
  switch (role) {
    case "user":
      return `user message ${count}`;
    case "assistant":
      return `assistant message ${count}`;
    case "tool":
      return `tool output ${count}`;
  }
}

const RECENT_STATE_PREVIEW_CHARS = 240;

function previewText(text: string): {
  readonly preview: string;
  readonly truncated: boolean;
} {
  const oneLine = text.trim().replace(/\s+/gu, " ");
  if (oneLine.length <= RECENT_STATE_PREVIEW_CHARS) {
    return { preview: oneLine, truncated: false };
  }
  return {
    preview: `${oneLine.slice(0, RECENT_STATE_PREVIEW_CHARS)}...`,
    truncated: true,
  };
}

function assistantStatePreview(
  message: Extract<Message, { role: "assistant" }>,
): {
  readonly preview: string;
  readonly truncated: boolean;
} {
  if (message.content.trim() !== "") {
    return previewText(message.content);
  }
  const toolNames = message.toolCalls.map((toolCall) => toolCall.tool);
  return {
    preview:
      toolNames.length === 0
        ? "empty assistant response"
        : `requested ${toolNames.length} tool call(s): ${toolNames.join(", ")}`,
    truncated: false,
  };
}

function recentState(
  messages: readonly Message[],
): readonly ContextRescueRecentState[] {
  const latestUser = messages.findLast((message) => message.role === "user");
  const latestAssistant = messages.findLast(
    (message) => message.role === "assistant",
  );
  const latestTool = messages.findLast((message) => message.role === "tool");
  const states: ContextRescueRecentState[] = [];
  if (latestUser !== undefined) {
    const preview = previewText(latestUser.content);
    states.push({
      label: "latest user message",
      preview: preview.preview,
      chars: latestUser.content.length,
      truncated: preview.truncated,
    });
  }
  if (latestAssistant !== undefined) {
    const preview = assistantStatePreview(latestAssistant);
    states.push({
      label: "latest assistant state",
      preview: preview.preview,
      chars: latestAssistant.content.length,
      truncated: preview.truncated,
    });
  }
  if (latestTool !== undefined) {
    const preview = previewText(latestTool.content);
    states.push({
      label: `latest tool output ${latestTool.toolCallId}`,
      preview: preview.preview,
      chars: latestTool.content.length,
      truncated: preview.truncated,
    });
  }
  return states;
}

function topConsumers(
  systemPrompt: string,
  messages: readonly Message[],
  toolNames: ReadonlyMap<string, ToolOutputArtifactToolName>,
): readonly ContextRescueTopConsumer[] {
  const consumers: ContextRescueTopConsumer[] = [];
  if (systemPrompt !== "") {
    consumers.push({
      label: "system prompt",
      estimatedTokens: estimateContextTextTokens(systemPrompt),
      chars: systemPrompt.length,
    });
  }

  let userCount = 0;
  let assistantCount = 0;
  let toolCount = 0;
  for (const message of messages) {
    const roleCount =
      message.role === "user"
        ? ++userCount
        : message.role === "assistant"
          ? ++assistantCount
          : ++toolCount;
    const baseLabel = roleLabel(message.role, roleCount);
    const label =
      message.role === "tool"
        ? `${baseLabel} ${message.toolCallId} (${toolNameFor(
            toolNames,
            message.toolCallId,
          )})`
        : baseLabel;
    consumers.push({
      label,
      estimatedTokens: estimateContextMessageTokens(message),
      chars: message.content.length,
    });
  }

  return consumers
    .filter((consumer) => consumer.estimatedTokens > 0)
    .sort(
      (left, right) =>
        right.estimatedTokens - left.estimatedTokens ||
        Number(left.label > right.label) - Number(left.label < right.label),
    )
    .slice(0, 5);
}

function pushUniqueLossyState(
  states: ContextRescueLossyState[],
  state: ContextRescueLossyState,
): void {
  if (
    states.some(
      (current) =>
        current.label === state.label &&
        current.reason === state.reason &&
        current.toolCallId === state.toolCallId,
    )
  ) {
    return;
  }
  states.push(state);
}

function artifactVerificationFailureReason(error: unknown): string {
  return `artifact verification failed: ${errorMessage(error)}`;
}

async function collectToolRecoveryState(
  messages: readonly Message[],
  toolNames: ReadonlyMap<string, ToolOutputArtifactToolName>,
  toolOutputArtifacts: ToolOutputArtifactsOptions | undefined,
): Promise<{
  readonly artifactRefs: readonly ContextRescueArtifactRef[];
  readonly unverifiedArtifactMarkers: readonly ContextRescueUnverifiedArtifactMarker[];
  readonly lossyStates: readonly ContextRescueLossyState[];
}> {
  const artifactRefs: ContextRescueArtifactRef[] = [];
  const unverifiedArtifactMarkers: ContextRescueUnverifiedArtifactMarker[] = [];
  const lossyStates: ContextRescueLossyState[] = [];
  for (const message of messages) {
    if (message.role !== "tool") {
      continue;
    }
    const toolName = toolNameFor(toolNames, message.toolCallId);
    const label = `tool output ${message.toolCallId} (${toolName})`;
    const storedMarker = generatedToolOutputArtifactMarker(message.content);
    if (storedMarker !== null) {
      const inspectCommand = `keel artifacts show ${storedMarker.ref}`;
      if (toolOutputArtifacts === undefined) {
        unverifiedArtifactMarkers.push({
          ref: storedMarker.ref,
          inspectCommand,
          sourceStatus: storedMarker.sourceStatus,
          reason: "artifact store unavailable for verification",
          toolCallId: message.toolCallId,
          toolName,
        });
      } else {
        const verification = await toolOutputArtifacts.store
          .verifyReusable({
            ref: storedMarker.ref,
            toolCallId: message.toolCallId,
            previewContent: message.content.slice(0, storedMarker.markerIndex),
            omittedChars: storedMarker.omittedChars,
            previewKind: storedMarker.previewKind,
            sourceStatus: storedMarker.sourceStatus,
            ...(storedMarker.contentSha256 !== undefined
              ? { contentSha256: storedMarker.contentSha256 }
              : {}),
          })
          .catch(
            (
              error,
            ): {
              readonly status: "verification_failed";
              readonly reason: string;
            } => ({
              status: "verification_failed",
              reason: artifactVerificationFailureReason(error),
            }),
          );
        if (verification.status === "reusable") {
          artifactRefs.push({
            ref: storedMarker.ref,
            inspectCommand,
            sourceStatus: storedMarker.sourceStatus,
            toolCallId: message.toolCallId,
            toolName,
          });
        } else {
          unverifiedArtifactMarkers.push({
            ref: storedMarker.ref,
            inspectCommand,
            sourceStatus: storedMarker.sourceStatus,
            reason:
              verification.status === "verification_failed"
                ? verification.reason
                : "artifact store did not verify this marker",
            toolCallId: message.toolCallId,
            toolName,
          });
        }
      }
      if (storedMarker.sourceStatus === "source-truncated") {
        pushUniqueLossyState(lossyStates, {
          label,
          reason: "source-truncated/lossy before artifact capture",
          toolCallId: message.toolCallId,
          toolName,
        });
      }
    }

    const failedMarker = generatedFailedToolOutputArtifactMarker(
      message.content,
    );
    if (failedMarker !== null) {
      pushUniqueLossyState(lossyStates, {
        label,
        reason: `artifact storage failed: ${failedMarker.reason}`,
        toolCallId: message.toolCallId,
        toolName,
      });
    }

    if (
      message.sourceTruncated === true ||
      sourceStatusFromToolOutputText(message.content) === "source-truncated"
    ) {
      pushUniqueLossyState(lossyStates, {
        label,
        reason: "source-truncated/lossy before artifact capture",
        toolCallId: message.toolCallId,
        toolName,
      });
    }
  }
  return { artifactRefs, unverifiedArtifactMarkers, lossyStates };
}

function rescueNextSteps(options: {
  readonly artifactRefs: readonly ContextRescueArtifactRef[];
  readonly unverifiedArtifactMarkers: readonly ContextRescueUnverifiedArtifactMarker[];
  readonly lossyStates: readonly ContextRescueLossyState[];
}): readonly string[] {
  return [
    ...(options.artifactRefs.length === 0
      ? []
      : [
          "Inspect the listed artifact refs with the shown keel artifacts show commands before continuing.",
        ]),
    ...(options.unverifiedArtifactMarkers.length === 0
      ? []
      : [
          "Do not rely on unverified artifact markers until the artifact store verifies them.",
        ]),
    ...(options.lossyStates.length === 0
      ? []
      : [
          "Rerun lossy tool outputs with narrower parameters if exact source output is needed.",
        ]),
    "Ask a narrower follow-up, split the task, or target a smaller file/range.",
    "Switch to a model with a larger context window if the full session must stay in one request.",
    "Start a fresh session from this rescue report when the current history is no longer useful.",
  ];
}

export async function buildContextRescueReport(options: {
  readonly reason: ContextRescueReason;
  readonly reasonDetail: string;
  readonly systemPrompt: string;
  readonly messages: readonly Message[];
  readonly contextCompaction?: ContextCompactionOptions | undefined;
  readonly requestMetadata?: ContextCompactionRequestMetadata | undefined;
  readonly toolOutputArtifacts?: ToolOutputArtifactsOptions | undefined;
}): Promise<ContextRescueReport> {
  const budget = contextCompactionTokenBudget(options.contextCompaction);
  const estimatedTokens = estimateContextRequestTokens(
    options.systemPrompt,
    options.messages,
    undefined,
    options.requestMetadata,
  );
  const toolNames = toolNamesByCallId(options.messages);
  const recoveryState = await collectToolRecoveryState(
    options.messages,
    toolNames,
    options.toolOutputArtifacts,
  );
  const overageTokens =
    budget.targetTokens === undefined
      ? undefined
      : Math.max(0, estimatedTokens - budget.targetTokens);
  return {
    reason: options.reason,
    reasonDetail: options.reasonDetail,
    estimatedTokens,
    ...budget,
    ...(overageTokens !== undefined ? { overageTokens } : {}),
    messageCount: options.messages.length,
    topConsumers: topConsumers(
      options.systemPrompt,
      options.messages,
      toolNames,
    ),
    artifactRefs: recoveryState.artifactRefs,
    unverifiedArtifactMarkers: recoveryState.unverifiedArtifactMarkers,
    lossyStates: recoveryState.lossyStates,
    recentState: recentState(options.messages),
    nextSteps: rescueNextSteps(recoveryState),
  };
}
