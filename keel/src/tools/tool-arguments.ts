import { z } from "zod";

export const readToolArgumentsSchema = z
  .object({
    path: z.string(),
    offset: z.number().int().positive().optional(),
    limit: z.number().int().positive().optional(),
  })
  .strict();

export const lsToolArgumentsSchema = z
  .object({
    path: z.string().optional(),
    limit: z.number().int().positive().max(1000).optional(),
  })
  .strict();

export const globToolArgumentsSchema = z
  .object({
    pattern: z.string(),
    path: z.string().optional(),
  })
  .strict();

export const grepToolArgumentsSchema = z
  .object({
    pattern: z.string(),
    path: z.string().optional(),
  })
  .strict();

const editReplacementArgumentsSchema = z
  .object({
    oldText: z.string(),
    newText: z.string(),
    replaceAll: z.boolean().optional(),
  })
  .strict();

export const editToolArgumentsSchema = z
  .object({
    path: z.string(),
    edits: z.array(editReplacementArgumentsSchema),
  })
  .strict();

export const writeToolArgumentsSchema = z
  .object({
    path: z.string(),
    content: z.string(),
  })
  .strict();

export const applyPatchToolArgumentsSchema = z
  .object({
    patch: z.string(),
  })
  .strict();

export const bashToolArgumentsSchema = z
  .object({
    command: z.string(),
    timeoutMs: z.number().int().positive().max(60_000).optional(),
  })
  .strict();
