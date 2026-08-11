import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SessionMessage } from "../agent/session-message.ts";
import {
  type AgentId,
  type PersistedSubagentCanonicalResult,
  type SubagentAccountingSnapshot,
  type SubagentLifecyclePersistence,
  SubagentPersistenceError,
  type SubagentResultDelivery,
  type SubagentResultDeliveryReference,
  type SubagentRunId,
  type SubagentRunLineage,
  type SubagentRunMode,
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
  type AgentResultDeliveryDeliveredRecord,
  type AgentResultDeliveryPendingRecord,
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
  appendPendingAgentInput,
  createTranscriptObserver,
  ensureInterruptedTranscriptInitialized,
  ensureTranscriptExists,
  ensureTranscriptTerminal,
  readAgentTranscript,
  readAgentTranscriptMessages,
  readPendingAgentInputCount,
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

type AgentRunDeliveryState =
  | { readonly kind: "pending"; readonly delivery: SubagentResultDelivery }
  | { readonly kind: "delivered"; readonly delivery: SubagentResultDelivery };

type AgentRunTerminalState =
  | {
      readonly kind: "terminal";
      readonly mode: "foreground";
      readonly result: PersistedSubagentCanonicalResult;
      readonly terminal: AgentRunTerminalRecord;
    }
  | {
      readonly kind: "terminal";
      readonly mode: "background";
      readonly result: PersistedSubagentCanonicalResult;
      readonly terminal: AgentRunTerminalRecord;
      readonly delivery: AgentRunDeliveryState;
    };

type AgentRunState = AgentRunActiveState | AgentRunTerminalState;

type ReplayedAgentRunTerminalState =
  | Extract<AgentRunTerminalState, { readonly mode: "foreground" }>
  | (Omit<
      Extract<AgentRunTerminalState, { readonly mode: "background" }>,
      "delivery"
    > & {
      readonly delivery: { readonly kind: "missing" } | AgentRunDeliveryState;
    });

type ReplayedAgentRunState =
  | AgentRunActiveState
  | ReplayedAgentRunTerminalState
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
  readonly state: { readonly kind: string };
}

