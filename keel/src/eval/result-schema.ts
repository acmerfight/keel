import { z } from "zod";
import { runReportSchema } from "./report-schema.ts";

const failedEvalTrialOutcomes = [
  "verify_failed",
  "timeout",
  "crashed",
] as const;
const requiredEvalTrialConditions = ["standard", "memory_enabled"] as const;

export const evalTrialOutcomes = [
  "verified",
  ...failedEvalTrialOutcomes,
] as const;
const evalTrialConditions = [
  ...requiredEvalTrialConditions,
  "memory_disabled",
] as const;

export type EvalTrialOutcome = (typeof evalTrialOutcomes)[number];
export type EvalTrialCondition = (typeof evalTrialConditions)[number];

export type EvalResultVerdict =
  | { readonly outcome: "verified"; readonly pass: true }
  | {
      readonly outcome: (typeof failedEvalTrialOutcomes)[number];
      readonly pass: false;
    };

export type EvalResultRequirement =
  | {
      readonly condition: "memory_disabled";
      readonly requiredToPass: false;
    }
  | {
      readonly condition: (typeof requiredEvalTrialConditions)[number];
      readonly requiredToPass: true;
    };

const evalResultLineBaseSchema = z.object({
  schemaVersion: z.literal(2),
  timestamp: z.string(),
  keelVersion: z.string(),
  taskId: z.string(),
  trial: z.number().int().positive(),
  wallMs: z.number().nonnegative(),
  report: runReportSchema.optional(),
  transcriptPath: z.string().optional(),
});

const evalResultVerdictSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("verified"), pass: z.literal(true) }),
  z.object({
    outcome: z.enum(failedEvalTrialOutcomes),
    pass: z.literal(false),
  }),
]);

const evalResultRequirementSchema = z.discriminatedUnion("condition", [
  z.object({
    condition: z.literal("memory_disabled"),
    requiredToPass: z.literal(false),
  }),
  z.object({
    condition: z.enum(requiredEvalTrialConditions),
    requiredToPass: z.literal(true),
  }),
]);

export const evalResultLineSchema = evalResultLineBaseSchema
  .and(evalResultVerdictSchema)
  .and(evalResultRequirementSchema);

export type EvalResultLine = z.infer<typeof evalResultLineSchema>;

export function evalResultVerdict(
  outcome: EvalTrialOutcome,
): EvalResultVerdict {
  return outcome === "verified"
    ? { outcome, pass: true }
    : { outcome, pass: false };
}

export function evalResultRequirement(
  condition: EvalTrialCondition,
): EvalResultRequirement {
  return condition === "memory_disabled"
    ? { condition, requiredToPass: false }
    : { condition, requiredToPass: true };
}
