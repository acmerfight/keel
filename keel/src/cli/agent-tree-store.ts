import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type AgentId,
  type PersistedSubagentCanonicalResult,
  type SubagentAccountingSnapshot,
  type SubagentLifecyclePersistence,
  SubagentPersistenceError,
  type SubagentRunId,
  type SubagentRunningPersistence,
  type SubagentRunPersistence,
  type SubagentTerminalSnapshot,
  type SubagentTerminalStatus,
} from "../agent/subagent-lifecycle.ts";
import {
  agentTreeError,
  createDurableJsonlWriter,
  type DurableJsonlWriter,
  IndeterminateJsonlWriteError,
  type JsonlWriteRuntime,
  parseJsonLine,
  readRepairableJsonl,
} from "./agent-tree-store/jsonl.ts";
import {
  AGENT_TREE_MAX_BYTES,
  AGENT_TREE_SCHEMA_VERSION,
  type AgentResultRecord,
  type AgentRunAcceptedRecord,
  type AgentRunAccountingRecord,
  type AgentRunRunningRecord,
  type AgentRunTerminalRecord,
  type AgentTreeHeaderRecord,
  type AgentTreeMutationRecord,
  copyAccounting,
  copyCanonicalResult,
  headerRecordSchema,
  mutationRecordSchema,
  zeroUsage,
} from "./agent-tree-store/model.ts";
import {
  createTranscriptObserver,
  ensureInterruptedTranscriptInitialized,
  ensureTranscriptExists,
  ensureTranscriptTerminal,
  readAgentTranscript,
  reconcileUnacceptedTranscripts,
  removeTranscript,
  type TranscriptInitializationExpectation,
  type TranscriptTerminalExpectation,
  transcriptFilePath,
} from "./agent-tree-store/transcript.ts";
import { redactTextForPersistence } from "./persistence-redaction.ts";
import type { SessionStoreRuntime } from "./session-store.ts";
import { sessionFilePath } from "./session-store.ts";

type AgentRunMutableStatus = "queued" | "running";

type AgentRunActiveState =
  | {
      readonly kind: "queued";
      readonly accounting: SubagentAccountingSnapshot;
    }
  | {
      readonly kind: "running";
      readonly accounting: SubagentAccountingSnapshot;
      readonly transcriptInitialization: TranscriptInitializationExpectation;
    };

type AgentRunTerminalState = {
  readonly kind: "terminal";
  readonly result: PersistedSubagentCanonicalResult;
  readonly terminal: AgentRunTerminalRecord;
};

type AgentRunState = AgentRunActiveState | AgentRunTerminalState;

type ReplayedAgentRunState =
  | AgentRunState
  | {
      readonly kind: "result";
      readonly result: PersistedSubagentCanonicalResult;
      readonly transcriptInitialization: TranscriptInitializationExpectation;
    };

interface MutableAgentRun {
  readonly accepted: AgentRunAcceptedRecord;
  state: AgentRunState;
}

interface ReplayedAgentRun {
  readonly accepted: AgentRunAcceptedRecord;
  state: ReplayedAgentRunState;
}

interface IdentifiedAgentRun {
  readonly accepted: AgentRunAcceptedRecord;
}

function assertUniqueAcceptance(
  runs: Iterable<IdentifiedAgentRun>,
  candidate: AgentRunAcceptedRecord,
): void {
  for (const run of runs) {
    if (run.accepted.childAgentId === candidate.childAgentId) {
      agentTreeError(`duplicate child agent id ${candidate.childAgentId}`);
    }
    if (run.accepted.childRunId === candidate.childRunId) {
      agentTreeError(`duplicate child run id ${candidate.childRunId}`);
    }
    if (run.accepted.delegationId === candidate.delegationId) {
      agentTreeError(`duplicate delegation id ${candidate.delegationId}`);
    }
    if (
      run.accepted.parentRunId === candidate.parentRunId &&
      run.accepted.parentToolCallId === candidate.parentToolCallId
    ) {
      agentTreeError(
        `duplicate parent tool call ${candidate.parentRunId}/${candidate.parentToolCallId}`,
      );
    }
  }
}

