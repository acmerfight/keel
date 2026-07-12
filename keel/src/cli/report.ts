import { writeFileSync } from "node:fs";
import type { AgentEvent, CostReport } from "../agent/events.ts";
import { errorMessage } from "../core/error.ts";
import type { UndoProtectionSummary } from "../core/undo-protection.ts";
import type {
  ActiveSkillStatus,
  SkillActivationRecord,
} from "../skills/model.ts";
import type { EndEvent } from "./output.ts";
import type { RunReportContextCompaction } from "./report-events.ts";

// The report schema is consumed by external tooling (the eval runner and any
// script comparing runs across keel versions). Bump schemaVersion on any
// breaking change to the shape.
interface RunReportInput {
  readonly usageByModel: readonly RunReportModelUsage[];
  readonly end: EndEventWithCost;
  readonly durationMs: number;
  readonly contextCompactions: readonly RunReportContextCompaction[];
  readonly skillActivations: readonly SkillActivationRecord[];
  readonly activeSkills: readonly RunReportActiveSkill[];
  readonly skillCatalog: RunReportSkillCatalog;
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

interface RunReportModelUsage {
  readonly provider: string;
  readonly model: string;
  readonly turns: number;
  readonly usage: Extract<AgentEvent, { readonly type: "end" }>["usage"];
  readonly costUsd: number;
}

interface RunReport {
  readonly schemaVersion: 8;
  readonly modelsUsed: readonly {
    readonly provider: string;
    readonly model: string;
  }[];
  readonly usageByModel: readonly RunReportModelUsage[];
  readonly turns: number;
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
  const cost = input.end.cost;
  const report: RunReport = {
    schemaVersion: 8,
    modelsUsed: input.usageByModel.map((entry) => ({
      provider: entry.provider,
      model: entry.model,
    })),
    usageByModel: input.usageByModel.map((entry) => ({
      provider: entry.provider,
      model: entry.model,
      turns: entry.turns,
      usage: entry.usage,
      costUsd: entry.costUsd,
    })),
    turns: input.end.turns,
    stopReason: input.end.stopReason,
    usage: input.end.usage,
    durationMs: input.durationMs,
    costUsd: cost.spentUsd,
    ...(cost.maxUsd !== undefined ? { costBudgetUsd: cost.maxUsd } : {}),
    costOvershootUsd: cost.overshootUsd,
    contextCompactions: input.contextCompactions,
    skillActivations: input.skillActivations,
    activeSkills: input.activeSkills,
    skillCatalog: input.skillCatalog,
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
