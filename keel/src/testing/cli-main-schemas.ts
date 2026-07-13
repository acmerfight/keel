import { z } from "zod";

export const runReportSchema = z.object({
  schemaVersion: z.literal(9),
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
  skillActivations: z.array(
    z.object({
      name: z.string(),
      relativePath: z.string(),
      trigger: z.enum(["model_selected", "user_explicit"]),
    }),
  ),
  activeSkills: z.array(
    z.object({
      name: z.string(),
      digest: z.string(),
      trigger: z.enum(["model_selected", "user_explicit"]),
      diskStatus: z.enum(["current", "changed_on_disk", "missing_on_disk"]),
    }),
  ),
  skillCatalog: z.object({
    exposed: z.number().int().nonnegative(),
    omitted: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    budgetChars: z.number().int().nonnegative(),
    usedChars: z.number().int().nonnegative(),
  }),
  skillPolicy: z.object({
    mode: z.enum(["enabled", "cli_disabled", "globally_disabled", "filtered"]),
    disabledPackages: z.number().int().nonnegative(),
  }),
  undoProtection: z.object({
    status: z.enum(["available", "not_applicable", "unavailable"]),
    checkpointsWritten: z.number().int().nonnegative(),
    failures: z.array(
      z.object({
        reason: z.enum([
          "checkpoint_write_failed",
          "git_workspace_unavailable",
          "target_unavailable",
        ]),
        count: z.number().int().positive(),
      }),
    ),
    latestCheckpoint: z
      .discriminatedUnion("written", [
        z.object({ written: z.literal(true) }),
        z.object({
          written: z.literal(false),
          reason: z.enum([
            "checkpoint_write_failed",
            "git_workspace_unavailable",
            "target_unavailable",
          ]),
        }),
      ])
      .nullable(),
  }),
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
