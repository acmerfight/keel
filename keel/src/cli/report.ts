import { writeFileSync } from "node:fs";
import type { AgentEvent, CostReport } from "../agent/events.ts";
import { errorMessage, KeelError, type KeelErrorCode } from "../core/error.ts";
import type { SubagentTerminalStatus } from "../core/subagent-status.ts";
import type { UndoProtectionSummary } from "../core/undo-protection.ts";
import type {
  ActiveSkillStatus,
  SkillActivationRecord,
} from "../skills/model.ts";
import type { AgentMemoryOperation } from "../tools/memory.ts";
import type { EndEvent } from "./output.ts";
import { redactTextForPersistence } from "./persistence-redaction.ts";
import type {
  ActiveProjectMemoryEntry,
  ProjectMemoryScope,
} from "./project-memory.ts";
import {
  accountModelOperations,
  type RunReportContextCompaction,
  type RunReportModelOperation,
  type RunReportModelUsage,
  type RunReportTask,
} from "./report-events.ts";
import type { SkillPolicyReport } from "./skill-user-config.ts";

// The report schema is consumed by external tooling (the eval runner and any
// script comparing runs across keel versions). Bump schemaVersion on any
// breaking change to the shape.
interface RunReportInputBase {
  readonly tasks: readonly RunReportTask[];
  readonly modelOperations: readonly RunReportModelOperation[];
  readonly subagents: RunReportSubagents;
  readonly durationMs: number;
  readonly contextCompactions: readonly RunReportContextCompaction[];
  readonly skillActivations: readonly SkillActivationRecord[];
  readonly activeSkills: readonly RunReportActiveSkill[];
  readonly skillCatalog: RunReportSkillCatalog;
  readonly skillPolicy: SkillPolicyReport;
  readonly undoProtection: UndoProtectionSummary;
  readonly memory: RunReportMemory;
  readonly goalOutcome?: RunReportGoalOutcome;
}

interface RunReportSubagentRun {
  readonly delegationId: string;
  readonly childRunId: string;
  readonly status: "queued" | "running" | SubagentTerminalStatus;
}

export type RunReportSubagents =
  | {
      readonly status: "observed";
      readonly runs: readonly RunReportSubagentRun[];
    }
  | {
      readonly status: "unavailable";
      readonly runs?: never;
    };

type RunReportInput = RunReportInputBase & {
  readonly outcome:
    | {
        readonly status: "completed";
        readonly end: EndEventWithCost;
      }
    | {
        readonly status: "failed";
        readonly error: unknown;
        readonly maxCostUsd?: number;
        readonly sessionId?: string;
      };
};

export type RunReportMemory =
  | {
      readonly status: "disabled";
      readonly scope: null;
      readonly loadedIds: readonly [];
      readonly loadedEntries: readonly [];
      readonly renderedBytes: 0;
      readonly estimatedTokens: 0;
      readonly operations: readonly [];
      readonly error?: never;
    }
  | {
      readonly status: "available";
      readonly scope: ProjectMemoryScope;
      readonly loadedIds: readonly string[];
      readonly loadedEntries: readonly RunReportMemoryEntry[];
      readonly renderedBytes: number;
      readonly estimatedTokens: number;
      readonly operations: readonly RunReportMemoryOperation[];
      readonly error?: never;
    }
  | {
      readonly status: "error";
      readonly scope: ProjectMemoryScope | null;
      readonly loadedIds: readonly string[];
      readonly loadedEntries: readonly RunReportMemoryEntry[];
      readonly renderedBytes: number;
      readonly estimatedTokens: number;
      readonly operations: readonly RunReportMemoryOperation[];
      readonly error: string;
    };

export interface RunReportMemoryEntry {
  readonly id: string;
  readonly status: ActiveProjectMemoryEntry["status"];
  readonly source:
    | {
        readonly type: "user_explicit";
        readonly channel: "agent" | "cli";
        readonly candidateId: null;
      }
    | {
        readonly type: "user_approved";
        readonly channel: "cli" | "interactive";
        readonly candidateId: string;
      };
  readonly createdAt: string;
  readonly lastVerifiedAt: string;
  readonly supersedes: readonly string[];
  readonly supersededBy: null;
  readonly reviewAfter: string | null;
  readonly expiresAt: string | null;
}

