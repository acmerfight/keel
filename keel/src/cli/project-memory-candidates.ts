import { randomUUID } from "node:crypto";
import type { ProviderId } from "../core/provider-id.ts";
import { prohibitedSensitiveTextCategory } from "../core/sensitive-text.ts";
import type { Usage } from "../llm/types.ts";
import { hasPersistenceRedactionMarker } from "./persistence-redaction.ts";
import {
  listProjectMemory,
  type ProjectMemoryEntry,
  type ProjectMemoryRuntime,
  type ProjectMemoryScope,
  projectMemoryDirectory,
  projectMemoryDirectoryForRead,
  projectMemoryEventsWithoutTarget,
  resolveProjectMemoryScope,
  validateProjectMemoryGeneration,
} from "./project-memory.ts";
import {
  acquireProjectMemoryWriteLock,
  appendProjectMemoryEvent,
  readProjectMemoryEventFile,
  removeProjectMemoryEventFile,
  replaceProjectMemoryEvents,
} from "./project-memory-event-file.ts";
import {
  CANDIDATE_ID_PATTERN,
  type CandidateApproveEvent,
  type CandidateExtractionFailure,
  type CandidateExtractionOperation,
  type CandidateKind,
  type CandidateProposalOrigin,
  type CandidateRecord,
  type CandidateSource,
  eventsWithoutCandidateArtifacts,
  type MemoryRecord,
  PROJECT_MEMORY_SCHEMA_VERSION,
  type ProjectMemoryEvent,
} from "./project-memory-events.ts";

const CANDIDATE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_PENDING_CANDIDATES = 100;

type SuccessfulExtractionOperation = Extract<
  CandidateExtractionOperation,
  { readonly outcome: "succeeded" }
>;

type ProjectMemoryCandidateOrigin =
  | {
      readonly type: "completed_session_extraction";
      readonly extraction: SuccessfulExtractionOperation;
    }
  | {
      readonly type: "current_turn_proposal";
      readonly proposal: CandidateProposalOrigin;
    };

type ProjectMemoryCandidateStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "expired"
  | "discarded";

export interface ProjectMemoryCandidate {
  readonly id: string;
  readonly kind: CandidateKind;
  readonly originalStatement: string;
  readonly statement: string;
  readonly why: string;
  readonly sources: readonly CandidateSource[];
  readonly duplicateMemoryIds: readonly string[];
  readonly conflictMemoryIds: readonly string[];
  readonly sensitivityValidation: "passed_sensitive_text_v1";
  readonly origin: ProjectMemoryCandidateOrigin;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly status: ProjectMemoryCandidateStatus;
  readonly memoryId: string | null;
}

interface MutableCandidate {
  readonly created: CandidateRecord;
  readonly origin: ProjectMemoryCandidateOrigin;
  statement: string;
  status: "pending" | "approved" | "rejected" | "discarded";
  memoryId: string | null;
}

interface CandidateState {
  readonly events: readonly ProjectMemoryEvent[];
  readonly candidates: readonly ProjectMemoryCandidate[];
  readonly operations: readonly CandidateExtractionOperation[];
  readonly successfulSessionIds: ReadonlySet<string>;
}

export interface CandidateProposal {
  readonly kind: CandidateKind;
  readonly statement: string;
  readonly why: string;
  readonly sources: readonly CandidateSource[];
  readonly conflictMemoryIds: readonly string[];
}

export interface CandidateExtractionRecord {
  readonly operationId: string;
  readonly sessionId: string;
  readonly providerId: ProviderId;
  readonly model: string;
  readonly usage: Usage;
  readonly costUsd: number;
  readonly attemptCount: number;
  readonly retryCount: number;
  readonly maxCostUsd: number;
  readonly createdAt: string;
  readonly finishedAt: string;
}

export interface CurrentTurnCandidateProposalRecord {
  readonly sessionId: string;
  readonly messageId: string;
  readonly providerId: ProviderId;
  readonly model: string;
  readonly createdAt: string;
}

export type CandidateConflictResolution =
  | { readonly type: "none" }
  | { readonly type: "keep" }
  | { readonly type: "supersede"; readonly memoryId: string };

export class ProjectMemoryCandidateError extends Error {}

function fail(message: string): never {
  throw new ProjectMemoryCandidateError(message);
}

function memoryFilePathForRead(
  runtime: ProjectMemoryRuntime,
  scope: ProjectMemoryScope,
): string | null {
  const directory = projectMemoryDirectoryForRead(runtime, scope);
  return directory === undefined ? null : `${directory}/events.jsonl`;
}

