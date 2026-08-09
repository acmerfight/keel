import type {
  AgentHistoryEntry,
  AgentTreeHistory,
} from "./agent-tree-store.ts";

export function resolveAgentHistoryEntry(
  history: AgentTreeHistory,
  selector: string,
): AgentHistoryEntry | null {
  const entries = history.entries();
  if (/^[1-9][0-9]*$/u.test(selector)) {
    return entries[Number(selector) - 1] ?? null;
  }
  return (
    entries.find(
      (entry) =>
        entry.childAgentId === selector ||
        entry.childRunId === selector ||
        entry.delegationId === selector,
    ) ?? null
  );
}

function formatCost(costUsd: number): string {
  return `$${costUsd.toFixed(6)}`;
}

export function formatAgentHistoryList(history: AgentTreeHistory): string {
  const entries = history.entries();
  return [
    `Agents for session: ${history.sessionId}`,
    ...(entries.length === 0
      ? ["No subagents recorded."]
      : entries.map(
          (entry) =>
            `${entry.index}. [${entry.status}] ${entry.task} (${entry.childAgentId})`,
        )),
    "",
  ].join("\n");
}

export function formatAgentHistoryDetail(entry: AgentHistoryEntry): string {
  const terminalText =
    entry.result === null
      ? "result: (not terminal)"
      : entry.result.status === "completed"
        ? `result: ${entry.result.finalText}`
        : `error: ${entry.result.error}`;
  return [
    `Agent ${entry.index}: ${entry.childAgentId}`,
    `status: ${entry.status}`,
    `task: ${entry.task}`,
    `run: ${entry.childRunId}`,
    `parent run: ${entry.parentRunId}`,
    `provider/model: ${entry.providerId}/${entry.model}`,
    `turns: ${entry.accounting.turns}`,
    `cost: ${formatCost(entry.accounting.costUsd)}`,
    `usage: input=${entry.accounting.usage.inputTokens} cached=${entry.accounting.usage.cachedInputTokens} output=${entry.accounting.usage.outputTokens}`,
    `transcript: ${entry.transcriptRef}`,
    terminalText,
    "",
  ].join("\n");
}

export function formatAgentTranscript(
  history: AgentTreeHistory,
  entry: AgentHistoryEntry,
): string {
  return [
    `Child transcript: ${entry.childAgentId}`,
    history.transcript(entry.childAgentId).trimEnd(),
    "",
  ].join("\n");
}
