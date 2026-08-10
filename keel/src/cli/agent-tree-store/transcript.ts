import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SessionLedgerObserver } from "../../agent/session-ledger.ts";
import type { SessionMessage } from "../../agent/session-message.ts";
import type {
  AgentId,
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
  type AgentTranscriptTerminalRecord,
  agentIdSchema,
  transcriptHeaderSchema,
  transcriptMutationSchema,
} from "./model.ts";

interface ParsedTranscript {
  readonly content: string;
  readonly header: AgentTranscriptHeaderRecord;
  readonly state: TranscriptReplayState;
}

export type TranscriptTerminalExpectation =
  | { readonly kind: "open" }
  | { readonly kind: "terminal"; readonly status: SubagentTerminalStatus };

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
  childAgentId: AgentId,
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
    mode: accepted.mode,
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
  acceptedChildAgentIds: ReadonlySet<string>,
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
    const childAgentId = name.slice(0, -".jsonl".length);
    if (
      !agentIdSchema.safeParse(childAgentId).success ||
      acceptedChildAgentIds.has(childAgentId)
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
    switch (parsed.data.type) {
      case "transcript_initialize":
        if (state.kind === "initialized") {
          agentTreeError(
            `agent transcript ${filePath} initialized more than once`,
          );
        }
        state = { kind: "initialized" };
        break;
      case "transcript_append":
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
        state = { kind: "terminal", record: parsed.data };
        break;
    }
  }
  return { content, header: parsedHeader.data, state };
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
    parsed.state.record.complete !==
      (terminalExpectation.status !== "interrupted")
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
  initialization: TranscriptInitializationExpectation,
): void {
  const parsed = parseTranscript(filePath);
  assertTranscriptIdentity(filePath, parsed.header, accepted);
  if (parsed.state.kind === "terminal") {
    if (
      parsed.state.record.status !== status ||
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
      complete: status !== "interrupted",
    },
    "agent transcript",
  );
}