function immutableCandidate(
  mutable: MutableCandidate,
  now: number,
): ProjectMemoryCandidate {
  const status =
    mutable.status === "pending" && Date.parse(mutable.created.expiresAt) <= now
      ? "expired"
      : mutable.status;
  return {
    id: mutable.created.id,
    kind: mutable.created.kind,
    originalStatement: mutable.created.statement,
    statement: mutable.statement,
    why: mutable.created.why,
    sources: mutable.created.sources,
    duplicateMemoryIds: mutable.created.duplicateMemoryIds,
    conflictMemoryIds: mutable.created.conflictMemoryIds,
    sensitivityValidation: mutable.created.sensitivityValidation,
    origin: mutable.origin,
    createdAt: mutable.created.createdAt,
    expiresAt: mutable.created.expiresAt,
    status,
    memoryId: mutable.memoryId,
  };
}

function replayCandidateEvents(
  events: readonly ProjectMemoryEvent[],
  filePath: string,
  now: number,
): CandidateState {
  const candidates = new Map<string, MutableCandidate>();
  const operations: CandidateExtractionOperation[] = [];
  const successfulSessionIds = new Set<string>();
  for (const [index, event] of events.entries()) {
    if (event.type === "candidate_extraction") {
      operations.push(event.operation);
      if (event.operation.outcome !== "succeeded") continue;
      successfulSessionIds.add(event.operation.sessionId);
      for (const id of event.discardedCandidateIds) {
        const target = candidates.get(id);
        if (target === undefined || target.status !== "pending") {
          fail(
            `Error: cannot read project-memory candidates ${filePath}: extraction discards invalid ${id} at line ${index + 1}.`,
          );
        }
        target.status = "discarded";
      }
      for (const candidate of event.candidates) {
        if (candidates.has(candidate.id)) {
          fail(
            `Error: cannot read project-memory candidates ${filePath}: duplicate candidate ${candidate.id} at line ${index + 1}.`,
          );
        }
        if (
          candidate.sources.some(
            (source) => source.sessionId !== event.operation.sessionId,
          )
        ) {
          fail(
            `Error: cannot read project-memory candidates ${filePath}: candidate source session mismatch at line ${index + 1}.`,
          );
        }
        candidates.set(candidate.id, {
          created: candidate,
          origin: {
            type: "completed_session_extraction",
            extraction: event.operation,
          },
          statement: candidate.statement,
          status: "pending",
          memoryId: null,
        });
      }
      continue;
    }
    if (event.type === "candidate_proposal") {
      const candidate = event.candidate;
      if (candidates.has(candidate.id)) {
        fail(
          `Error: cannot read project-memory candidates ${filePath}: duplicate candidate ${candidate.id} at line ${index + 1}.`,
        );
      }
      candidates.set(candidate.id, {
        created: candidate,
        origin: {
          type: "current_turn_proposal",
          proposal: event.origin,
        },
        statement: candidate.statement,
        status: "pending",
        memoryId: null,
      });
      continue;
    }
    if (event.type === "candidate_edit") {
      const target = candidates.get(event.targetId);
      if (target === undefined || target.status !== "pending") {
        fail(
          `Error: cannot read project-memory candidates ${filePath}: edit targets invalid ${event.targetId} at line ${index + 1}.`,
        );
      }
      target.statement = event.statement;
      continue;
    }
    if (event.type === "candidate_reject") {
      for (const id of event.targetIds) {
        const target = candidates.get(id);
        if (target === undefined || target.status !== "pending") {
          fail(
            `Error: cannot read project-memory candidates ${filePath}: reject targets invalid ${id} at line ${index + 1}.`,
          );
        }
        target.status = "rejected";
      }
      continue;
    }
    if (event.type === "candidate_approve") {
      const target = candidates.get(event.targetId);
      if (target === undefined || target.status !== "pending") {
        fail(
          `Error: cannot read project-memory candidates ${filePath}: approve targets invalid ${event.targetId} at line ${index + 1}.`,
        );
      }
      if (
        event.memory.source.type !== "user_approved" ||
        event.memory.source.candidateId !== event.targetId ||
        event.memory.text !== target.statement
      ) {
        fail(
          `Error: cannot read project-memory candidates ${filePath}: invalid activation relation at line ${index + 1}.`,
        );
      }
      target.status = "approved";
      target.memoryId = event.memory.id;
    }
  }
  return {
    events,
    candidates: [...candidates.values()].map((candidate) =>
      immutableCandidate(candidate, now),
    ),
    operations,
    successfulSessionIds,
  };
}

function readState(
  runtime: ProjectMemoryRuntime,
  workspace: string,
): { readonly scope: ProjectMemoryScope; readonly state: CandidateState } {
  const scope = resolveProjectMemoryScope(workspace);
  const filePath = memoryFilePathForRead(runtime, scope);
  const events = filePath === null ? [] : readProjectMemoryEventFile(filePath);
  return {
    scope,
    state: replayCandidateEvents(
      events,
      filePath ?? "events.jsonl",
      runtime.now(),
    ),
  };
}

