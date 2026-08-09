import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { SessionLedgerObserver } from "../../agent/session-ledger.ts";
import type { SessionMessage } from "../../agent/session-message.ts";
import type { SubagentTerminalStatus } from "../../agent/subagent-lifecycle.ts";
import {
  agentTreeError,
  type DurableJsonlWriter,
  parseJsonLine,
  readRepairableJsonl,
} from "./jsonl.ts";
import {
  AGENT_TRANSCRIPT_MAX_BYTES,
  AGENT_TREE_SCHEMA_VERSION,
  type AgentRunAcceptedRecord,
  type AgentTranscriptHeaderRecord,
  type AgentTranscriptTerminalRecord,
  agentIdSchema,
  transcriptHeaderSchema,
  transcriptMutationSchema,
} from "./model.ts";

interface ParsedTranscript {
  readonly content: string;
  readonly header: AgentTranscriptHeaderRecord;
  readonly mutations: readonly ParsedTranscriptMutation[];
}

export type TranscriptTerminalExpectation =
  | { readonly kind: "open" }
  | { readonly kind: "terminal"; readonly status: SubagentTerminalStatus };

type ParsedTranscriptMutation =
  | {
      readonly type:
        | "transcript_initialize"
        | "transcript_append"
        | "transcript_replace";
    }
  | AgentTranscriptTerminalRecord;

export function transcriptFilePath(
  transcriptsDirectory: string,
  childAgentId: string,
): string {
  const parsed = agentIdSchema.safeParse(childAgentId);
  if (!parsed.success) agentTreeError(`invalid child agent id ${childAgentId}`);
  return join(transcriptsDirectory, `${parsed.data}.jsonl`);
}

function transcriptHeader(
  accepted: AgentRunAcceptedRecord,
): AgentTranscriptHeaderRecord {
  return {
    schemaVersion: AGENT_TREE_SCHEMA_VERSION,
    type: "transcript",
    kind: "subagent",
    createdAt: accepted.timestamp,
    transcriptRef: accepted.transcriptRef,
    delegationId: accepted.delegationId,
    childAgentId: accepted.childAgentId,
    childRunId: accepted.childRunId,
    parentRunId: accepted.parentRunId,
    parentToolCallId: accepted.parentToolCallId,
    task: accepted.task,
    focusPaths: [...accepted.focusPaths],
    providerId: accepted.providerId,
    model: accepted.model,
    systemPrompt: accepted.systemPrompt,
  };
}

export function ensureTranscriptExists(
  writer: DurableJsonlWriter,
  filePath: string,
  accepted: AgentRunAcceptedRecord,
): void {
  if (existsSync(filePath)) return;
  writer.create(filePath, transcriptHeader(accepted), "agent transcript");
}

export function removeTranscript(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch (caught) {
    agentTreeError(
      `cannot remove uncommitted agent transcript ${filePath}: ${String(caught)}`,
    );
  }
}

export function reconcileUnacceptedTranscripts(
  transcriptsDirectory: string,
  acceptedChildAgentIds: ReadonlySet<string>,
): void {
  let names: readonly string[];
  try {
    names = readdirSync(transcriptsDirectory);
  } catch (caught) {
    agentTreeError(
      `cannot inspect agent transcripts ${transcriptsDirectory}: ${String(caught)}`,
    );
  }
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const childAgentId = name.slice(0, -".jsonl".length);
    if (
      !agentIdSchema.safeParse(childAgentId).success ||
      acceptedChildAgentIds.has(childAgentId)
    ) {
      continue;
    }
    removeTranscript(join(transcriptsDirectory, name));
  }
}