export function projectMemoryReportEntry(
  entry: ActiveProjectMemoryEntry,
): RunReportMemoryEntry {
  return {
    id: entry.id,
    status: entry.status,
    source:
      entry.source.type === "user_approved"
        ? {
            type: entry.source.type,
            channel: entry.source.channel,
            candidateId: entry.source.candidateId,
          }
        : {
            type: entry.source.type,
            channel: entry.source.channel,
            candidateId: null,
          },
    createdAt: entry.createdAt,
    lastVerifiedAt: entry.lastVerifiedAt,
    supersedes: entry.supersedes,
    supersededBy: entry.supersededBy,
    reviewAfter: entry.reviewAfter,
    expiresAt: entry.expiresAt,
  };
}

export type RunReportMemoryOperation = AgentMemoryOperation;

interface RunReportSkillCatalog {
  readonly exposed: number;
  readonly omitted: number;
  readonly total: number;
  readonly budgetChars: number;
  readonly usedChars: number;
}

interface RunReportActiveSkill {
  readonly name: string;
  readonly digest: string;
  readonly trigger: "model_selected" | "user_explicit";
  readonly diskStatus: "current" | "changed_on_disk" | "missing_on_disk";
}

export type RunReportGoalOutcome =
  | {
      readonly sessionId: string;
      readonly status: "completed";
      readonly reason: string;
      readonly evidenceKind:
        | "command"
        | "assertion_evaluator"
        | "user_override";
    }
  | {
      readonly sessionId: string;
      readonly status: "blocked" | "budget_limited" | "usage_limited";
      readonly reason: string;
      readonly evidenceKind?: never;
    };

type RunReportFailureCategory = KeelErrorCode | "unexpected_error";

interface RunReportFailure {
  readonly category: RunReportFailureCategory;
  readonly message: string;
  readonly sessionId?: string;
}

interface RunReportBase {
  readonly schemaVersion: 22;
  readonly tasks: readonly RunReportTask[];
  readonly humanInterventionCount: number;
  readonly modelOperations: readonly RunReportModelOperation[];
  readonly subagents: RunReportSubagents;
  readonly modelOperationCount: number;
  readonly providerRequestAttemptCount: number;
  readonly modelsUsed: readonly {
    readonly provider: string;
    readonly model: string;
  }[];
  readonly usageByModel: readonly RunReportModelUsage[];
  readonly agentLoopTurns: number;
  readonly usage: Extract<AgentEvent, { readonly type: "end" }>["usage"];
  readonly durationMs: number;
  readonly costUsd: number;
  readonly costBudgetUsd?: number;
  readonly costOvershootUsd: number;
  readonly contextCompactions: readonly RunReportContextCompaction[];
  readonly skillActivations: readonly SkillActivationRecord[];
  readonly activeSkills: readonly RunReportActiveSkill[];
  readonly skillCatalog: RunReportSkillCatalog;
  readonly skillPolicy: SkillPolicyReport;
  readonly undoProtection: UndoProtectionSummary;
  readonly memory: RunReportMemory;
  readonly goalOutcome?: RunReportGoalOutcome;
}

type RunReport = RunReportBase &
  (
    | {
        readonly stopReason: "failed";
        readonly failure: RunReportFailure;
      }
    | {
        readonly stopReason: string;
        readonly failure?: never;
      }
  );

type EndEventWithCost = EndEvent & { readonly cost: CostReport };

export class RunReportWriteError extends Error {
  constructor(filePath: string, error: unknown) {
    super(
      `Error: cannot write report to ${filePath}: ${reportWriteCause(error)}`,
    );
    this.name = "RunReportWriteError";
  }
}