function withWriteLock<T>(
  runtime: ProjectMemoryRuntime,
  workspace: string,
  action: (
    scope: ProjectMemoryScope,
    state: CandidateState,
    filePath: string,
  ) => T,
): T {
  const scope = resolveProjectMemoryScope(workspace);
  const directory = projectMemoryDirectory(runtime, scope);
  const release = acquireProjectMemoryWriteLock(directory);
  const filePath = `${directory}/events.jsonl`;
  try {
    const events = readProjectMemoryEventFile(filePath);
    const state = replayCandidateEvents(events, filePath, runtime.now());
    return action(scope, state, filePath);
  } finally {
    release();
  }
}

function withHeldWriteLock<T>(
  runtime: ProjectMemoryRuntime,
  workspace: string,
  action: (
    scope: ProjectMemoryScope,
    state: CandidateState,
    filePath: string,
  ) => T,
): T {
  const scope = resolveProjectMemoryScope(workspace);
  const directory = projectMemoryDirectory(runtime, scope);
  const filePath = `${directory}/events.jsonl`;
  const events = readProjectMemoryEventFile(filePath);
  const state = replayCandidateEvents(events, filePath, runtime.now());
  return action(scope, state, filePath);
}

function validateCandidateId(id: string): void {
  if (!CANDIDATE_ID_PATTERN.test(id)) {
    fail(`Error: invalid project-memory candidate id "${id}".`);
  }
}

function requireCandidate(
  state: CandidateState,
  id: string,
): ProjectMemoryCandidate {
  const candidate = state.candidates.find((entry) => entry.id === id);
  if (candidate === undefined) {
    fail(
      `Error: project-memory candidate ${id} does not exist in this project.`,
    );
  }
  return candidate;
}

function requirePendingCandidate(
  state: CandidateState,
  id: string,
): ProjectMemoryCandidate {
  const candidate = requireCandidate(state, id);
  if (candidate.status !== "pending") {
    fail(
      `Error: project-memory candidate ${id} is ${candidate.status}, not pending.`,
    );
  }
  return candidate;
}

function validatedCandidateText(rawText: string): string {
  const text = rawText.trim();
  if (text === "") {
    fail("Error: project-memory candidate requires a non-empty statement.");
  }
  if (text.length > 1_000) {
    fail(
      "Error: project-memory candidate text must be at most 1000 characters.",
    );
  }
  if (
    prohibitedSensitiveTextCategory(text) !== undefined ||
    hasPersistenceRedactionMarker(text)
  ) {
    fail(
      "Error: project-memory candidate was not stored because it contains prohibited sensitive data or a redaction marker.",
    );
  }
  return text;
}

function normalizedProposal(
  proposal: CandidateProposal,
  sessionId: string,
  activeMemory: readonly ProjectMemoryEntry[],
): CandidateProposal & { readonly duplicateMemoryIds: readonly string[] } {
  const statement = validatedCandidateText(proposal.statement);
  const why = validatedCandidateText(proposal.why);
  for (const source of proposal.sources) {
    if (
      prohibitedSensitiveTextCategory(source.quote) !== undefined ||
      hasPersistenceRedactionMarker(source.quote)
    ) {
      fail(
        "Error: candidate source was not stored because it contains prohibited sensitive data or a redaction marker.",
      );
    }
  }
  if (proposal.sources.some((source) => source.sessionId !== sessionId)) {
    fail(
      "Error: candidate source session does not match the extraction session.",
    );
  }
  const activeIds = new Set(activeMemory.map((entry) => entry.id));
  const conflictMemoryIds = [...new Set(proposal.conflictMemoryIds)];
  for (const memoryId of conflictMemoryIds) {
    if (!activeIds.has(memoryId)) {
      fail(
        `Error: candidate named project memory ${memoryId} as a conflict, but it is not active in this project.`,
      );
    }
  }
  const duplicateMemoryIds = activeMemory
    .filter(
      (entry) => entry.text.trim().toLowerCase() === statement.toLowerCase(),
    )
    .map((entry) => entry.id);
  return {
    ...proposal,
    statement,
    why,
    conflictMemoryIds,
    duplicateMemoryIds,
  };
}

