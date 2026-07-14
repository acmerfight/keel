import { writeFileSync } from "node:fs";
import type { AgentEvent, CostReport } from "../agent/events.ts";
import { errorMessage } from "../core/error.ts";
import type { UndoProtectionSummary } from "../core/undo-protection.ts";
import type {
  ActiveSkillStatus,
  SkillActivationRecord,
} from "../skills/model.ts";
import type { EndEvent } from "./output.ts";
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
  readonly goalOutcome?: RunReportGoalOutcome;
}

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
  readonly schemaVersion: 11;
  readonly tasks: readonly RunReportTask[];
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
    schemaVersion: 11,
    tasks: input.tasks,
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
