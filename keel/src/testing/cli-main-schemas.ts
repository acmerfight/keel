import { z } from "zod";
import { runReportSchema } from "../eval/report-schema.ts";

export { runReportSchema };

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