function successfulOperation(
  extraction: CandidateExtractionRecord,
  resultCount: number,
): SuccessfulExtractionOperation {
  return {
    operationId: extraction.operationId,
    sessionId: extraction.sessionId,
    trigger: "explicit_command",
    extractorVersion: 1,
    maxCostUsd: extraction.maxCostUsd,
    createdAt: extraction.createdAt,
    finishedAt: extraction.finishedAt,
    outcome: "succeeded",
    providerId: extraction.providerId,
    model: extraction.model,
    usage: extraction.usage,
    costUsd: extraction.costUsd,
    attemptCount: extraction.attemptCount,
    retryCount: extraction.retryCount,
    resultCount,
    failure: null,
  };
}

function recordCandidateExtractionInState(
  runtime: ProjectMemoryRuntime,
  workspace: string,
  scope: ProjectMemoryScope,
  state: CandidateState,
  filePath: string,
  extraction: CandidateExtractionRecord,
  proposals: readonly CandidateProposal[],
  retry: boolean,
): {
  readonly scope: ProjectMemoryScope;
  readonly candidates: readonly ProjectMemoryCandidate[];
  readonly pendingCount: number;
  readonly operation: SuccessfulExtractionOperation;
} {
  if (proposals.length > 5) {
    fail("Error: candidate extraction returned more than 5 candidates.");
  }
  if (state.successfulSessionIds.has(extraction.sessionId) && !retry) {
    fail(
      `Error: session "${extraction.sessionId}" already has a successful candidate extraction. Use --retry to run it again.`,
    );
  }
  const activeMemory = listProjectMemory(runtime, workspace, {
    all: false,
  }).entries;
  const normalized = proposals.map((proposal) =>
    normalizedProposal(proposal, extraction.sessionId, activeMemory),
  );
  const discardedCandidateIds = retry
    ? state.candidates
        .filter(
          (candidate) =>
            candidate.status === "pending" &&
            candidate.origin.type === "completed_session_extraction" &&
            candidate.origin.extraction.sessionId === extraction.sessionId,
        )
        .map((candidate) => candidate.id)
    : [];
  const pending = state.candidates.filter(
    (candidate) =>
      candidate.status === "pending" &&
      !discardedCandidateIds.includes(candidate.id),
  ).length;
  if (pending + normalized.length > MAX_PENDING_CANDIDATES) {
    fail(
      `Error: project-memory candidate inbox would exceed ${MAX_PENDING_CANDIDATES} pending candidates. Review or clear existing candidates first.`,
    );
  }
  const operation = successfulOperation(extraction, normalized.length);
  const candidates: CandidateRecord[] = normalized.map((proposal) => ({
    id: `cand_${randomUUID()}`,
    kind: proposal.kind,
    statement: proposal.statement,
    why: proposal.why,
    sources: [...proposal.sources],
    duplicateMemoryIds: [...proposal.duplicateMemoryIds],
    conflictMemoryIds: [...proposal.conflictMemoryIds],
    sensitivityValidation: "passed_sensitive_text_v1",
    createdAt: extraction.finishedAt,
    expiresAt: new Date(
      Date.parse(extraction.finishedAt) + CANDIDATE_TTL_MS,
    ).toISOString(),
  }));
  const event: ProjectMemoryEvent = {
    version: PROJECT_MEMORY_SCHEMA_VERSION,
    type: "candidate_extraction",
    operation,
    candidates,
    purgedCandidateCount: 0,
    discardedCandidateIds,
  };
  const nextEvents = [...state.events, event];
  const next = replayCandidateEvents(nextEvents, filePath, runtime.now());
  validateProjectMemoryGeneration(nextEvents, filePath, runtime.now());
  appendProjectMemoryEvent(filePath, event);
  const createdIds = new Set(candidates.map((candidate) => candidate.id));
  return {
    scope,
    candidates: next.candidates.filter((candidate) =>
      createdIds.has(candidate.id),
    ),
    pendingCount: next.candidates.filter(
      (candidate) => candidate.status === "pending",
    ).length,
    operation,
  };
}

export function recordCandidateExtraction(
  runtime: ProjectMemoryRuntime,
  workspace: string,
  extraction: CandidateExtractionRecord,
  proposals: readonly CandidateProposal[],
  retry: boolean,
): ReturnType<typeof recordCandidateExtractionInState> {
  return withWriteLock(runtime, workspace, (scope, state, filePath) =>
    recordCandidateExtractionInState(
      runtime,
      workspace,
      scope,
      state,
      filePath,
      extraction,
      proposals,
      retry,
    ),
  );
}

export function recordCandidateExtractionWithWriteLockHeld(
  runtime: ProjectMemoryRuntime,
  workspace: string,
  extraction: CandidateExtractionRecord,
  proposals: readonly CandidateProposal[],
  retry: boolean,
): ReturnType<typeof recordCandidateExtractionInState> {
  return withHeldWriteLock(runtime, workspace, (scope, state, filePath) =>
    recordCandidateExtractionInState(
      runtime,
      workspace,
      scope,
      state,
      filePath,
      extraction,
      proposals,
      retry,
    ),
  );
}

