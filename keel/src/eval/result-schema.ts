import { z } from "zod";
import { runReportSchema } from "./report-schema.ts";
import { type EvalDelegationPolicy, evalDelegationPolicies } from "./task.ts";

export const evalHarnessOutcomes = ["completed", "timeout", "crashed"] as const;
export const evalTaskOutcomes = ["verified", "verify_failed"] as const;

const requiredEvalTrialConditions = [
  "standard",
  "memory_enabled",
  "delegation_treatment",
] as const;
const observationalEvalTrialConditions = [
  "memory_disabled",
  "delegation_control",
] as const;
const evalTrialConditions = [
  ...requiredEvalTrialConditions,
  ...observationalEvalTrialConditions,
] as const;

export type EvalHarnessOutcome = (typeof evalHarnessOutcomes)[number];
export type EvalTaskOutcome = (typeof evalTaskOutcomes)[number];
export type EvalTrialCondition = (typeof evalTrialConditions)[number];

export type EvalTrialObservation =
  | {
      readonly harnessOutcome: "completed";
      readonly taskOutcome: EvalTaskOutcome;
    }
  | {
      readonly harnessOutcome: Exclude<EvalHarnessOutcome, "completed">;
      readonly taskOutcome?: never;
    };

export type EvalResultVerdict =
  | {
      readonly harnessOutcome: "completed";
      readonly taskOutcome: "verified";
      readonly pass: true;
    }
  | {
      readonly harnessOutcome: "completed";
      readonly taskOutcome: "verify_failed";
      readonly pass: false;
    }
  | {
      readonly harnessOutcome: Exclude<EvalHarnessOutcome, "completed">;
      readonly taskOutcome?: never;
      readonly pass: false;
    };

export type EvalDelegationSelection =
  | {
      readonly status: "observed";
      readonly policy: EvalDelegationPolicy;
      readonly childRuns: number;
      readonly satisfied: boolean;
    }
  | {
      readonly status: "unavailable";
      readonly policy: EvalDelegationPolicy;
      readonly childRuns?: never;
      readonly satisfied?: never;
    };

export type EvalResultCondition =
  | {
      readonly condition: "standard";
      readonly requiredToPass: true;
      readonly delegationSelection?: EvalDelegationSelection;
    }
  | {
      readonly condition: "memory_enabled";
      readonly requiredToPass: true;
      readonly delegationSelection?: never;
    }
  | {
      readonly condition: "delegation_treatment";
      readonly requiredToPass: true;
      readonly delegationSelection: EvalDelegationSelection;
    }
  | {
      readonly condition: "memory_disabled" | "delegation_control";
      readonly requiredToPass: false;
      readonly delegationSelection?: never;
    };

const evalResultLineBaseSchema = z.object({
  schemaVersion: z.literal(3),
  timestamp: z.string(),
  keelVersion: z.string(),
  taskId: z.string(),
  trial: z.number().int().positive(),
  wallMs: z.number().nonnegative(),
  report: runReportSchema.optional(),
  transcriptPath: z.string().optional(),
});

const completedResultVerdictSchema = z.discriminatedUnion("taskOutcome", [
  z.object({
    harnessOutcome: z.literal("completed"),
    taskOutcome: z.literal("verified"),
    pass: z.literal(true),
  }),
  z.object({
    harnessOutcome: z.literal("completed"),
    taskOutcome: z.literal("verify_failed"),
    pass: z.literal(false),
  }),
]);

const evalResultVerdictSchema = z.union([
  completedResultVerdictSchema,
  z.object({
    harnessOutcome: z.enum(["timeout", "crashed"]),
    taskOutcome: z.never().optional(),
    pass: z.literal(false),
  }),
]);

const observedDelegationSelectionSchema = z.object({
  status: z.literal("observed"),
  policy: z.enum(evalDelegationPolicies),
  childRuns: z.number().int().nonnegative(),
  satisfied: z.boolean(),
});
const unavailableDelegationSelectionSchema = z.object({
  status: z.literal("unavailable"),
  policy: z.enum(evalDelegationPolicies),
  childRuns: z.never().optional(),
  satisfied: z.never().optional(),
});
const delegationSelectionSchema = z.discriminatedUnion("status", [
  observedDelegationSelectionSchema,
  unavailableDelegationSelectionSchema,
]);

const evalResultConditionSchema = z.discriminatedUnion("condition", [
  z.object({
    condition: z.literal("standard"),
    requiredToPass: z.literal(true),
    delegationSelection: delegationSelectionSchema.optional(),
  }),
  z.object({
    condition: z.literal("memory_enabled"),
    requiredToPass: z.literal(true),
    delegationSelection: z.never().optional(),
  }),
  z.object({
    condition: z.literal("delegation_treatment"),
    requiredToPass: z.literal(true),
    delegationSelection: delegationSelectionSchema,
  }),
  z.object({
    condition: z.enum(observationalEvalTrialConditions),
    requiredToPass: z.literal(false),
    delegationSelection: z.never().optional(),
  }),
]);

export const evalResultLineSchema = evalResultLineBaseSchema
  .and(evalResultVerdictSchema)
  .and(evalResultConditionSchema);

export type EvalResultLine = z.infer<typeof evalResultLineSchema>;

export function evalResultVerdict(
  observation: EvalTrialObservation,
): EvalResultVerdict {
  if (observation.harnessOutcome !== "completed") {
    return { harnessOutcome: observation.harnessOutcome, pass: false };
  }
  return observation.taskOutcome === "verified"
    ? {
        harnessOutcome: "completed",
        taskOutcome: "verified",
        pass: true,
      }
    : {
        harnessOutcome: "completed",
        taskOutcome: "verify_failed",
        pass: false,
      };
}