export interface AgentHistoryEntry {
  readonly index: number;
  readonly delegationId: string;
  readonly childAgentId: AgentId;
  readonly childRunId: SubagentRunId;
  readonly parentRunId: string;
  readonly parentToolCallId: string;
  readonly task: string;
  readonly focusPaths: readonly string[];
  readonly providerId: string;
  readonly model: string;
  readonly transcriptRef: string;
  readonly acceptedAt: string;
  readonly status: AgentRunMutableStatus | SubagentTerminalStatus;
  readonly accounting: SubagentAccountingSnapshot;
  readonly result: PersistedSubagentCanonicalResult | null;
}

export interface AgentTreeHistory {
  readonly sessionId: string;
  readonly persistence: SubagentLifecyclePersistence;
  readonly entries: () => readonly AgentHistoryEntry[];
  readonly transcript: (entry: AgentHistoryEntry) => string;
}

export interface AgentTreeStoreRuntime extends SessionStoreRuntime {
  readonly agentTreeJsonlWrite?: JsonlWriteRuntime;
}

function timestamp(runtime: SessionStoreRuntime): string {
  return new Date(runtime.now()).toISOString();
}

function persistenceFailure(caught: unknown): never {
  throw new SubagentPersistenceError(String(caught));
}

function persist<T>(operation: () => T): T {
  try {
    return operation();
  } catch (caught) {
    persistenceFailure(caught);
  }
}

function readAgentTreeRecords(filePath: string): {
  readonly header: AgentTreeHeaderRecord;
  readonly mutations: readonly AgentTreeMutationRecord[];
} {
  const lines = readRepairableJsonl(filePath, AGENT_TREE_MAX_BYTES)
    .split("\n")
    .filter((line) => line !== "");
  const firstLine = lines[0];
  if (firstLine === undefined) {
    agentTreeError(`agent tree ${filePath} is empty`);
  }
  const parsedHeader = headerRecordSchema.safeParse(
    parseJsonLine(filePath, firstLine, 1),
  );
  if (!parsedHeader.success) {
    agentTreeError(
      `invalid agent tree header ${filePath}: ${parsedHeader.error.message}`,
    );
  }
  const mutations: AgentTreeMutationRecord[] = [];
  for (const [offset, line] of lines.slice(1).entries()) {
    const lineNumber = offset + 2;
    const parsed = mutationRecordSchema.safeParse(
      parseJsonLine(filePath, line, lineNumber),
    );
    if (!parsed.success) {
      agentTreeError(
        `invalid agent tree record ${filePath} line ${lineNumber}: ${parsed.error.message}`,
      );
    }
    mutations.push(parsed.data);
  }
  return { header: parsedHeader.data, mutations };
}

function requireRun<T extends IdentifiedAgentRun>(
  runs: Map<AgentId, T>,
  childAgentId: AgentId,
  childRunId: SubagentRunId,
): T {
  const run = runs.get(childAgentId);
  if (run === undefined || run.accepted.childRunId !== childRunId) {
    agentTreeError(
      `agent tree references unknown run ${childAgentId}/${childRunId}`,
    );
  }
  return run;
}

function assertResultIdentity(
  run: IdentifiedAgentRun,
  result: PersistedSubagentCanonicalResult,
): void {
  if (
    result.delegationId !== run.accepted.delegationId ||
    result.task !== run.accepted.task ||
    result.transcriptRef !== run.accepted.transcriptRef
  ) {
    agentTreeError(
      `agent ${result.childAgentId} result identity mismatches acceptance`,
    );
  }
}