export function recordCurrentTurnCandidateProposal(
  runtime: ProjectMemoryRuntime,
  workspace: string,
  origin: CurrentTurnCandidateProposalRecord,
  proposal: CandidateProposal,
): {
  readonly scope: ProjectMemoryScope;
  readonly candidate: ProjectMemoryCandidate;
} {
  return withWriteLock(runtime, workspace, (scope, state, filePath) => {
    const activeMemory = listProjectMemory(runtime, workspace, {
      all: false,
    }).entries;
    const normalized = normalizedProposal(
      proposal,
      origin.sessionId,
      activeMemory,
    );
    if (normalized.duplicateMemoryIds.length > 0) {
      fail(
        `Error: project-memory proposal duplicates active memory ${normalized.duplicateMemoryIds.join(", ")}.`,
      );
    }
    const pendingCount = state.candidates.filter(
      (candidate) => candidate.status === "pending",
    ).length;
    if (pendingCount >= MAX_PENDING_CANDIDATES) {
      fail(
        `Error: project-memory candidate inbox already contains ${MAX_PENDING_CANDIDATES} pending candidates. Review or clear existing candidates first.`,
      );
    }
    const candidate: CandidateRecord = {
      id: `cand_${randomUUID()}`,
      kind: normalized.kind,
      statement: normalized.statement,
      why: normalized.why,
      sources: [...normalized.sources],
      duplicateMemoryIds: [...normalized.duplicateMemoryIds],
      conflictMemoryIds: [...normalized.conflictMemoryIds],
      sensitivityValidation: "passed_sensitive_text_v1",
      createdAt: origin.createdAt,
      expiresAt: new Date(
        Date.parse(origin.createdAt) + CANDIDATE_TTL_MS,
      ).toISOString(),
    };
    const event: ProjectMemoryEvent = {
      version: PROJECT_MEMORY_SCHEMA_VERSION,
      type: "candidate_proposal",
      origin: {
        sessionId: origin.sessionId,
        messageId: origin.messageId,
        providerId: origin.providerId,
        model: origin.model,
        createdAt: origin.createdAt,
      },
      candidate,
    };
    const nextEvents = [...state.events, event];
    const next = replayCandidateEvents(nextEvents, filePath, runtime.now());
    validateProjectMemoryGeneration(nextEvents, filePath, runtime.now());
    appendProjectMemoryEvent(filePath, event);
    return {
      scope,
      candidate: requireCandidate(next, candidate.id),
    };
  });
}

export function recordCandidateExtractionOutcome(
  runtime: ProjectMemoryRuntime,
  workspace: string,
  operation: Exclude<
    CandidateExtractionOperation,
    { readonly outcome: "succeeded" }
  >,
): ProjectMemoryScope {
  return withWriteLock(runtime, workspace, (scope, state, filePath) =>
    recordCandidateExtractionOutcomeInState(
      runtime,
      scope,
      state,
      filePath,
      operation,
    ),
  );
}

function recordCandidateExtractionOutcomeInState(
  runtime: ProjectMemoryRuntime,
  scope: ProjectMemoryScope,
  state: CandidateState,
  filePath: string,
  operation: Exclude<
    CandidateExtractionOperation,
    { readonly outcome: "succeeded" }
  >,
): ProjectMemoryScope {
  const event: ProjectMemoryEvent = {
    version: PROJECT_MEMORY_SCHEMA_VERSION,
    type: "candidate_extraction",
    operation,
    candidates: [],
    purgedCandidateCount: 0,
    discardedCandidateIds: [],
  };
  const nextEvents = [...state.events, event];
  replayCandidateEvents(nextEvents, filePath, runtime.now());
  validateProjectMemoryGeneration(nextEvents, filePath, runtime.now());
  appendProjectMemoryEvent(filePath, event);
  return scope;
}

export function recordCandidateExtractionOutcomeWithWriteLockHeld(
  runtime: ProjectMemoryRuntime,
  workspace: string,
  operation: Exclude<
    CandidateExtractionOperation,
    { readonly outcome: "succeeded" }
  >,
): ProjectMemoryScope {
  return withHeldWriteLock(runtime, workspace, (scope, state, filePath) =>
    recordCandidateExtractionOutcomeInState(
      runtime,
      scope,
      state,
      filePath,
      operation,
    ),
  );
}

export function listProjectMemoryCandidates(
  runtime: ProjectMemoryRuntime,
  workspace: string,
): {
  readonly scope: ProjectMemoryScope;
  readonly candidates: readonly ProjectMemoryCandidate[];
  readonly operations: readonly CandidateExtractionOperation[];
} {
  const { scope, state } = readState(runtime, workspace);
  return { scope, candidates: state.candidates, operations: state.operations };
}

