import { writeFileSync } from "node:fs";
import type { AgentEvent, CostReport } from "../agent/events.ts";
import { errorMessage } from "../core/error.ts";
import type { UndoProtectionSummary } from "../core/undo-protection.ts";
import type {
  ActiveSkillStatus,
  SkillActivationRecord,
} from "../skills/model.ts";
import type { EndEvent } from "./output.ts";
import type { ProjectMemoryEntry } from "./project-memory.ts";
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
interface RunReportInput {
  readonly tasks: readonly RunReportTask[];
  readonly modelOperations: readonly RunReportModelOperation[];
  readonly end: EndEventWithCost;
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

export interface RunReportMemory {
  readonly enabled: boolean;
  readonly scope: { readonly kind: "project"; readonly id: string } | null;
  readonly loadedIds: readonly string[];
  readonly loadedEntries: readonly RunReportMemoryEntry[];
  readonly renderedBytes: number;
  readonly estimatedTokens?: number;
  readonly operations: readonly RunReportMemoryOperation[];
  readonly error?: string;
}

export interface RunReportMemoryEntry {
  readonly id: string;
  readonly status: ProjectMemoryEntry["status"];
  readonly source: {
    readonly type: "user_explicit";
    readonly channel: "agent" | "cli";
  };
  readonly createdAt: string;
  readonly lastVerifiedAt: string;
  readonly supersedes: readonly string[];
  readonly supersededBy: string | null;
  readonly reviewAfter: string | null;
  readonly expiresAt: string | null;
}

export function projectMemoryReportEntry(
  entry: ProjectMemoryEntry,
): RunReportMemoryEntry {
  return {
    id: entry.id,
    status: entry.status,
    source: {
      type: entry.source.type,
      channel: entry.source.channel,
    },
    createdAt: entry.createdAt,
    lastVerifiedAt: entry.lastVerifiedAt,
    supersedes: entry.supersedes,
    supersededBy: entry.supersededBy,
    reviewAfter: entry.reviewAfter,
    expiresAt: entry.expiresAt,
  };
}

export type RunReportMemoryOperation =
  | {
      readonly operation: "add";
      readonly id: string;
      readonly scope: { readonly kind: "project"; readonly id: string };
      readonly outcome: "saved";
    }
  | {
      readonly operation: "forget";
      readonly id: string;
      readonly scope: { readonly kind: "project"; readonly id: string };
      readonly outcome: "forgotten";
    };

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

export interface RunReportGoalOutcome {
  readonly sessionId: string;
  readonly status: "blocked" | "budget_limited" | "usage_limited" | "completed";
  readonly reason: string;
  readonly evidenceKind?: "command" | "assertion_evaluator" | "user_override";
}

interface RunReport {
  readonly schemaVersion: 15;
  readonly tasks: readonly RunReportTask[];
  readonly humanInterventionCount: number;
  readonly modelOperations: readonly RunReportModelOperation[];
  readonly modelOperationCount: number;
  readonly providerRequestAttemptCount: number;
  readonly modelsUsed: readonly {
    readonly provider: string;
    readonly model: string;
  }[];
  readonly usageByModel: readonly RunReportModelUsage[];
  readonly agentLoopTurns: number;
  readonly stopReason: string;
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
  const costBudgetUsd = input.end.cost.maxUsd;
  const report: RunReport = {
    schemaVersion: 15,
    tasks: input.tasks,
    humanInterventionCount: input.tasks.reduce(
      (total, task) => total + task.humanInterventionCount,
      0,
    ),
    modelOperations: accounting.modelOperations,
    modelOperationCount: accounting.modelOperationCount,
    providerRequestAttemptCount: accounting.providerRequestAttemptCount,
    modelsUsed: accounting.modelsUsed,
    usageByModel: accounting.usageByModel,
    agentLoopTurns: accounting.agentLoopTurns,
    stopReason: input.end.stopReason,
    usage: accounting.usage,
    durationMs: input.durationMs,
    costUsd: accounting.costUsd,
    ...(costBudgetUsd !== undefined ? { costBudgetUsd } : {}),
    costOvershootUsd:
      costBudgetUsd === undefined
        ? 0
        : Math.max(0, accounting.costUsd - costBudgetUsd),
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
  try {
    writeFileSync(filePath, `${JSON.stringify(report)}\n`, "utf8");
  } catch (error) {
    throw new RunReportWriteError(filePath, error);
  }
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