function reportWriteCause(error: unknown): string {
  return errorMessage(error).replace(/^Error: /u, "");
}

export function assertEndEventHasCost(
  end: EndEvent,
): asserts end is EndEventWithCost {
  /* v8 ignore next 3: --report enables cost tracking before the run starts. */
  if (end.cost === undefined) {
    throw new Error("run report requires cost tracking to be enabled");
  }
}

export function writeRunReport(filePath: string, input: RunReportInput): void {
  const accounting = accountModelOperations(input.modelOperations);
  const outcome = input.outcome;
  const costBudgetUsd =
    outcome.status === "completed"
      ? outcome.end.cost.budget.kind === "unbounded"
        ? undefined
        : outcome.end.cost.budget.maxUsd
      : outcome.maxCostUsd;
  const costOvershootUsd =
    outcome.status === "completed"
      ? outcome.end.cost.budget.kind === "budget_limited"
        ? outcome.end.cost.budget.overshootUsd
        : 0
      : Math.max(0, accounting.costUsd - (outcome.maxCostUsd ?? Infinity));
  const reportBase: RunReportBase = {
    schemaVersion: 22,
    tasks: input.tasks,
    humanInterventionCount: input.tasks.reduce(
      (total, task) => total + task.humanInterventionCount,
      0,
    ),
    modelOperations: accounting.modelOperations,
    subagents: input.subagents,
    modelOperationCount: accounting.modelOperationCount,
    providerRequestAttemptCount: accounting.providerRequestAttemptCount,
    modelsUsed: accounting.modelsUsed,
    usageByModel: accounting.usageByModel,
    agentLoopTurns: accounting.agentLoopTurns,
    usage: accounting.usage,
    durationMs: input.durationMs,
    costUsd: accounting.costUsd,
    ...(costBudgetUsd !== undefined ? { costBudgetUsd } : {}),
    costOvershootUsd,
    contextCompactions: input.contextCompactions,
    skillActivations: input.skillActivations,
    activeSkills: input.activeSkills,
    skillCatalog: input.skillCatalog,
    skillPolicy: input.skillPolicy,
    undoProtection: input.undoProtection,
    memory: input.memory,
    ...(input.goalOutcome !== undefined
      ? { goalOutcome: input.goalOutcome }
      : {}),
  };
  const report: RunReport =
    outcome.status === "completed"
      ? { ...reportBase, stopReason: outcome.end.stopReason }
      : {
          ...reportBase,
          stopReason: "failed",
          failure: runReportFailure(outcome.error, outcome.sessionId),
        };
  try {
    writeFileSync(filePath, `${JSON.stringify(report)}\n`, "utf8");
  } catch (error) {
    throw new RunReportWriteError(filePath, error);
  }
}

export function writeRunReportBestEffort(
  filePath: string,
  input: RunReportInput,
  onWriteError: (error: unknown) => void,
): void {
  try {
    writeRunReport(filePath, input);
  } catch (error) {
    onWriteError(error);
  }
}

const MAX_RUN_REPORT_FAILURE_MESSAGE_CHARS = 2_000;

function runReportFailure(
  error: unknown,
  sessionId: string | undefined,
): RunReportFailure {
  const redactedMessage = redactTextForPersistence(errorMessage(error));
  const message =
    redactedMessage.length <= MAX_RUN_REPORT_FAILURE_MESSAGE_CHARS
      ? redactedMessage
      : `${redactedMessage.slice(0, MAX_RUN_REPORT_FAILURE_MESSAGE_CHARS - 3)}...`;
  return {
    category: error instanceof KeelError ? error.code : "unexpected_error",
    message,
    ...(sessionId !== undefined ? { sessionId } : {}),
  };
}

export function reportActiveSkills(
  statuses: readonly ActiveSkillStatus[],
): readonly RunReportActiveSkill[] {
  return statuses.map(({ activation, diskStatus }) => ({
    name: activation.qualifiedName,
    digest: activation.digest,
    trigger: activation.trigger,
    diskStatus,
  }));
}