export function showProjectMemoryCandidate(
  runtime: ProjectMemoryRuntime,
  workspace: string,
  id: string,
): {
  readonly scope: ProjectMemoryScope;
  readonly candidate: ProjectMemoryCandidate;
} {
  validateCandidateId(id);
  const { scope, state } = readState(runtime, workspace);
  return { scope, candidate: requireCandidate(state, id) };
}

export function editProjectMemoryCandidate(
  runtime: ProjectMemoryRuntime,
  workspace: string,
  id: string,
  rawStatement: string,
): ProjectMemoryCandidate {
  validateCandidateId(id);
  const statement = validatedCandidateText(rawStatement);
  return withWriteLock(runtime, workspace, (_scope, state, filePath) => {
    const candidate = requirePendingCandidate(state, id);
    if (candidate.statement === statement) {
      fail("Error: candidate edit must change the statement.");
    }
    const event: ProjectMemoryEvent = {
      version: PROJECT_MEMORY_SCHEMA_VERSION,
      type: "candidate_edit",
      targetId: id,
      statement,
      createdAt: new Date(runtime.now()).toISOString(),
    };
    const nextEvents = [...state.events, event];
    const next = replayCandidateEvents(nextEvents, filePath, runtime.now());
    appendProjectMemoryEvent(filePath, event);
    return requireCandidate(next, id);
  });
}

export function rejectProjectMemoryCandidate(
  runtime: ProjectMemoryRuntime,
  workspace: string,
  id: string,
): ProjectMemoryScope {
  validateCandidateId(id);
  return withWriteLock(runtime, workspace, (scope, state, filePath) => {
    requirePendingCandidate(state, id);
    const event: ProjectMemoryEvent = {
      version: PROJECT_MEMORY_SCHEMA_VERSION,
      type: "candidate_reject",
      targetIds: [id],
      reason: "user_rejected",
      createdAt: new Date(runtime.now()).toISOString(),
    };
    replayCandidateEvents([...state.events, event], filePath, runtime.now());
    appendProjectMemoryEvent(filePath, event);
    return scope;
  });
}

function currentConflicts(
  candidate: ProjectMemoryCandidate,
  active: readonly ProjectMemoryEntry[],
): readonly string[] {
  const activeIds = new Set(active.map((entry) => entry.id));
  return candidate.conflictMemoryIds.filter((id) => activeIds.has(id));
}

function candidateOriginSessionId(candidate: ProjectMemoryCandidate): string {
  return candidate.origin.type === "completed_session_extraction"
    ? candidate.origin.extraction.sessionId
    : candidate.origin.proposal.sessionId;
}

type CandidateApproval =
  | {
      readonly channel: "cli";
      readonly resolution: CandidateConflictResolution;
    }
  | {
      readonly channel: "interactive";
      readonly resolution: { readonly type: "none" };
      readonly expectedStatement: string;
      readonly expectedSource: CandidateSource;
      readonly sessionId: string;
    };

