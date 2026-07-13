import { z } from "zod";
import { runReportSchema } from "./report-schema.ts";

export const trialOutcomes = [
  "verified",
  "verify_failed",
  "routing_failed",
  "timeout",
  "crashed",
] as const;

const skillRoutingResultSchema = z.object({
  expectedActivations: z.array(z.string()),
  actualActivations: z.array(z.string()),
  truePositives: z.number().int().nonnegative(),
  falsePositives: z.number().int().nonnegative(),
  falseNegatives: z.number().int().nonnegative(),
  evaluated: z.boolean(),
  exact: z.boolean(),
  pair: z
    .object({
      id: z.string(),
      condition: z.enum(["with_skill", "without_skill"]),
    })
    .optional(),
});

export const evalResultLineSchema = z.object({
  schemaVersion: z.literal(1),
  timestamp: z.string(),
  keelVersion: z.string(),
  taskId: z.string(),
  trial: z.number().int().positive(),
  pass: z.boolean(),
  outcome: z.enum(trialOutcomes),
  wallMs: z.number().nonnegative(),
  skillRouting: skillRoutingResultSchema.optional(),
  report: runReportSchema.optional(),
  transcriptPath: z.string().optional(),
});

export type EvalResultLine = z.infer<typeof evalResultLineSchema>;
export type SkillRoutingResult = z.infer<typeof skillRoutingResultSchema>;
export type TrialOutcome = z.infer<typeof evalResultLineSchema>["outcome"];
