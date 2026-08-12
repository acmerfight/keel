import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SessionLedgerObserver } from "../../agent/session-ledger.ts";
import type { SessionMessage } from "../../agent/session-message.ts";
import { subagentCapabilitiesEqual } from "../../agent/subagent-capability.ts";
import type {
  SubagentRunId,
  SubagentTerminalStatus,
} from "../../agent/subagent-lifecycle.ts";
import { redactMessageForPersistence } from "../persistence-redaction.ts";
import {
  agentTreeError,
  type DirectorySync,
  type DurableJsonlWriter,
  parseJsonLine,
  readRepairableJsonl,
  syncDurableDirectory,
} from "./jsonl.ts";
import {
  AGENT_TRANSCRIPT_MAX_BYTES,
  AGENT_TREE_SCHEMA_VERSION,
  type AgentRunAcceptedRecord,
  type AgentTranscriptHeaderRecord,
  type AgentTranscriptMutationRecord,
  type AgentTranscriptTerminalRecord,
  childRunIdSchema,
  transcriptHeaderSchema,
  transcriptMutationSchema,
} from "./model.ts";

interface ParsedTranscript {
  readonly content: string;
  readonly header: AgentTranscriptHeaderRecord;
  readonly mutations: readonly AgentTranscriptMutationRecord[];
  readonly state: TranscriptReplayState;
}

export type TranscriptTerminalExpectation =
  | { readonly kind: "open" }
  | {
      readonly kind: "terminal";
      readonly status: SubagentTerminalStatus;
      readonly pendingInputCount: number;
    };

export type TranscriptInitializationExpectation =
  | { readonly kind: "optional" }
  | { readonly kind: "required" };

type TranscriptReplayState =
  | { readonly kind: "uninitialized" }
  | { readonly kind: "initialized" }
  | {
      readonly kind: "terminal";
      readonly record: AgentTranscriptTerminalRecord;
    };

export function transcriptFilePath(
  transcriptsDirectory: string,
  childRunId: SubagentRunId,
): string {
  const parsed = childRunIdSchema.safeParse(childRunId);
  if (!parsed.success) agentTreeError(`invalid child run id ${childRunId}`);
  return join(transcriptsDirectory, `${parsed.data}.jsonl`);
}