function approveCandidate(
  runtime: ProjectMemoryRuntime,
  workspace: string,
  id: string,
  approval: CandidateApproval,
): {
  readonly scope: ProjectMemoryScope;
  readonly candidate: ProjectMemoryCandidate;
  readonly memory: ProjectMemoryEntry;
} {
  validateCandidateId(id);
  return withWriteLock(runtime, workspace, (scope, state, filePath) => {
    const candidate = requirePendingCandidate(state, id);
    if (
      approval.channel === "interactive" &&
      (candidate.origin.type !== "current_turn_proposal" ||
        candidate.origin.proposal.sessionId !== approval.sessionId ||
        candidate.statement !== approval.expectedStatement ||
        candidate.sources.length !== 1 ||
        candidate.sources[0]?.sessionId !== approval.expectedSource.sessionId ||
        candidate.sources[0]?.messageId !== approval.expectedSource.messageId ||
        candidate.sources[0]?.quote !== approval.expectedSource.quote)
    ) {
      fail(
        `Error: project-memory candidate ${id} changed after it was displayed for interactive approval.`,
      );
    }
    const active = validateProjectMemoryGeneration(
      state.events,
      filePath,
      runtime.now(),
    ).filter((entry) => entry.status === "current" || entry.status === "stale");
    const duplicate = active.find(
      (entry) =>
        entry.text.trim().toLowerCase() === candidate.statement.toLowerCase(),
    );
    if (duplicate !== undefined) {
      fail(
        `Error: project-memory candidate ${id} duplicates active memory ${duplicate.id} and cannot be approved.`,
      );
    }
    const edited = candidate.statement !== candidate.originalStatement;
    const conflicts = edited ? [] : currentConflicts(candidate, active);
    const resolution = approval.resolution;
    if (edited && resolution.type === "none") {
      fail(
        `Error: edited candidate requires an explicit conflict decision. Approve with --keep or --supersede <active-memory-id>.`,
      );
    }
    if (conflicts.length > 0 && resolution.type === "none") {
      fail(
        `Error: project-memory candidate ${id} conflicts with ${conflicts.join(", ")}. Approve with --keep or --supersede <memory-id>.`,
      );
    }
    if (
      resolution.type === "supersede" &&
      !(edited
        ? active.some((entry) => entry.id === resolution.memoryId)
        : conflicts.includes(resolution.memoryId))
    ) {
      fail(
        `Error: ${resolution.memoryId} is not a current conflict for project-memory candidate ${id}.`,
      );
    }
    const createdAt = new Date(runtime.now()).toISOString();
    const memory: MemoryRecord = {
      id: `mem_${randomUUID()}`,
      text: validatedCandidateText(candidate.statement),
      source: {
        type: "user_approved",
        channel: approval.channel,
        evidence: `approved candidate ${id} from session ${candidateOriginSessionId(candidate)}`,
        candidateId: id,
      },
      createdAt,
      lastVerifiedAt: createdAt,
      supersedes: resolution.type === "supersede" ? [resolution.memoryId] : [],
      reviewAfter: null,
      expiresAt: null,
    };
    const event: CandidateApproveEvent = {
      version: PROJECT_MEMORY_SCHEMA_VERSION,
      type: "candidate_approve",
      targetId: id,
      memory,
    };
    const nextEvents = [...state.events, event];
    const entries = validateProjectMemoryGeneration(
      nextEvents,
      filePath,
      runtime.now(),
    );
    const next = replayCandidateEvents(nextEvents, filePath, runtime.now());
    appendProjectMemoryEvent(filePath, event);
    const approved = requireCandidate(next, id);
    const activeMemory = entries.find((entry) => entry.id === memory.id);
    /* v8 ignore next 3 -- generation validation above projects the candidate_approve memory atomically. */
    if (activeMemory === undefined) {
      throw new Error("approved candidate memory was not projected");
    }
    return { scope, candidate: approved, memory: activeMemory };
  });
}

export function approveProjectMemoryCandidate(
  runtime: ProjectMemoryRuntime,
  workspace: string,
  id: string,
  resolution: CandidateConflictResolution,
): ReturnType<typeof approveCandidate> {
  return approveCandidate(runtime, workspace, id, {
    channel: "cli",
    resolution,
  });
}

export function approveReviewedProjectMemoryCandidate(
  runtime: ProjectMemoryRuntime,
  workspace: string,
  id: string,
  expected: {
    readonly statement: string;
    readonly source: CandidateSource;
    readonly sessionId: string;
  },
): ReturnType<typeof approveCandidate> {
  return approveCandidate(runtime, workspace, id, {
    channel: "interactive",
    resolution: { type: "none" },
    expectedStatement: expected.statement,
    expectedSource: expected.source,
    sessionId: expected.sessionId,
  });
}

export function purgeProjectMemoryCandidate(
  runtime: ProjectMemoryRuntime,
  workspace: string,
  id: string,
  linkedMemoryId: string | null,
): { readonly scope: ProjectMemoryScope; readonly memoryId: string | null } {
  validateCandidateId(id);
  return withWriteLock(runtime, workspace, (scope, state, filePath) => {
    const candidate = requireCandidate(state, id);
    let rewritten: readonly ProjectMemoryEvent[];
    if (candidate.memoryId !== null) {
      if (linkedMemoryId !== candidate.memoryId) {
        fail(
          `Error: project-memory candidate ${id} is linked to memory ${candidate.memoryId}. Purge both explicitly with --purge-memory ${candidate.memoryId}.`,
        );
      }
      rewritten = projectMemoryEventsWithoutTarget(
        state.events,
        filePath,
        candidate.memoryId,
        {
          type: "user_explicit",
          channel: "cli",
          evidence: `memory candidates purge ${id}`,
        },
        runtime.now(),
      );
    } else {
      if (linkedMemoryId !== null) {
        fail(
          `Error: project-memory candidate ${id} has no linked active memory to purge.`,
        );
      }
      rewritten = eventsWithoutCandidateArtifacts(
        state.events,
        new Set([candidate.id]),
      );
    }
    replayCandidateEvents(rewritten, filePath, runtime.now());
    validateProjectMemoryGeneration(rewritten, filePath, runtime.now());
    replaceProjectMemoryEvents(filePath, rewritten);
    return { scope, memoryId: candidate.memoryId };
  });
}

