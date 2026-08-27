import type { ContextCompactionStats } from "../agent/context-compaction.ts";
import type { AgentEvent } from "../agent/events.ts";
import type { ToolOutputArtifactNotice } from "../agent/tool-output-artifacts.ts";
import type { AgentMemoryOperation } from "../tools/memory.ts";
import { sanitizeToolLabel } from "./terminal-text.ts";

export function formatMemoryOperation(operation: AgentMemoryOperation): string {
  if (operation.operation === "add") {
    return `Saved project memory ${operation.id} for ${operation.scope.id}.`;
  }
  if (operation.operation === "forget") {
    return `Forgot project memory ${operation.id} for ${operation.scope.id}.`;
  }
  if (operation.outcome === "approved") {
    return `Approved project-memory candidate ${operation.candidateId} as ${operation.memoryId} for ${operation.scope.id}.`;
  }
  if (operation.outcome === "rejected") {
    return `Rejected project-memory candidate ${operation.candidateId} for ${operation.scope.id}.`;
  }
  return `Project-memory candidate ${operation.candidateId} remains pending for ${operation.scope.id}. Review it with: keel memory candidates show ${operation.candidateId}; approve with: keel memory candidates approve ${operation.candidateId} (add --keep or --supersede <memory-id> when required).`;
}

const providerRetryReasonLabels: Readonly<Record<string, string>> = {
  provider_rate_limited: "rate limited",
  provider_server_error: "server error",
  provider_network_error: "network error",
  provider_protocol_error: "stream interrupted",
  provider_http_error: "HTTP error",
  first_response_timeout: "response timeout",
  stream_inactivity_timeout: "stream inactivity timeout",
};

export function providerRetryReasonLabel(reason: string): string {
  return providerRetryReasonLabels[reason] ?? "provider error";
}

export function contextCompactionReasonLabel(
  reason: Extract<AgentEvent, { readonly type: "context_compacted" }>["reason"],
): string {
  switch (reason) {
    case "proactive":
      return "proactive";
    case "preflight":
      return "preflight";
    case "overflow_recovery":
      return "overflow recovery";
  }
}

function formatToolOutputCompactionCount(
  scope: "current" | "stale",
  count: number,
): string {
  const outputLabel = count === 1 ? "tool output" : "tool outputs";
  return `${scope} ${outputLabel} ${count}`;
}

function formatToolOutputCompactionDetails(
  event: ContextCompactionStats,
): string {
  if (event.toolOutputsCompacted === 0) {
    return "";
  }
  const scopeDetails = [
    ...(event.staleToolOutputsCompacted === 0
      ? []
      : [
          formatToolOutputCompactionCount(
            "stale",
            event.staleToolOutputsCompacted,
          ),
        ]),
    ...(event.currentToolOutputsCompacted === 0
      ? []
      : [
          formatToolOutputCompactionCount(
            "current",
            event.currentToolOutputsCompacted,
          ),
        ]),
  ].join(", ");
  return `, ${scopeDetails} (${event.toolOutputCharsBefore} -> ${event.toolOutputCharsAfter} chars, ~${event.toolOutputEstimatedTokensBefore} -> ~${event.toolOutputEstimatedTokensAfter} tokens)`;
}

export function formatContextCompactionReport(
  report: ContextCompactionStats & {
    readonly reasonLabel: string;
  },
): string {
  return `Context compacted: ${report.reasonLabel} (${report.beforeMessageCount} -> ${report.afterMessageCount} messages, ~${report.beforeEstimatedTokens} -> ~${report.afterEstimatedTokens} tokens${formatToolOutputCompactionDetails(report)})\n`;
}

export function formatToolOutputArtifactNotice(
  notice: ToolOutputArtifactNotice,
): string {
  if (notice.status === "stored") {
    return `Tool output artifact: ${sanitizeToolLabel(
      notice.ref,
    )} (keel artifacts show ${sanitizeToolLabel(notice.ref)})`;
  }
  return `Tool output artifact failed: ${sanitizeToolLabel(
    notice.reason,
  )}; output is lossy; rerun with narrower parameters if needed`;
}