function transcriptHeader(
  accepted: AgentRunAcceptedRecord,
): AgentTranscriptHeaderRecord {
  const headerBase = {
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
    effort: accepted.effort,
    systemPrompt: accepted.systemPrompt,
    lineage: accepted.lineage,
  } as const;
  if (accepted.workspace === null) {
    return {
      ...headerBase,
      mode: accepted.mode,
      threadCapabilityCeiling: accepted.threadCapabilityCeiling,
      capability: accepted.capability,
      workspace: null,
    };
  }
  return {
    ...headerBase,
    mode: accepted.mode,
    threadCapabilityCeiling: accepted.threadCapabilityCeiling,
    capability: accepted.capability,
    workspace: { ...accepted.workspace },
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

export function removeTranscript(
  filePath: string,
  syncDirectory: DirectorySync = syncDurableDirectory,
): void {
  try {
    unlinkSync(filePath);
    syncDirectory(dirname(filePath));
  } catch (caught) {
    agentTreeError(
      `cannot remove uncommitted agent transcript ${filePath}: ${String(caught)}`,
    );
  }
}

export function reconcileUnacceptedTranscripts(
  transcriptsDirectory: string,
  acceptedChildRunIds: ReadonlySet<string>,
  syncDirectory: DirectorySync = syncDurableDirectory,
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
    const childRunId = name.slice(0, -".jsonl".length);
    if (
      !childRunIdSchema.safeParse(childRunId).success ||
      acceptedChildRunIds.has(childRunId)
    ) {
      continue;
    }
    removeTranscript(join(transcriptsDirectory, name), syncDirectory);
  }
}

function parseTranscript(filePath: string): ParsedTranscript {
  const content = readRepairableJsonl(filePath, AGENT_TRANSCRIPT_MAX_BYTES);
  const records = content
    .split("\n")
    .filter((line) => line !== "")
    .map((line, offset) => parseJsonLine(filePath, line, offset + 1));
  const [headerValue, ...mutationValues] = records;
  const parsedHeader = transcriptHeaderSchema.safeParse(headerValue);
  if (!parsedHeader.success) {
    agentTreeError(`invalid agent transcript header ${filePath}`);
  }
  let state: TranscriptReplayState = { kind: "uninitialized" };
  const mutations: AgentTranscriptMutationRecord[] = [];
  for (const [offset, mutationValue] of mutationValues.entries()) {
    const lineNumber = offset + 2;
    const parsed = transcriptMutationSchema.safeParse(mutationValue);
    if (!parsed.success) {
      agentTreeError(
        `invalid agent transcript record ${filePath} line ${lineNumber}`,
      );
    }
    if (state.kind === "terminal") {
      agentTreeError(`agent transcript ${filePath} changed after terminal`);
    }
    const mutation = parsed.data;
    mutations.push(mutation);
    switch (mutation.type) {
      case "transcript_initialize":
        if (state.kind === "initialized") {
          agentTreeError(
            `agent transcript ${filePath} initialized more than once`,
          );
        }
        state = { kind: "initialized" };
        break;
      case "transcript_append":
      case "transcript_pending_input":
      case "transcript_replace":
        if (state.kind !== "initialized") {
          agentTreeError(
            `agent transcript ${filePath} changed before initialization`,
          );
        }
        break;
      case "transcript_terminal":
        if (state.kind !== "initialized") {
          agentTreeError(
            `agent transcript ${filePath} terminated before initialization`,
          );
        }
        state = { kind: "terminal", record: mutation };
        break;
    }
  }
  return { content, header: parsedHeader.data, mutations, state };
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
    header.effort !== accepted.effort ||
    header.systemPrompt !== accepted.systemPrompt ||
    !subagentCapabilitiesEqual(
      header.threadCapabilityCeiling,
      accepted.threadCapabilityCeiling,
    ) ||
    !subagentCapabilitiesEqual(header.capability, accepted.capability) ||
    JSON.stringify(header.lineage) !== JSON.stringify(accepted.lineage) ||
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
  if (terminalExpectation.kind === "open") {
    if (parsed.state.kind === "terminal") {
      agentTreeError(`open agent transcript ${filePath} has a terminal record`);
    }
    return parsed.content;
  }
  if (parsed.state.kind !== "terminal") {
    agentTreeError(
      `terminal agent transcript ${filePath} has no terminal record`,
    );
  }
  if (
    parsed.state.record.status !== terminalExpectation.status ||
    parsed.state.record.pendingInputCount !==
      terminalExpectation.pendingInputCount ||
    parsed.state.record.pendingInputCount !==
      recordedPendingInputCount(parsed) ||
    parsed.state.record.complete !==
      (terminalExpectation.status !== "interrupted")
  ) {
    agentTreeError(`agent transcript ${filePath} has a conflicting terminal`);
  }
  return parsed.content;
}

export function readAgentTranscriptMessages(
  filePath: string,
  accepted: AgentRunAcceptedRecord,
  terminalExpectation: TranscriptTerminalExpectation,
  baseMessages: readonly SessionMessage[],
): readonly SessionMessage[] {
  readAgentTranscript(filePath, accepted, terminalExpectation);
  const parsed = parseTranscript(filePath);
  let messages = [...baseMessages];
  for (const mutation of parsed.mutations) {
    switch (mutation.type) {
      case "transcript_initialize":
      case "transcript_append":
      case "transcript_pending_input":
        messages.push(...mutation.messages);
        break;
      case "transcript_replace":
        messages = [...mutation.messages];
        break;
      case "transcript_terminal":
        break;
    }
  }
  return messages;
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
        messages: messages.map(redactMessageForPersistence),
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

function recordedPendingInputCount(parsed: ParsedTranscript): number {
  return parsed.mutations.reduce(
    (count, mutation) =>
      mutation.type === "transcript_pending_input"
        ? count + mutation.messages.length
        : count,
    0,
  );
}

export function appendPendingAgentInput(
  writer: DurableJsonlWriter,
  filePath: string,
  messages: readonly Extract<SessionMessage, { readonly role: "user" }>[],
): void {
  writer.append(
    filePath,
    {
      schemaVersion: AGENT_TREE_SCHEMA_VERSION,
      type: "transcript_pending_input",
      messages: messages.map(redactMessageForPersistence),
    },
    "agent transcript",
  );
}

export function readPendingAgentInputCount(
  filePath: string,
  accepted: AgentRunAcceptedRecord,
): number {
  const parsed = parseTranscript(filePath);
  assertTranscriptIdentity(filePath, parsed.header, accepted);
  return recordedPendingInputCount(parsed);
}

export function ensureInterruptedTranscriptInitialized(
  writer: DurableJsonlWriter,
  filePath: string,
  accepted: AgentRunAcceptedRecord,
  initialization: TranscriptInitializationExpectation,
): void {
  const parsed = parseTranscript(filePath);
  assertTranscriptIdentity(filePath, parsed.header, accepted);
  if (parsed.state.kind === "terminal") {
    agentTreeError(
      `agent transcript ${filePath} terminated before its interrupted result`,
    );
  }
  if (parsed.state.kind === "initialized") return;
  if (initialization.kind === "required") {
    agentTreeError(`agent transcript ${filePath} was never initialized`);
  }
  writer.append(
    filePath,
    {
      schemaVersion: AGENT_TREE_SCHEMA_VERSION,
      type: "transcript_initialize",
      messages: [],
    },
    "agent transcript",
  );
}

export function ensureTranscriptTerminal(
  writer: DurableJsonlWriter,
  filePath: string,
  accepted: AgentRunAcceptedRecord,
  status: SubagentTerminalStatus,
  pendingInputCount: number,
  initialization: TranscriptInitializationExpectation,
): void {
  const parsed = parseTranscript(filePath);
  assertTranscriptIdentity(filePath, parsed.header, accepted);
  if (recordedPendingInputCount(parsed) !== pendingInputCount) {
    agentTreeError(`agent transcript ${filePath} has a conflicting terminal`);
  }
  if (parsed.state.kind === "terminal") {
    if (
      parsed.state.record.status !== status ||
      parsed.state.record.pendingInputCount !== pendingInputCount ||
      parsed.state.record.complete !== (status !== "interrupted")
    ) {
      agentTreeError(`agent transcript ${filePath} has a conflicting terminal`);
    }
    return;
  }
  if (parsed.state.kind === "uninitialized") {
    if (initialization.kind === "required") {
      agentTreeError(`agent transcript ${filePath} was never initialized`);
    }
    writer.append(
      filePath,
      {
        schemaVersion: AGENT_TREE_SCHEMA_VERSION,
        type: "transcript_initialize",
        messages: [],
      },
      "agent transcript",
    );
  }
  writer.append(
    filePath,
    {
      schemaVersion: AGENT_TREE_SCHEMA_VERSION,
      type: "transcript_terminal",
      status,
      pendingInputCount,
      complete: status !== "interrupted",
    },
    "agent transcript",
  );
}
