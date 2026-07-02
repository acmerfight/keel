import { KeelError } from "../../core/error.ts";
import type { LLMProvider, Message, Usage } from "../../llm/types.ts";
import type {
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
import {
  compactStaleToolOutputs,
  compactStaleToolOutputsWithArtifacts,
  type StaleToolOutputCompactionStats,
} from "./stale-tool-output.ts";
import {
  projectCompactedToolOutput,
  type ToolOutputProjectionContext,
} from "./tool-output-preview.ts";

const MAX_SUMMARY_OVERFLOW_RETRIES = 3;
const MAX_COMPACTION_EVIDENCE_CHARS = 12_000;
const MIN_COMPACTION_EVIDENCE_CHARS = 1_000;
const MIN_COMPACTION_CONVERSATION_CHARS = Math.floor(
  MIN_SUMMARY_INPUT_MAX_CHARS / 3,
);

interface TextOnlyTurn {
  readonly text: string;
  readonly usage: Usage;
}

interface CompactionSummaryTurn extends TextOnlyTurn {
  readonly summaryInputMaxChars: number;
}

export interface BuildCompactedMessagesResult {
  readonly messages: readonly Message[];
  readonly staleToolOutputStats: StaleToolOutputCompactionStats;
  readonly artifactNotices?: readonly ToolOutputArtifactNotice[];
}

function toolContextForSummaryInput(
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
    if (toolCall !== undefined) {
      return { toolName: toolCall.tool, toolCall };
    }
  }
  return { toolName: "unknown" };
}

function summaryToolOutputPreview(options: {
  readonly messages: readonly Message[];
  readonly message: Extract<Message, { readonly role: "tool" }>;
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
  messages: readonly Message[],
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
  messages: readonly Message[],
): readonly CompactionEvidence[] {
  return messages.flatMap((message) =>
    message.role === "user" ? checkpointEvidenceFromMessage(message) : [],
  );
}

function compactionEvidenceForMessages(options: {
  readonly messages: readonly Message[];
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
  readonly messages: readonly Message[];
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
  messages: readonly Message[],
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
  messages: readonly Message[],
  firstRetainedIndex: number,
  summary: string,
  options: ResolvedContextCompactionOptions,
  toolOutputArtifacts?: ToolOutputArtifactsOptions,
  summaryInputMaxChars = options.summaryInputMaxChars,
): Promise<BuildCompactedMessagesResult> {
  const recentMessages = messages.slice(firstRetainedIndex);
  const recent =
    toolOutputArtifacts === undefined
      ? compactStaleToolOutputs(recentMessages, options.toolOutputMaxChars)
      : await compactStaleToolOutputsWithArtifacts(
          recentMessages,
          options.toolOutputMaxChars,
          toolOutputArtifacts.store,
        );
  const checkpointEvidence = await compactionEvidenceForMessages({
    messages: messages.slice(0, firstRetainedIndex),
    toolOutputMaxChars: options.toolOutputMaxChars,
    artifactStore: toolOutputArtifacts?.store,
  });
  const checkpoint = renderConversationCheckpoint({
    summary: normalizeCheckpointSummary(summary),
    noLaterMessages: recent.messages.length === 0,
    evidence: checkpointEvidence,
    evidenceMaxChars: compactionEvidenceMaxChars(summaryInputMaxChars),
  });
  return {
    messages: [
      {
        role: "user",
        content: checkpoint,
        ...(checkpointEvidence.length === 0
          ? {}
          : { contextCompaction: { evidence: checkpointEvidence } }),
      },
      ...recent.messages,
    ],
    staleToolOutputStats: recent.stats,
    ...(recent.artifactNotices !== undefined &&
    recent.artifactNotices.length > 0
      ? { artifactNotices: recent.artifactNotices }
      : {}),
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
  readonly toolOutputArtifacts?: ToolOutputArtifactsOptions;
  readonly focusInstruction?: string;
}): Promise<CompactionSummaryTurn> {
  let summaryInputMaxChars = options.contextCompaction.summaryInputMaxChars;

  let attempt = 0;
  while (true) {
    const prompt = buildSummaryPrompt(
      options.messagesToSummarize,
      options.contextCompaction,
      summaryInputMaxChars,
      options.focusInstruction,
      options.toolOutputArtifacts?.store,
    );
    try {
      const turn = await collectTextOnlyTurn({
        provider: options.provider,
        systemPrompt: options.systemPrompt,
        messages: [{ role: "user", content: await prompt }],
        signal: options.signal,
      });
      return { ...turn, summaryInputMaxChars };
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
