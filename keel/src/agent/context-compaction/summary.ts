import { KeelError } from "../../core/error.ts";
import type { LLMProvider, Message, Usage } from "../../llm/types.ts";
import {
  normalizeCheckpointSummary,
  renderConversationCheckpoint,
  serializeCheckpointMessageForSummaryPrompt,
} from "./checkpoint.ts";
import {
  MIN_SUMMARY_INPUT_MAX_CHARS,
  type ResolvedContextCompactionOptions,
} from "./options.ts";
import {
  compactStaleToolOutputs,
  type StaleToolOutputCompactionStats,
} from "./stale-tool-output.ts";

const MAX_SUMMARY_OVERFLOW_RETRIES = 3;

interface TextOnlyTurn {
  readonly text: string;
  readonly usage: Usage;
}

export interface BuildCompactedMessagesResult {
  readonly messages: readonly Message[];
  readonly staleToolOutputStats: StaleToolOutputCompactionStats;
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n[truncated ${text.length - maxChars} chars]`;
}

function serializeMessage(
  message: Message,
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
      return `<message role="tool" tool_call_id="${message.toolCallId}">\n${truncateText(
        message.content,
        toolOutputMaxChars,
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

function buildSummaryPrompt(
  messages: readonly Message[],
  options: ResolvedContextCompactionOptions,
  summaryInputMaxChars = options.summaryInputMaxChars,
  focusInstruction?: string,
): string {
  const normalizedFocusInstruction =
    normalizeFocusInstruction(focusInstruction);
  const selected = selectSummaryInput(
    messages.map((message) =>
      serializeMessage(message, options.toolOutputMaxChars),
    ),
    summaryInputMaxChars,
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

export function buildCompactedMessages(
  messages: readonly Message[],
  firstRetainedIndex: number,
  summary: string,
  options: ResolvedContextCompactionOptions,
): BuildCompactedMessagesResult {
  const recent = compactStaleToolOutputs(
    messages.slice(firstRetainedIndex),
    options.toolOutputMaxChars,
  );
  const checkpoint = renderConversationCheckpoint({
    summary: normalizeCheckpointSummary(summary),
    noLaterMessages: recent.messages.length === 0,
  });
  return {
    messages: [
      {
        role: "user",
        content: checkpoint,
      },
      ...recent.messages,
    ],
    staleToolOutputStats: recent.stats,
  };
}

async function collectTextOnlyTurn(options: {
  readonly provider: LLMProvider;
  readonly systemPrompt: string;
  readonly messages: readonly Message[];
  readonly signal: AbortSignal;
}): Promise<TextOnlyTurn> {
  let text = "";
  let usage: Usage | null = null;
  for await (const event of options.provider.stream({
    systemPrompt: options.systemPrompt,
    messages: options.messages,
    signal: options.signal,
    toolChoice: "none",
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
        break;
    }
  }
  if (usage === null) {
    throw new KeelError(
      "agent_missing_stop",
      "LLM stream ended without stop event",
    );
  }
  return { text, usage };
}

function isProviderContextOverflow(error: unknown): boolean {
  return (
    error instanceof KeelError && error.code === "provider_context_overflow"
  );
}

export async function collectCompactionSummary(options: {
  readonly provider: LLMProvider;
  readonly systemPrompt: string;
  readonly messagesToSummarize: readonly Message[];
  readonly signal: AbortSignal;
  readonly contextCompaction: ResolvedContextCompactionOptions;
  readonly focusInstruction?: string;
}): Promise<TextOnlyTurn> {
  let summaryInputMaxChars = options.contextCompaction.summaryInputMaxChars;

  let attempt = 0;
  while (true) {
    const prompt = buildSummaryPrompt(
      options.messagesToSummarize,
      options.contextCompaction,
      summaryInputMaxChars,
      options.focusInstruction,
    );
    try {
      return await collectTextOnlyTurn({
        provider: options.provider,
        systemPrompt: options.systemPrompt,
        messages: [{ role: "user", content: prompt }],
        signal: options.signal,
      });
    } catch (error) {
      if (!isProviderContextOverflow(error)) {
        throw error;
      }
      const reduced = Math.floor(summaryInputMaxChars / 2);
      if (
        attempt === MAX_SUMMARY_OVERFLOW_RETRIES ||
        reduced < MIN_SUMMARY_INPUT_MAX_CHARS
      ) {
        throw error;
      }
      attempt++;
      summaryInputMaxChars = reduced;
    }
  }
}