function replayAgentRuns(
  mutations: readonly AgentTreeMutationRecord[],
): Map<AgentId, ReplayedAgentRun> {
  const runs = new Map<AgentId, ReplayedAgentRun>();
  for (const mutation of mutations) {
    switch (mutation.type) {
      case "delegation_rejected":
        break;
      case "agent_run_accepted":
        assertUniqueAcceptance(runs.values(), mutation);
        runs.set(mutation.childAgentId, {
          accepted: mutation,
          state: {
            kind: "queued",
            accounting: { usage: zeroUsage(), turns: 0, costUsd: 0 },
          },
        });
        break;
      case "agent_run_running": {
        const run = requireRun(
          runs,
          mutation.childAgentId,
          mutation.childRunId,
        );
        if (run.state.kind !== "queued") {
          agentTreeError(`agent ${mutation.childAgentId} started twice`);
        }
        run.state = {
          kind: "running",
          accounting: copyAccounting(run.state.accounting),
          transcriptInitialization: { kind: "optional" },
        };
        break;
      }
      case "agent_run_accounting": {
        const run = requireRun(
          runs,
          mutation.childAgentId,
          mutation.childRunId,
        );
        if (run.state.kind !== "running") {
          agentTreeError(
            `agent ${mutation.childAgentId} recorded accounting outside a running lifecycle`,
          );
        }
        run.state = {
          kind: "running",
          accounting: copyAccounting(mutation),
          transcriptInitialization: { kind: "required" },
        };
        break;
      }
      case "agent_result": {
        const run = requireRun(
          runs,
          mutation.result.childAgentId,
          mutation.result.childRunId,
        );
        if (run.state.kind === "result" || run.state.kind === "terminal") {
          agentTreeError(
            `agent ${mutation.result.childAgentId} has duplicate result`,
          );
        }
        assertResultIdentity(run, mutation.result);
        if (
          run.state.kind === "queued" &&
          mutation.result.status !== "cancelled" &&
          mutation.result.status !== "interrupted"
        ) {
          agentTreeError(
            `agent ${mutation.result.childAgentId} ${mutation.result.status} before execution started`,
          );
        }
        const transcriptInitialization: TranscriptInitializationExpectation =
          run.state.kind === "queued"
            ? { kind: "optional" }
            : { kind: "required" };
        run.state = {
          kind: "result",
          result: copyCanonicalResult(mutation.result),
          transcriptInitialization,
        };
        break;
      }
      case "agent_run_terminal": {
        const run = requireRun(
          runs,
          mutation.childAgentId,
          mutation.childRunId,
        );
        if (run.state.kind !== "result") {
          agentTreeError(
            `agent ${mutation.childAgentId} terminated without exactly one result`,
          );
        }
        if (run.state.result.status !== mutation.status) {
          agentTreeError(
            `agent ${mutation.childAgentId} terminal status mismatches result`,
          );
        }
        run.state = {
          kind: "terminal",
          result: run.state.result,
          terminal: mutation,
        };
        break;
      }
    }
  }
  return runs;
}

function canonicalResult(
  accepted: AgentRunAcceptedRecord,
  snapshot: SubagentTerminalSnapshot,
): PersistedSubagentCanonicalResult {
  const outcome =
    snapshot.status === "completed"
      ? {
          status: snapshot.status,
          finalText: redactTextForPersistence(snapshot.finalText),
          error: snapshot.error,
        }
      : {
          status: snapshot.status,
          finalText: snapshot.finalText,
          error: redactTextForPersistence(snapshot.error),
        };
  return {
    delegationId: accepted.delegationId,
    childAgentId: accepted.childAgentId,
    childRunId: accepted.childRunId,
    task: accepted.task,
    transcriptRef: accepted.transcriptRef,
    usage: { ...snapshot.usage },
    turns: snapshot.turns,
    costUsd: snapshot.costUsd,
    ...outcome,
  };
}

function appendTerminalEvent(input: {
  readonly filePath: string;
  readonly runtime: SessionStoreRuntime;
  readonly writer: DurableJsonlWriter;
  readonly result: PersistedSubagentCanonicalResult;
}): AgentRunTerminalRecord {
  const terminalRecord: AgentRunTerminalRecord = {
    schemaVersion: AGENT_TREE_SCHEMA_VERSION,
    type: "agent_run_terminal",
    timestamp: timestamp(input.runtime),
    childAgentId: input.result.childAgentId,
    childRunId: input.result.childRunId,
    status: input.result.status,
  };
  input.writer.append(input.filePath, terminalRecord, "agent tree");
  return terminalRecord;
}