function parseTranscript(filePath: string): ParsedTranscript {
  const content = readRepairableJsonl(filePath, AGENT_TRANSCRIPT_MAX_BYTES);
  const lines = content.split("\n").filter((line) => line !== "");
  const headerLine = lines[0];
  if (headerLine === undefined) {
    agentTreeError(`agent transcript ${filePath} is empty`);
  }
  const parsedHeader = transcriptHeaderSchema.safeParse(
    parseJsonLine(filePath, headerLine, 1),
  );
  if (!parsedHeader.success) {
    agentTreeError(`invalid agent transcript header ${filePath}`);
  }
  const mutations: ParsedTranscriptMutation[] = [];
  let terminalSeen = false;
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index];
    if (line === undefined) continue;
    const parsed = transcriptMutationSchema.safeParse(
      parseJsonLine(filePath, line, index + 1),
    );
    if (!parsed.success) {
      agentTreeError(
        `invalid agent transcript record ${filePath} line ${index + 1}`,
      );
    }
    if (terminalSeen) {
      agentTreeError(`agent transcript ${filePath} changed after terminal`);
    }
    terminalSeen = parsed.data.type === "transcript_terminal";
    mutations.push(
      parsed.data.type === "transcript_terminal"
        ? parsed.data
        : { type: parsed.data.type },
    );
  }
  return { content, header: parsedHeader.data, mutations };
}

function assertTranscriptIdentity(
  filePath: string,
  header: AgentTranscriptHeaderRecord,
  accepted: AgentRunAcceptedRecord,
): void {
  if (
    header.delegationId !== accepted.delegationId ||
    header.childAgentId !== accepted.childAgentId ||
    header.childRunId !== accepted.childRunId ||
    header.parentRunId !== accepted.parentRunId ||
    header.parentToolCallId !== accepted.parentToolCallId ||
    header.task !== accepted.task ||
    header.transcriptRef !== accepted.transcriptRef ||
    header.createdAt !== accepted.timestamp ||
    header.providerId !== accepted.providerId ||
    header.model !== accepted.model ||
    header.systemPrompt !== accepted.systemPrompt ||
    header.focusPaths.length !== accepted.focusPaths.length ||
    header.focusPaths.some(
      (focusPath, index) => focusPath !== accepted.focusPaths[index],
    )
  ) {
    agentTreeError(
      `agent transcript ${filePath} identity mismatches acceptance`,
    );
  }
}

export function readAgentTranscript(
  filePath: string,
  accepted: AgentRunAcceptedRecord,
  terminalExpectation: TranscriptTerminalExpectation,
): string {
  const parsed = parseTranscript(filePath);
  assertTranscriptIdentity(filePath, parsed.header, accepted);
  const terminal = parsed.mutations.at(-1);
  if (terminalExpectation.kind === "open") {
    if (terminal?.type === "transcript_terminal") {
      agentTreeError(`open agent transcript ${filePath} has a terminal record`);
    }
    return parsed.content;
  }
  if (terminal?.type !== "transcript_terminal") {
    agentTreeError(
      `terminal agent transcript ${filePath} has no terminal record`,
    );
  }
  if (
    terminal.status !== terminalExpectation.status ||
    terminal.complete !== (terminalExpectation.status !== "interrupted")
  ) {
    agentTreeError(`agent transcript ${filePath} has a conflicting terminal`);
  }
  return parsed.content;
}

export function createTranscriptObserver(
  writer: DurableJsonlWriter,
  filePath: string,
): SessionLedgerObserver {
  const append = (
    type: "transcript_initialize" | "transcript_append" | "transcript_replace",
    messages: readonly SessionMessage[],
  ): void => {
    writer.append(
      filePath,
      {
        schemaVersion: AGENT_TREE_SCHEMA_VERSION,
        type,
        messages,
      },
      "agent transcript",
    );
  };
  return {
    initialize: (messages) => append("transcript_initialize", messages),
    append: (messages) => append("transcript_append", messages),
    replace: (messages) => append("transcript_replace", messages),
  };
}

export function ensureTranscriptTerminal(
  writer: DurableJsonlWriter,
  filePath: string,
  accepted: AgentRunAcceptedRecord,
  status: SubagentTerminalStatus,
): void {
  const parsed = parseTranscript(filePath);
  assertTranscriptIdentity(filePath, parsed.header, accepted);
  const lastMutation = parsed.mutations.at(-1);
  if (lastMutation?.type === "transcript_terminal") {
    if (
      lastMutation.status !== status ||
      lastMutation.complete !== (status !== "interrupted")
    ) {
      agentTreeError(`agent transcript ${filePath} has a conflicting terminal`);
    }
    return;
  }
  writer.append(
    filePath,
    {
      schemaVersion: AGENT_TREE_SCHEMA_VERSION,
      type: "transcript_terminal",
      status,
      complete: status !== "interrupted",
    },
    "agent transcript",
  );
}
