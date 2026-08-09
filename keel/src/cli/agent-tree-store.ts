import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type PersistedSubagentCanonicalResult,
  type SubagentAccountingSnapshot,
  type SubagentLifecyclePersistence,
  SubagentPersistenceError,
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
  ensureTranscriptExists,
  ensureTranscriptTerminal,
  readAgentTranscript,
  reconcileUnacceptedTranscripts,
  removeTranscript,
  type TranscriptTerminalExpectation,
  transcriptFilePath,
} from "./agent-tree-store/transcript.ts";
import type { SessionStoreRuntime } from "./session-store.ts";
import { sessionFilePath } from "./session-store.ts";

type AgentRunMutableStatus = "queued" | "running";

type AgentRunState =
  | {
      readonly kind: "queued" | "running";
      readonly accounting: SubagentAccountingSnapshot;
    }
  | {
      readonly kind: "result";
      readonly result: PersistedSubagentCanonicalResult;
    }
  | {
      readonly kind: "terminal";
      readonly result: PersistedSubagentCanonicalResult;
      readonly terminal: AgentRunTerminalRecord;
    };

interface MutableAgentRun {
  readonly accepted: AgentRunAcceptedRecord;
  state: AgentRunState;
}

export interface AgentHistoryEntry {
  readonly index: number;
  readonly delegationId: string;
  readonly childAgentId: string;
  readonly childRunId: string;
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
  readonly transcript: (childAgentId: string) => string;
}

export interface AgentTreeStoreRuntime extends SessionStoreRuntime {
  readonly agentTreeJsonlWrite?: JsonlWriteRuntime;
}

function timestamp(runtime: SessionStoreRuntime): string {
  return new Date(runtime.now()).toISOString();
}

function persistenceFailure(caught: unknown): never {
  if (caught instanceof SubagentPersistenceError) throw caught;
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
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index];
    if (line === undefined) continue;
    const parsed = mutationRecordSchema.safeParse(
      parseJsonLine(filePath, line, index + 1),
    );
    if (!parsed.success) {
      agentTreeError(
        `invalid agent tree record ${filePath} line ${index + 1}: ${parsed.error.message}`,
      );
    }
    mutations.push(parsed.data);
  }
  return { header: parsedHeader.data, mutations };
}

function requireRun(
  runs: Map<string, MutableAgentRun>,
  childAgentId: string,
  childRunId: string,
): MutableAgentRun {
  const run = runs.get(childAgentId);
  if (run === undefined || run.accepted.childRunId !== childRunId) {
    agentTreeError(
      `agent tree references unknown run ${childAgentId}/${childRunId}`,
    );
  }
  return run;
}