export function clearProjectMemoryCandidates(
  runtime: ProjectMemoryRuntime,
  workspace: string,
  purge: boolean,
  purgeLinkedMemories: boolean,
): {
  readonly scope: ProjectMemoryScope;
  readonly cleared: number;
  readonly purgedMemoryCount: number;
} {
  return withWriteLock(runtime, workspace, (scope, state, filePath) => {
    if (!purge) {
      const pending = state.candidates.filter(
        (candidate) => candidate.status === "pending",
      );
      if (pending.length === 0) {
        return { scope, cleared: 0, purgedMemoryCount: 0 };
      }
      const event: ProjectMemoryEvent = {
        version: PROJECT_MEMORY_SCHEMA_VERSION,
        type: "candidate_reject",
        targetIds: pending.map((candidate) => candidate.id),
        reason: "cleared",
        createdAt: new Date(runtime.now()).toISOString(),
      };
      replayCandidateEvents([...state.events, event], filePath, runtime.now());
      appendProjectMemoryEvent(filePath, event);
      return { scope, cleared: pending.length, purgedMemoryCount: 0 };
    }

    const linked = state.candidates.filter(
      (
        candidate,
      ): candidate is ProjectMemoryCandidate & { readonly memoryId: string } =>
        candidate.memoryId !== null,
    );
    if (linked.length > 0 && !purgeLinkedMemories) {
      fail(
        `Error: ${linked.length} project-memory candidate ${linked.length === 1 ? "is" : "are"} linked to active memory. Purge both explicitly with --purge-memories.`,
      );
    }
    let rewritten = state.events;
    for (const candidate of linked) {
      rewritten = projectMemoryEventsWithoutTarget(
        rewritten,
        filePath,
        candidate.memoryId,
        {
          type: "user_explicit",
          channel: "cli",
          evidence: "memory candidates clear --purge --purge-memories",
        },
        runtime.now(),
      );
    }
    rewritten = eventsWithoutCandidateArtifacts(
      rewritten,
      new Set(state.candidates.map((candidate) => candidate.id)),
    );
    replayCandidateEvents(rewritten, filePath, runtime.now());
    validateProjectMemoryGeneration(rewritten, filePath, runtime.now());
    if (rewritten.length === 0) removeProjectMemoryEventFile(filePath);
    else replaceProjectMemoryEvents(filePath, rewritten);
    return {
      scope,
      cleared: state.candidates.length,
      purgedMemoryCount: linked.length,
    };
  });
}

export function failedCandidateExtractionOperation(options: {
  readonly operationId: string;
  readonly sessionId: string;
  readonly maxCostUsd: number;
  readonly createdAt: string;
  readonly finishedAt: string;
  readonly outcome: "failed" | "admission_rejected" | "cancelled";
  readonly providerId: ProviderId | null;
  readonly model: string | null;
  readonly usage: Usage | null;
  readonly costUsd: number | null;
  readonly attemptCount: number;
  readonly retryCount: number;
  readonly failure: CandidateExtractionFailure;
}): Exclude<CandidateExtractionOperation, { readonly outcome: "succeeded" }> {
  if (options.outcome === "admission_rejected") {
    return {
      operationId: options.operationId,
      sessionId: options.sessionId,
      trigger: "explicit_command",
      extractorVersion: 1,
      maxCostUsd: options.maxCostUsd,
      createdAt: options.createdAt,
      finishedAt: options.finishedAt,
      outcome: "admission_rejected",
      providerId: options.providerId,
      model: options.model,
      usage: null,
      costUsd: null,
      attemptCount: 0,
      retryCount: 0,
      resultCount: 0,
      failure: options.failure,
    };
  }
  if (options.outcome === "cancelled") {
    return {
      operationId: options.operationId,
      sessionId: options.sessionId,
      trigger: "explicit_command",
      extractorVersion: 1,
      maxCostUsd: options.maxCostUsd,
      createdAt: options.createdAt,
      finishedAt: options.finishedAt,
      outcome: "cancelled",
      providerId: options.providerId,
      model: options.model,
      usage: options.usage,
      costUsd: options.costUsd,
      attemptCount: options.attemptCount,
      retryCount: options.retryCount,
      resultCount: 0,
      failure: "cancelled",
    };
  }
  return {
    operationId: options.operationId,
    sessionId: options.sessionId,
    trigger: "explicit_command",
    extractorVersion: 1,
    maxCostUsd: options.maxCostUsd,
    createdAt: options.createdAt,
    finishedAt: options.finishedAt,
    outcome: "failed",
    providerId: options.providerId,
    model: options.model,
    usage: options.usage,
    costUsd: options.costUsd,
    attemptCount: options.attemptCount,
    retryCount: options.retryCount,
    resultCount: 0,
    failure: options.failure,
  };
}