function appendCanonicalTerminal(input: {
  readonly filePath: string;
  readonly transcriptPath: string;
  readonly runtime: SessionStoreRuntime;
  readonly run: MutableAgentRun;
  readonly writer: DurableJsonlWriter;
  readonly snapshot: SubagentTerminalSnapshot;
  readonly transcriptInitialization: TranscriptInitializationExpectation;
}): PersistedSubagentCanonicalResult {
  const result = canonicalResult(input.run.accepted, input.snapshot);
  const resultRecord: AgentResultRecord = {
    schemaVersion: AGENT_TREE_SCHEMA_VERSION,
    type: "agent_result",
    timestamp: timestamp(input.runtime),
    result: copyCanonicalResult(result),
  };
  input.writer.append(input.filePath, resultRecord, "agent tree");
  ensureTranscriptTerminal(
    input.writer,
    input.transcriptPath,
    input.run.accepted,
    result.status,
    input.transcriptInitialization,
  );
  const terminal = appendTerminalEvent({
    filePath: input.filePath,
    runtime: input.runtime,
    writer: input.writer,
    result,
  });
  input.run.state = {
    kind: "terminal",
    result: copyCanonicalResult(result),
    terminal,
  };
  return copyCanonicalResult(result);
}

function repairInterruptedRuns(input: {
  readonly filePath: string;
  readonly transcriptsDirectory: string;
  readonly runtime: SessionStoreRuntime;
  readonly runs: ReadonlyMap<AgentId, ReplayedAgentRun>;
  readonly writer: DurableJsonlWriter;
}): Map<AgentId, MutableAgentRun> {
  const repairedRuns = new Map<AgentId, MutableAgentRun>();
  for (const run of input.runs.values()) {
    const transcriptPath = transcriptFilePath(
      input.transcriptsDirectory,
      run.accepted.childAgentId,
    );
    if (run.state.kind === "terminal") {
      ensureTranscriptTerminal(
        input.writer,
        transcriptPath,
        run.accepted,
        run.state.result.status,
        { kind: "required" },
      );
      repairedRuns.set(run.accepted.childAgentId, {
        accepted: run.accepted,
        state: {
          kind: "terminal",
          result: copyCanonicalResult(run.state.result),
          terminal: run.state.terminal,
        },
      });
      continue;
    }
    if (run.state.kind === "result") {
      ensureTranscriptTerminal(
        input.writer,
        transcriptPath,
        run.accepted,
        run.state.result.status,
        run.state.transcriptInitialization,
      );
      const terminal = appendTerminalEvent({
        filePath: input.filePath,
        runtime: input.runtime,
        writer: input.writer,
        result: run.state.result,
      });
      repairedRuns.set(run.accepted.childAgentId, {
        accepted: run.accepted,
        state: {
          kind: "terminal",
          result: copyCanonicalResult(run.state.result),
          terminal,
        },
      });
      continue;
    }
    const accounting = copyAccounting(run.state.accounting);
    const transcriptInitialization: TranscriptInitializationExpectation =
      run.state.kind === "queued"
        ? { kind: "optional" }
        : run.state.transcriptInitialization;
    const interruptedRun: MutableAgentRun = {
      accepted: run.accepted,
      state:
        run.state.kind === "queued"
          ? { kind: "queued", accounting }
          : {
              kind: "running",
              accounting,
              transcriptInitialization,
            },
    };
    ensureInterruptedTranscriptInitialized(
      input.writer,
      transcriptPath,
      run.accepted,
      transcriptInitialization,
    );
    appendCanonicalTerminal({
      filePath: input.filePath,
      transcriptPath,
      runtime: input.runtime,
      run: interruptedRun,
      writer: input.writer,
      transcriptInitialization: { kind: "required" },
      snapshot: {
        status: "interrupted",
        finalText: null,
        error:
          "Child was interrupted when its foreground session owner exited.",
        ...accounting,
      },
    });
    repairedRuns.set(run.accepted.childAgentId, interruptedRun);
  }
  return repairedRuns;
}

function historyEntryState(run: MutableAgentRun): {
  readonly status: AgentRunMutableStatus | SubagentTerminalStatus;
  readonly accounting: SubagentAccountingSnapshot;
  readonly result: PersistedSubagentCanonicalResult | null;
} {
  switch (run.state.kind) {
    case "queued":
    case "running":
      return {
        status: run.state.kind,
        accounting: copyAccounting(run.state.accounting),
        result: null,
      };
    case "terminal":
      return {
        status: run.state.result.status,
        accounting: copyAccounting(run.state.result),
        result: copyCanonicalResult(run.state.result),
      };
  }
}

function transcriptTerminalExpectation(
  run: MutableAgentRun,
): TranscriptTerminalExpectation {
  switch (run.state.kind) {
    case "queued":
    case "running":
      return { kind: "open" };
    case "terminal":
      return { kind: "terminal", status: run.state.result.status };
  }
}

