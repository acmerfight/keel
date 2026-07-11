import { z } from "zod";

export const runReportSchema = z.object({
  schemaVersion: z.literal(4),
  modelsUsed: z.array(
    z.object({
      provider: z.string(),
      model: z.string(),
    }),
  ),
  usageByModel: z.array(
    z.object({
      provider: z.string(),
      model: z.string(),
      turns: z.number().int().nonnegative(),
      costUsd: z.number(),
    }),
  ),
  costUsd: z.number(),
  costBudgetUsd: z.number().positive().optional(),
  costOvershootUsd: z.number().nonnegative(),
  contextCompactions: z.array(z.unknown()),
});

export const requestWithMessagesSchema = z
  .object({
    messages: z
      .array(
        z
          .object({
            role: z.string().optional(),
            tool_call_id: z.string().optional(),
            content: z.string().nullable().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

export const requestWithToolsSchema = z
  .object({
    tools: z
      .array(
        z
          .object({
            function: z.object({ name: z.string() }).optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

export const requestModelSchema = z.object({
  model: z.string(),
});