function assertUniqueAcceptance(
  runs: Iterable<IdentifiedAgentRun>,
  candidate: AgentRunAcceptedRecord,
): void {
  const existing = [...runs];
  const threadRuns = existing.filter(
    (run) => run.accepted.childAgentId === candidate.childAgentId,
  );
  if (candidate.lineage.kind === "root" && threadRuns.length > 0) {
    agentTreeError(`duplicate child agent id ${candidate.childAgentId}`);
  }
  for (const run of existing) {
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
  if (candidate.lineage.kind === "root") {
    return;
  }
  const previousRunId = candidate.lineage.previousRunId;
  const previous = existing.find(
    (run) => run.accepted.childRunId === previousRunId,
  );
  if (previous === undefined) {
    agentTreeError(`continuation references unknown run ${previousRunId}`);
  }
  if (previous.accepted.childAgentId !== candidate.childAgentId) {
    agentTreeError(
      `continuation run ${candidate.childRunId} changes child agent identity`,
    );
  }
  if (previous.state.kind !== "terminal") {
    agentTreeError(
      `continuation run ${candidate.childRunId} follows a non-terminal run`,
    );
  }
  if (threadRuns.at(-1) !== previous) {
    agentTreeError(
      `continuation run ${candidate.childRunId} does not follow the latest run`,
    );
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
  readonly mode: SubagentRunMode;
  readonly providerId: string;
  readonly model: string;
  readonly systemPrompt: string;
  readonly transcriptRef: string;
  readonly acceptedAt: string;
  readonly lineage: SubagentRunLineage;
  readonly status: AgentRunMutableStatus | SubagentTerminalStatus;
  readonly accounting: SubagentAccountingSnapshot;
  readonly result: PersistedSubagentCanonicalResult | null;
}

export interface AgentTreeHistory {
  readonly sessionId: string;
  readonly persistence: SubagentLifecyclePersistence;
  readonly entries: () => readonly AgentHistoryEntry[];
  readonly runs: (id: AgentId) => readonly AgentHistoryEntry[];
  readonly pendingResultDeliveries: (
    parentMessages: readonly SessionMessage[],
  ) => readonly SubagentResultDelivery[];
  readonly deliveredResult: (delivery: SubagentResultDeliveryReference) => void;
  readonly transcript: (entry: AgentHistoryEntry) => string;
  readonly messages: (entry: AgentHistoryEntry) => readonly SessionMessage[];
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
  runs: Map<SubagentRunId, T>,
  childAgentId: AgentId,
  childRunId: SubagentRunId,
): T {
  const run = runs.get(childRunId);
  if (run === undefined || run.accepted.childAgentId !== childAgentId) {
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

function copyResultDelivery(
  delivery: SubagentResultDelivery,
): SubagentResultDelivery {
  return { ...delivery };
}

function copyDeliveryState(
  state: AgentRunDeliveryState,
): AgentRunDeliveryState {
  return { kind: state.kind, delivery: copyResultDelivery(state.delivery) };
}

function canonicalResultSha256(
  result: PersistedSubagentCanonicalResult,
): string {
  const commonResult = {
    delegationId: result.delegationId,
    childAgentId: result.childAgentId,
    childRunId: result.childRunId,
    task: result.task,
    transcriptRef: result.transcriptRef,
    usage: {
      inputTokens: result.usage.inputTokens,
      cachedInputTokens: result.usage.cachedInputTokens,
      uncachedInputTokens: result.usage.uncachedInputTokens,
      outputTokens: result.usage.outputTokens,
    },
    turns: result.turns,
    costUsd: result.costUsd,
    pendingInputCount: result.pendingInputCount,
  } satisfies Omit<
    PersistedSubagentCanonicalResult,
    "status" | "finalText" | "error"
  >;
  const canonicalResult: PersistedSubagentCanonicalResult =
    result.status === "completed"
      ? {
          ...commonResult,
          status: result.status,
          finalText: result.finalText,
          error: result.error,
        }
      : {
          ...commonResult,
          status: result.status,
          finalText: result.finalText,
          error: result.error,
        };
  const serialized = JSON.stringify(canonicalResult);
  return createHash("sha256").update(serialized).digest("hex");
}

function resultDeliveryProjection(
  result: PersistedSubagentCanonicalResult,
): string {
  const notice = `Background subagent ${result.childAgentId} ${result.status}.`;
  return [
    "<keel_runtime_context>",
    notice,
    "Use agent_wait with this stable agent ID when its canonical result is needed.",
    "This is runtime lifecycle state, not a new user request or evidence that the child conclusion is correct.",
    "</keel_runtime_context>",
  ].join("\n");
}

function createResultDelivery(
  sessionId: string,
  result: PersistedSubagentCanonicalResult,
): SubagentResultDelivery {
  return {
    sessionId,
    delegationId: result.delegationId,
    childAgentId: result.childAgentId,
    childRunId: result.childRunId,
    canonicalResultSha256: canonicalResultSha256(result),
    projection: resultDeliveryProjection(result),
  };
}

function sameResultDeliveryReference(
  left: SubagentResultDeliveryReference,
  right: SubagentResultDeliveryReference,
): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.delegationId === right.delegationId &&
    left.childAgentId === right.childAgentId &&
    left.childRunId === right.childRunId &&
    left.canonicalResultSha256 === right.canonicalResultSha256
  );
}

function assertDeliveryIdentity(
  run: ReplayedAgentRun | MutableAgentRun,
  reference: SubagentResultDeliveryReference,
): void {
  if (
    reference.delegationId !== run.accepted.delegationId ||
    reference.childAgentId !== run.accepted.childAgentId ||
    reference.childRunId !== run.accepted.childRunId
  ) {
    agentTreeError(
      `agent ${run.accepted.childAgentId} delivery identity mismatches acceptance`,
    );
  }
}

function replayAgentRuns(
  mutations: readonly AgentTreeMutationRecord[],
  sessionId: string,
): Map<SubagentRunId, ReplayedAgentRun> {
  const runs = new Map<SubagentRunId, ReplayedAgentRun>();
  for (const mutation of mutations) {
    switch (mutation.type) {
      case "delegation_rejected":
        break;
      case "agent_run_accepted":
        assertUniqueAcceptance(runs.values(), mutation);
        runs.set(mutation.childRunId, {
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
        run.state =
          run.accepted.mode === "foreground"
            ? {
                kind: "terminal",
                mode: "foreground",
                result: run.state.result,
                terminal: mutation,
              }
            : {
                kind: "terminal",
                mode: "background",
                result: run.state.result,
                terminal: mutation,
                delivery: { kind: "missing" },
              };
        break;
      }
      case "agent_result_delivery_pending": {
        const run = requireRun(
          runs,
          mutation.delivery.childAgentId,
          mutation.delivery.childRunId,
        );
        assertDeliveryIdentity(run, mutation.delivery);
        if (
          run.state.kind !== "terminal" ||
          run.state.mode !== "background" ||
          run.state.delivery.kind !== "missing"
        ) {
          agentTreeError(
            `agent ${mutation.delivery.childAgentId} recorded delivery outside one terminal background lifecycle`,
          );
        }
        const expected = createResultDelivery(sessionId, run.state.result);
        if (
          !sameResultDeliveryReference(expected, mutation.delivery) ||
          expected.projection !== mutation.delivery.projection
        ) {
          agentTreeError(
            `agent ${mutation.delivery.childAgentId} delivery mismatches its canonical result`,
          );
        }
        run.state = {
          ...run.state,
          delivery: {
            kind: "pending",
            delivery: copyResultDelivery(mutation.delivery),
          },
        };
        break;
      }
      case "agent_result_delivery_delivered": {
        const run = requireRun(
          runs,
          mutation.childAgentId,
          mutation.childRunId,
        );
        assertDeliveryIdentity(run, mutation);
        if (
          run.state.kind !== "terminal" ||
          run.state.mode !== "background" ||
          run.state.delivery.kind !== "pending" ||
          !sameResultDeliveryReference(run.state.delivery.delivery, mutation)
        ) {
          agentTreeError(
            `agent ${mutation.childAgentId} delivery completed without one matching pending projection`,
          );
        }
        run.state = {
          ...run.state,
          delivery: {
            kind: "delivered",
            delivery: copyResultDelivery(run.state.delivery.delivery),
          },
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
    pendingInputCount: snapshot.pendingInputCount,
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

function appendPendingResultDelivery(input: {
  readonly sessionId: string;
  readonly filePath: string;
  readonly runtime: SessionStoreRuntime;
  readonly result: PersistedSubagentCanonicalResult;
  readonly writer: DurableJsonlWriter;
}): SubagentResultDelivery {
  const delivery = createResultDelivery(input.sessionId, input.result);
  const record: AgentResultDeliveryPendingRecord = {
    schemaVersion: AGENT_TREE_SCHEMA_VERSION,
    type: "agent_result_delivery_pending",
    timestamp: timestamp(input.runtime),
    delivery: copyResultDelivery(delivery),
  };
  input.writer.append(input.filePath, record, "agent tree");
  return delivery;
}

function appendDeliveredResult(input: {
  readonly filePath: string;
  readonly runtime: SessionStoreRuntime;
  readonly run: MutableAgentRun;
  readonly writer: DurableJsonlWriter;
  readonly reference: SubagentResultDeliveryReference;
}): void {
  assertDeliveryIdentity(input.run, input.reference);
  const state = input.run.state;
  if (state.kind !== "terminal" || state.mode !== "background") {
    agentTreeError(
      `child agent ${input.run.accepted.childAgentId} has no result delivery lifecycle`,
    );
  }
  if (state.delivery.kind === "delivered") {
    if (
      !sameResultDeliveryReference(state.delivery.delivery, input.reference)
    ) {
      agentTreeError(
        `child agent ${input.run.accepted.childAgentId} delivery confirmation mismatches the delivered result`,
      );
    }
    return;
  }
  if (
    state.delivery.kind !== "pending" ||
    !sameResultDeliveryReference(state.delivery.delivery, input.reference)
  ) {
    agentTreeError(
      `child agent ${input.run.accepted.childAgentId} has no matching pending result delivery`,
    );
  }
  const record: AgentResultDeliveryDeliveredRecord = {
    schemaVersion: AGENT_TREE_SCHEMA_VERSION,
    type: "agent_result_delivery_delivered",
    timestamp: timestamp(input.runtime),
    sessionId: input.reference.sessionId,
    delegationId: input.reference.delegationId,
    childAgentId: input.reference.childAgentId,
    childRunId: input.reference.childRunId,
    canonicalResultSha256: input.reference.canonicalResultSha256,
  };
  input.writer.append(input.filePath, record, "agent tree");
  input.run.state = {
    ...state,
    delivery: {
      kind: "delivered",
      delivery: copyResultDelivery(state.delivery.delivery),
    },
  };
}

function appendCanonicalTerminal(input: {
  readonly sessionId: string;
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
    result.pendingInputCount,
    input.transcriptInitialization,
  );
  const terminal = appendTerminalEvent({
    filePath: input.filePath,
    runtime: input.runtime,
    writer: input.writer,
    result,
  });
  input.run.state =
    input.run.accepted.mode === "foreground"
      ? {
          kind: "terminal",
          mode: "foreground",
          result: copyCanonicalResult(result),
          terminal,
        }
      : {
          kind: "terminal",
          mode: "background",
          result: copyCanonicalResult(result),
          terminal,
          delivery: {
            kind: "pending",
            delivery: appendPendingResultDelivery({
              sessionId: input.sessionId,
              filePath: input.filePath,
              runtime: input.runtime,
              result,
              writer: input.writer,
            }),
          },
        };
  return copyCanonicalResult(result);
}

function repairInterruptedRuns(input: {
  readonly sessionId: string;
  readonly filePath: string;
  readonly transcriptsDirectory: string;
  readonly runtime: SessionStoreRuntime;
  readonly runs: ReadonlyMap<SubagentRunId, ReplayedAgentRun>;
  readonly writer: DurableJsonlWriter;
}): Map<SubagentRunId, MutableAgentRun> {
  const repairedRuns = new Map<SubagentRunId, MutableAgentRun>();
  for (const run of input.runs.values()) {
    const transcriptPath = transcriptFilePath(
      input.transcriptsDirectory,
      run.accepted.childRunId,
    );
    if (run.state.kind === "terminal") {
      ensureTranscriptTerminal(
        input.writer,
        transcriptPath,
        run.accepted,
        run.state.result.status,
        run.state.result.pendingInputCount,
        { kind: "required" },
      );
      const repairedRun: MutableAgentRun =
        run.state.mode === "foreground"
          ? {
              accepted: run.accepted,
              state: {
                kind: "terminal",
                mode: "foreground",
                result: copyCanonicalResult(run.state.result),
                terminal: run.state.terminal,
              },
            }
          : {
              accepted: run.accepted,
              state: {
                kind: "terminal",
                mode: "background",
                result: copyCanonicalResult(run.state.result),
                terminal: run.state.terminal,
                delivery:
                  run.state.delivery.kind === "missing"
                    ? {
                        kind: "pending",
                        delivery: appendPendingResultDelivery({
                          sessionId: input.sessionId,
                          filePath: input.filePath,
                          runtime: input.runtime,
                          result: run.state.result,
                          writer: input.writer,
                        }),
                      }
                    : copyDeliveryState(run.state.delivery),
              },
            };
      repairedRuns.set(run.accepted.childRunId, repairedRun);
      continue;
    }
    if (run.state.kind === "result") {
      ensureTranscriptTerminal(
        input.writer,
        transcriptPath,
        run.accepted,
        run.state.result.status,
        run.state.result.pendingInputCount,
        run.state.transcriptInitialization,
      );
      const terminal = appendTerminalEvent({
        filePath: input.filePath,
        runtime: input.runtime,
        writer: input.writer,
        result: run.state.result,
      });
      const repairedRun: MutableAgentRun = {
        accepted: run.accepted,
        state:
          run.accepted.mode === "foreground"
            ? {
                kind: "terminal",
                mode: "foreground",
                result: copyCanonicalResult(run.state.result),
                terminal,
              }
            : {
                kind: "terminal",
                mode: "background",
                result: copyCanonicalResult(run.state.result),
                terminal,
                delivery: {
                  kind: "pending",
                  delivery: appendPendingResultDelivery({
                    sessionId: input.sessionId,
                    filePath: input.filePath,
                    runtime: input.runtime,
                    result: run.state.result,
                    writer: input.writer,
                  }),
                },
              },
      };
      repairedRuns.set(run.accepted.childRunId, repairedRun);
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
    const pendingInputCount = readPendingAgentInputCount(
      transcriptPath,
      run.accepted,
    );
    appendCanonicalTerminal({
      sessionId: input.sessionId,
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
        pendingInputCount,
        ...accounting,
      },
    });
    repairedRuns.set(run.accepted.childRunId, interruptedRun);
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
      return {
        kind: "terminal",
        status: run.state.result.status,
        pendingInputCount: run.state.result.pendingInputCount,
      };
  }
}

function historyEntries(
  runs: ReadonlyMap<SubagentRunId, MutableAgentRun>,
): readonly AgentHistoryEntry[] {
  const latestRuns = new Map<AgentId, MutableAgentRun>();
  for (const run of runs.values()) {
    latestRuns.set(run.accepted.childAgentId, run);
  }
  return [...latestRuns.values()].map((run, offset) => ({
    index: offset + 1,
    delegationId: run.accepted.delegationId,
    childAgentId: run.accepted.childAgentId,
    childRunId: run.accepted.childRunId,
    parentRunId: run.accepted.parentRunId,
    parentToolCallId: run.accepted.parentToolCallId,
    task: run.accepted.task,
    focusPaths: [...run.accepted.focusPaths],
    mode: run.accepted.mode,
    providerId: run.accepted.providerId,
    model: run.accepted.model,
    systemPrompt: run.accepted.systemPrompt,
    transcriptRef: run.accepted.transcriptRef,
    acceptedAt: run.accepted.timestamp,
    lineage: run.accepted.lineage,
    ...historyEntryState(run),
  }));
}

function threadRunEntries(
  runs: ReadonlyMap<SubagentRunId, MutableAgentRun>,
  childAgentId: AgentId,
): readonly AgentHistoryEntry[] {
  return [...runs.values()]
    .filter((run) => run.accepted.childAgentId === childAgentId)
    .map((run, offset) => ({
      index: offset + 1,
      delegationId: run.accepted.delegationId,
      childAgentId: run.accepted.childAgentId,
      childRunId: run.accepted.childRunId,
      parentRunId: run.accepted.parentRunId,
      parentToolCallId: run.accepted.parentToolCallId,
      task: run.accepted.task,
      focusPaths: [...run.accepted.focusPaths],
      mode: run.accepted.mode,
      providerId: run.accepted.providerId,
      model: run.accepted.model,
      systemPrompt: run.accepted.systemPrompt,
      transcriptRef: run.accepted.transcriptRef,
      acceptedAt: run.accepted.timestamp,
      lineage: run.accepted.lineage,
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
  const replayedRuns = replayAgentRuns(records.mutations, options.sessionId);
  reconcileUnacceptedTranscripts(
    transcriptsDirectory,
    new Set(replayedRuns.keys()),
    writer.syncDirectory,
  );
  const runs = repairInterruptedRuns({
    sessionId: options.sessionId,
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
        transcriptRef: `agent-transcript:${options.sessionId}/${lifecycle.childRunId}`,
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
        lifecycle.childRunId,
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
      runs.set(lifecycle.childRunId, run);
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
      const pendingInput: SubagentRunPersistence["pendingInput"] = (messages) =>
        persist(() =>
          appendPendingAgentInput(writer, transcriptPath, messages),
        );
      const terminal = (snapshot: SubagentTerminalSnapshot): void => {
        const current = requireMutableRun();
        const state = requireUnsettledRun(current);
        const transcriptInitialization: TranscriptInitializationExpectation =
          state.kind === "queued" ? { kind: "optional" } : { kind: "required" };
        persist(() =>
          appendCanonicalTerminal({
            sessionId: options.sessionId,
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
        pendingInput,
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
            pendingInput,
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

  const deliveredResult = (delivery: SubagentResultDeliveryReference): void => {
    if (delivery.sessionId !== options.sessionId) {
      agentTreeError(
        `subagent result delivery belongs to session ${delivery.sessionId}, not ${options.sessionId}`,
      );
    }
    const run = requireRun(runs, delivery.childAgentId, delivery.childRunId);
    persist(() =>
      appendDeliveredResult({
        filePath,
        runtime: options.runtime,
        run,
        writer,
        reference: delivery,
      }),
    );
  };

  const pendingResultDeliveries = (
    parentMessages: readonly SessionMessage[],
  ): readonly SubagentResultDelivery[] => {
    const observedDelegations = new Set<string>();
    for (const message of parentMessages) {
      if (
        message.role !== "user" ||
        message.subagentResultDelivery === undefined ||
        message.subagentResultDelivery.sessionId !== options.sessionId
      ) {
        continue;
      }
      const observed = message.subagentResultDelivery;
      if (observedDelegations.has(observed.delegationId)) {
        agentTreeError(
          `parent ledger contains duplicate subagent result delivery ${observed.delegationId}`,
        );
      }
      observedDelegations.add(observed.delegationId);
      const run = requireRun(runs, observed.childAgentId, observed.childRunId);
      assertDeliveryIdentity(run, observed);
      if (
        run.state.kind !== "terminal" ||
        run.state.mode !== "background" ||
        !sameResultDeliveryReference(run.state.delivery.delivery, observed) ||
        run.state.delivery.delivery.projection !== message.content
      ) {
        agentTreeError(
          `parent delivery for child agent ${observed.childAgentId} mismatches the durable projection`,
        );
      }
      deliveredResult(observed);
    }
    return [...runs.values()].flatMap((run) =>
      run.state.kind === "terminal" &&
      run.state.mode === "background" &&
      run.state.delivery.kind === "pending"
        ? [copyResultDelivery(run.state.delivery.delivery)]
        : [],
    );
  };

  return {
    sessionId: options.sessionId,
    persistence,
    entries: () => historyEntries(runs),
    runs: (id) => threadRunEntries(runs, id),
    pendingResultDeliveries,
    deliveredResult,
    transcript: (entry) => {
      const run = requireRun(runs, entry.childAgentId, entry.childRunId);
      return readAgentTranscript(
        transcriptFilePath(transcriptsDirectory, run.accepted.childRunId),
        run.accepted,
        transcriptTerminalExpectation(run),
      );
    },
    messages: (entry) => {
      const lineage: MutableAgentRun[] = [];
      let run = requireRun(runs, entry.childAgentId, entry.childRunId);
      for (;;) {
        lineage.push(run);
        if (run.accepted.lineage.kind === "root") break;
        run = requireRun(
          runs,
          entry.childAgentId,
          run.accepted.lineage.previousRunId,
        );
      }
      let messages: readonly SessionMessage[] = [];
      for (const continuedRun of lineage.reverse()) {
        messages = readAgentTranscriptMessages(
          transcriptFilePath(
            transcriptsDirectory,
            continuedRun.accepted.childRunId,
          ),
          continuedRun.accepted,
          transcriptTerminalExpectation(continuedRun),
          messages,
        );
      }
      return messages;
    },
  };
}