function historyEntries(
  runs: ReadonlyMap<AgentId, MutableAgentRun>,
): readonly AgentHistoryEntry[] {
  return [...runs.values()].map((run, offset) => ({
    index: offset + 1,
    delegationId: run.accepted.delegationId,
    childAgentId: run.accepted.childAgentId,
    childRunId: run.accepted.childRunId,
    parentRunId: run.accepted.parentRunId,
    parentToolCallId: run.accepted.parentToolCallId,
    task: run.accepted.task,
    focusPaths: [...run.accepted.focusPaths],
    providerId: run.accepted.providerId,
    model: run.accepted.model,
    transcriptRef: run.accepted.transcriptRef,
    acceptedAt: run.accepted.timestamp,
    ...historyEntryState(run),
  }));
}

function requireUnsettledRun(
  run: MutableAgentRun,
): Extract<AgentRunState, { readonly kind: "queued" | "running" }> {
  if (run.state.kind === "queued" || run.state.kind === "running") {
    return run.state;
  }
  agentTreeError(`child agent ${run.accepted.childAgentId} is terminal`);
}

export function createAgentTreeHistory(options: {
  readonly sessionId: string;
  readonly runtime: AgentTreeStoreRuntime;
}): AgentTreeHistory {
  const sessionDirectory = dirname(
    sessionFilePath(options.runtime, options.sessionId),
  );
  const agentsDirectory = join(sessionDirectory, "agents");
  const transcriptsDirectory = join(agentsDirectory, "transcripts");
  const filePath = join(agentsDirectory, "events.jsonl");
  const writer = createDurableJsonlWriter(options.runtime.agentTreeJsonlWrite);
  writer.ensureDirectory(transcriptsDirectory);
  if (!existsSync(filePath)) {
    const header: AgentTreeHeaderRecord = {
      schemaVersion: AGENT_TREE_SCHEMA_VERSION,
      type: "agent_tree",
      sessionId: options.sessionId,
      createdAt: timestamp(options.runtime),
    };
    writer.create(filePath, header, "agent tree");
  }
  const records = readAgentTreeRecords(filePath);
  if (records.header.sessionId !== options.sessionId) {
    agentTreeError(
      `agent tree session ${records.header.sessionId} does not match ${options.sessionId}`,
    );
  }
  const replayedRuns = replayAgentRuns(records.mutations);
  reconcileUnacceptedTranscripts(
    transcriptsDirectory,
    new Set(replayedRuns.keys()),
    writer.syncDirectory,
  );
  const runs = repairInterruptedRuns({
    filePath,
    transcriptsDirectory,
    runtime: options.runtime,
    runs: replayedRuns,
    writer,
  });

  const persistence: SubagentLifecyclePersistence = {
    accepted: (lifecycle): SubagentRunPersistence => {
      const acceptedRecord: AgentRunAcceptedRecord = {
        schemaVersion: AGENT_TREE_SCHEMA_VERSION,
        type: "agent_run_accepted",
        timestamp: timestamp(options.runtime),
        transcriptRef: `agent-transcript:${options.sessionId}/${lifecycle.childAgentId}`,
        ...lifecycle,
        task: redactTextForPersistence(lifecycle.task),
        focusPaths: lifecycle.focusPaths.map(redactTextForPersistence),
        providerId: redactTextForPersistence(lifecycle.providerId),
        model: redactTextForPersistence(lifecycle.model),
        systemPrompt: redactTextForPersistence(lifecycle.systemPrompt),
      };
      assertUniqueAcceptance(runs.values(), acceptedRecord);
      const transcriptPath = transcriptFilePath(
        transcriptsDirectory,
        lifecycle.childAgentId,
      );
      ensureTranscriptExists(writer, transcriptPath, acceptedRecord);
      try {
        writer.append(filePath, acceptedRecord, "agent tree");
      } catch (caught) {
        try {
          removeTranscript(transcriptPath, writer.syncDirectory);
        } catch (cleanupFailure) {
          persistenceFailure(cleanupFailure);
        }
        if (caught instanceof IndeterminateJsonlWriteError) {
          persistenceFailure(caught);
        }
        throw caught;
      }
      const run: MutableAgentRun = {
        accepted: acceptedRecord,
        state: {
          kind: "queued",
          accounting: { usage: zeroUsage(), turns: 0, costUsd: 0 },
        },
      };
      runs.set(lifecycle.childAgentId, run);
      const requireMutableRun = (): MutableAgentRun =>
        requireRun(runs, lifecycle.childAgentId, lifecycle.childRunId);
      const transcript = createTranscriptObserver(writer, transcriptPath);
      const persistedTranscript = {
        initialize: (messages: Parameters<typeof transcript.initialize>[0]) =>
          persist(() => transcript.initialize(messages)),
        append: (messages: Parameters<typeof transcript.append>[0]) =>
          persist(() => transcript.append(messages)),
        replace: (messages: Parameters<typeof transcript.replace>[0]) =>
          persist(() => transcript.replace(messages)),
      };
      const terminal = (snapshot: SubagentTerminalSnapshot): void => {
        const current = requireMutableRun();
        const state = requireUnsettledRun(current);
        const transcriptInitialization: TranscriptInitializationExpectation =
          state.kind === "queued" ? { kind: "optional" } : { kind: "required" };
        persist(() =>
          appendCanonicalTerminal({
            filePath,
            transcriptPath,
            runtime: options.runtime,
            run: current,
            writer,
            snapshot,
            transcriptInitialization,
          }),
        );
      };
      return {
        transcriptRef: acceptedRecord.transcriptRef,
        transcript: persistedTranscript,
        running: (): SubagentRunningPersistence => {
          const current = requireMutableRun();
          const state = requireUnsettledRun(current);
          if (state.kind !== "queued") {
            agentTreeError(
              `child agent ${lifecycle.childAgentId} started twice`,
            );
          }
          const record: AgentRunRunningRecord = {
            schemaVersion: AGENT_TREE_SCHEMA_VERSION,
            type: "agent_run_running",
            timestamp: timestamp(options.runtime),
            childAgentId: lifecycle.childAgentId,
            childRunId: lifecycle.childRunId,
          };
          persist(() => writer.append(filePath, record, "agent tree"));
          current.state = {
            kind: "running",
            accounting: copyAccounting(state.accounting),
            transcriptInitialization: { kind: "optional" },
          };
          return {
            transcriptRef: acceptedRecord.transcriptRef,
            transcript: persistedTranscript,
            accounting: (accounting) => {
              const running = requireMutableRun();
              if (running.state.kind !== "running") {
                agentTreeError(
                  `child agent ${lifecycle.childAgentId} is terminal`,
                );
              }
              const accountingRecord: AgentRunAccountingRecord = {
                schemaVersion: AGENT_TREE_SCHEMA_VERSION,
                type: "agent_run_accounting",
                timestamp: timestamp(options.runtime),
                childAgentId: lifecycle.childAgentId,
                childRunId: lifecycle.childRunId,
                ...copyAccounting(accounting),
              };
              persist(() =>
                writer.append(filePath, accountingRecord, "agent tree"),
              );
              running.state = {
                kind: "running",
                accounting: copyAccounting(accounting),
                transcriptInitialization: { kind: "required" },
              };
            },
            terminal,
          };
        },
        terminal,
      };
    },
    rejected: (lifecycle) => {
      try {
        writer.append(
          filePath,
          {
            schemaVersion: AGENT_TREE_SCHEMA_VERSION,
            type: "delegation_rejected",
            timestamp: timestamp(options.runtime),
            ...lifecycle,
            task: redactTextForPersistence(lifecycle.task),
            reason: redactTextForPersistence(lifecycle.reason),
          },
          "agent tree",
        );
      } catch (caught) {
        if (caught instanceof IndeterminateJsonlWriteError) {
          persistenceFailure(caught);
        }
        throw caught;
      }
    },
  };

  return {
    sessionId: options.sessionId,
    persistence,
    entries: () => historyEntries(runs),
    transcript: (entry) => {
      const run = requireRun(runs, entry.childAgentId, entry.childRunId);
      return readAgentTranscript(
        transcriptFilePath(transcriptsDirectory, run.accepted.childAgentId),
        run.accepted,
        transcriptTerminalExpectation(run),
      );
    },
  };
}