function assertResultIdentity(
  run: MutableAgentRun,
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
): Map<string, MutableAgentRun> {
  const runs = new Map<string, MutableAgentRun>();
  for (const mutation of mutations) {
    switch (mutation.type) {
      case "delegation_rejected":
        break;
      case "agent_run_accepted":
        if (runs.has(mutation.childAgentId)) {
          agentTreeError(`duplicate accepted agent ${mutation.childAgentId}`);
        }
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
        run.state = {
          kind: "result",
          result: copyCanonicalResult(mutation.result),
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
  return {
    delegationId: accepted.delegationId,
    childAgentId: accepted.childAgentId,
    childRunId: accepted.childRunId,
    task: accepted.task,
    transcriptRef: accepted.transcriptRef,
    ...snapshot,
  };
}

function appendTerminalEvent(input: {
  readonly filePath: string;
  readonly runtime: SessionStoreRuntime;
  readonly run: MutableAgentRun;
  readonly writer: DurableJsonlWriter;
  readonly result: PersistedSubagentCanonicalResult;
}): void {
  const terminalRecord: AgentRunTerminalRecord = {
    schemaVersion: AGENT_TREE_SCHEMA_VERSION,
    type: "agent_run_terminal",
    timestamp: timestamp(input.runtime),
    childAgentId: input.result.childAgentId,
    childRunId: input.result.childRunId,
    status: input.result.status,
  };
  input.writer.append(input.filePath, terminalRecord, "agent tree");
  input.run.state = {
    kind: "terminal",
    result: copyCanonicalResult(input.result),
    terminal: terminalRecord,
  };
}

function appendCanonicalTerminal(input: {
  readonly filePath: string;
  readonly transcriptPath: string;
  readonly runtime: SessionStoreRuntime;
  readonly run: MutableAgentRun;
  readonly writer: DurableJsonlWriter;
  readonly snapshot: SubagentTerminalSnapshot;
}): PersistedSubagentCanonicalResult {
  const result = canonicalResult(input.run.accepted, input.snapshot);
  const resultRecord: AgentResultRecord = {
    schemaVersion: AGENT_TREE_SCHEMA_VERSION,
    type: "agent_result",
    timestamp: timestamp(input.runtime),
    result: copyCanonicalResult(result),
  };
  input.writer.append(input.filePath, resultRecord, "agent tree");
  input.run.state = { kind: "result", result: copyCanonicalResult(result) };
  ensureTranscriptTerminal(
    input.writer,
    input.transcriptPath,
    input.run.accepted,
    result.status,
  );
  appendTerminalEvent({
    filePath: input.filePath,
    runtime: input.runtime,
    run: input.run,
    writer: input.writer,
    result,
  });
  return copyCanonicalResult(result);
}

function unsettledAccounting(run: MutableAgentRun): SubagentAccountingSnapshot {
  if (run.state.kind === "queued" || run.state.kind === "running") {
    return copyAccounting(run.state.accounting);
  }
  agentTreeError(`agent ${run.accepted.childAgentId} is already settled`);
}

function repairInterruptedRuns(input: {
  readonly filePath: string;
  readonly transcriptsDirectory: string;
  readonly runtime: SessionStoreRuntime;
  readonly runs: Map<string, MutableAgentRun>;
  readonly writer: DurableJsonlWriter;
}): void {
  for (const run of input.runs.values()) {
    const transcriptPath = transcriptFilePath(
      input.transcriptsDirectory,
      run.accepted.childAgentId,
    );
    ensureTranscriptExists(input.writer, transcriptPath, run.accepted);
    if (run.state.kind === "terminal") {
      ensureTranscriptTerminal(
        input.writer,
        transcriptPath,
        run.accepted,
        run.state.result.status,
      );
      continue;
    }
    if (run.state.kind === "result") {
      ensureTranscriptTerminal(
        input.writer,
        transcriptPath,
        run.accepted,
        run.state.result.status,
      );
      appendTerminalEvent({
        filePath: input.filePath,
        runtime: input.runtime,
        run,
        writer: input.writer,
        result: run.state.result,
      });
      continue;
    }
    const accounting = unsettledAccounting(run);
    appendCanonicalTerminal({
      filePath: input.filePath,
      transcriptPath,
      runtime: input.runtime,
      run,
      writer: input.writer,
      snapshot: {
        status: "interrupted",
        finalText: null,
        error:
          "Child was interrupted when its foreground session owner exited.",
        ...accounting,
      },
    });
  }
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
    case "result":
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
    case "result":
    case "terminal":
      return { kind: "terminal", status: run.state.result.status };
  }
}

function historyEntries(
  runs: ReadonlyMap<string, MutableAgentRun>,
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
  mkdirSync(transcriptsDirectory, { recursive: true, mode: 0o700 });
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
  const runs = replayAgentRuns(records.mutations);
  reconcileUnacceptedTranscripts(transcriptsDirectory, new Set(runs.keys()));
  repairInterruptedRuns({
    filePath,
    transcriptsDirectory,
    runtime: options.runtime,
    runs,
    writer,
  });

  const persistence: SubagentLifecyclePersistence = {
    accepted: (lifecycle): SubagentRunPersistence => {
      if (runs.has(lifecycle.childAgentId)) {
        agentTreeError(`duplicate child agent ${lifecycle.childAgentId}`);
      }
      const acceptedRecord: AgentRunAcceptedRecord = {
        schemaVersion: AGENT_TREE_SCHEMA_VERSION,
        type: "agent_run_accepted",
        timestamp: timestamp(options.runtime),
        transcriptRef: `agent-transcript:${options.sessionId}/${lifecycle.childAgentId}`,
        ...lifecycle,
      };
      const transcriptPath = transcriptFilePath(
        transcriptsDirectory,
        lifecycle.childAgentId,
      );
      ensureTranscriptExists(writer, transcriptPath, acceptedRecord);
      try {
        writer.append(filePath, acceptedRecord, "agent tree");
      } catch (caught) {
        try {
          removeTranscript(transcriptPath);
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
      const terminal = (
        snapshot: SubagentTerminalSnapshot,
      ): PersistedSubagentCanonicalResult => {
        const current = requireMutableRun();
        requireUnsettledRun(current);
        return persist(() =>
          appendCanonicalTerminal({
            filePath,
            transcriptPath,
            runtime: options.runtime,
            run: current,
            writer,
            snapshot,
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
          };
          return {
            transcriptRef: acceptedRecord.transcriptRef,
            transcript: persistedTranscript,
            accounting: (accounting) => {
              const running = requireMutableRun();
              const runningState = requireUnsettledRun(running);
              if (runningState.kind !== "running") {
                agentTreeError(
                  `child agent ${lifecycle.childAgentId} is not running`,
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
              };
            },
            terminal,
          };
        },
        terminal,
      };
    },
    rejected: (lifecycle) => {
      writer.append(
        filePath,
        {
          schemaVersion: AGENT_TREE_SCHEMA_VERSION,
          type: "delegation_rejected",
          timestamp: timestamp(options.runtime),
          ...lifecycle,
        },
        "agent tree",
      );
    },
  };

  return {
    sessionId: options.sessionId,
    persistence,
    entries: () => historyEntries(runs),
    transcript: (childAgentId) => {
      const run = runs.get(childAgentId);
      if (run === undefined)
        agentTreeError(`unknown child agent ${childAgentId}`);
      return readAgentTranscript(
        transcriptFilePath(transcriptsDirectory, childAgentId),
        run.accepted,
        transcriptTerminalExpectation(run),
      );
    },
  };
}
