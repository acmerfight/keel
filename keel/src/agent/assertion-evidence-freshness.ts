import type { Message, ToolCall } from "../llm/types.ts";
import {
  type ReadResourceFreshnessStatus,
  revalidateReadResource,
} from "../tools/read-resource-observation.ts";
import { isMcpToolInvocation } from "../tools/tool-call.ts";
import { isCompactionTruncatedToolOutput } from "./context-compaction.ts";

type ReadToolCall = Extract<ToolCall, { readonly tool: "read" }>;

export interface AssertionEvidenceResourceFreshness {
  readonly toolCallId: string;
  readonly kind: "read_projection";
  readonly status: ReadResourceFreshnessStatus;
  readonly reason: string;
}

function readToolCallsById(
  messages: readonly Message[],
): ReadonlyMap<string, ReadToolCall> {
  const reads = new Map<string, ReadToolCall>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const toolCall of message.toolCalls) {
      if (!isMcpToolInvocation(toolCall) && toolCall.tool === "read") {
        reads.set(toolCall.id, toolCall);
      }
    }
  }
  return reads;
}

export function assertionEvidenceResourceFreshness(input: {
  readonly workspace: string;
  readonly messages: readonly Message[];
}): readonly AssertionEvidenceResourceFreshness[] {
  const reads = readToolCallsById(input.messages);
  const freshness: AssertionEvidenceResourceFreshness[] = [];
  for (const message of input.messages) {
    if (message.role !== "tool") continue;
    const toolCall = reads.get(message.toolCallId);
    if (toolCall === undefined) continue;
    if (message.resourceObservation === undefined) {
      freshness.push({
        toolCallId: message.toolCallId,
        kind: "read_projection",
        status: "unverifiable",
        reason:
          "Runtime has no resource observation for this historical read result.",
      });
      continue;
    }
    const current = revalidateReadResource({
      workspace: input.workspace,
      toolCall,
      observation: message.resourceObservation,
    });
    if (
      current.status === "matches" &&
      isCompactionTruncatedToolOutput(message.content)
    ) {
      freshness.push({
        toolCallId: message.toolCallId,
        kind: "read_projection",
        status: "unverifiable",
        reason:
          "Context compaction removed part of this read projection, so Runtime cannot confirm the surfaced evidence is still current.",
      });
      continue;
    }
    freshness.push({
      toolCallId: message.toolCallId,
      kind: "read_projection",
      status: current.status,
      reason: current.reason,
    });
  }
  return freshness;
}
