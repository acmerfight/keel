import { z } from "zod";
import { optionalToolArgument } from "./tool-schema.ts";

export const readToolArgumentsSchema = z
  .object({
    path: z.string().describe("Workspace-relative file path to read."),
    offset: optionalToolArgument(
      z
        .number()
        .int()
        .min(1)
        .describe("Optional 1-indexed line number to start reading from."),
    ),
    limit: optionalToolArgument(
      z
        .number()
        .int()
        .min(1)
        .describe("Optional maximum number of lines to read."),
    ),
  })
  .strict();

export const lsToolArgumentsSchema = z
  .object({
    path: optionalToolArgument(
      z
        .string()
        .describe(
          "Optional workspace-relative directory to list. Defaults to the workspace root.",
        ),
    ),
    limit: optionalToolArgument(
      z
        .number()
        .int()
        .min(1)
        .max(1000)
        .describe(
          "Optional maximum number of entries to return. Defaults to 200.",
        ),
    ),
  })
  .strict();

export const globToolArgumentsSchema = z
  .object({
    pattern: z
      .string()
      .describe(
        'Glob pattern for file paths, such as "**/*.test.ts" or "src/**/*.tsx".',
      ),
    path: optionalToolArgument(
      z
        .string()
        .describe(
          "Optional workspace-relative directory to search. Defaults to the whole workspace.",
        ),
    ),
  })
  .strict();

export const grepToolArgumentsSchema = z
  .object({
    pattern: z.string().describe("Literal text to search for."),
    path: optionalToolArgument(
      z
        .string()
        .describe(
          "Optional workspace-relative file or directory to search. Defaults to the whole workspace.",
        ),
    ),
  })
  .strict();

export const gitDiffToolArgumentsSchema = z
  .object({
    mode: optionalToolArgument(
      z
        .enum(["all", "unstaged", "staged"])
        .describe(
          "Which current git changes to inspect. Defaults to all, which includes unstaged, staged, and untracked changes.",
        ),
    ),
    paths: optionalToolArgument(
      z
        .array(
          z
            .string()
            .describe(
              "Workspace-relative literal path filter. Absolute paths, '..', NUL bytes, and git pathspec magic are rejected.",
            ),
        )
        .min(1)
        .max(100)
        .describe(
          "Optional path filters to narrow the diff to specific workspace-relative files or directories.",
        ),
    ),
  })
  .strict();

const editReplacementArgumentsSchema = z
  .object({
    oldText: z
      .string()
      .describe(
        "Text to replace. Copy it from read output; by default it must identify one target.",
      ),
    newText: z.string().describe("Replacement text."),
    replaceAll: optionalToolArgument(
      z
        .boolean()
        .describe(
          "When true, replace every exact occurrence of oldText for this edit. Defaults to false, which requires oldText to identify one target.",
        ),
    ),
  })
  .strict()
  .describe("One targeted replacement inside the file.");

export const editToolArgumentsSchema = z
  .object({
    path: z.string().describe("Workspace-relative file path to edit."),
    edits: z
      .array(editReplacementArgumentsSchema)
      .describe(
        "One or more targeted replacements. Each oldText is matched against the original file content. Non-replaceAll edits must be unique and all matched regions must be non-overlapping.",
      ),
  })
  .strict();

export const writeToolArgumentsSchema = z
  .object({
    path: z.string().describe("Workspace-relative file path to create."),
    content: z.string().describe("Complete file content to write."),
  })
  .strict();

export const applyPatchToolArgumentsSchema = z
  .object({
    patch: z
      .string()
      .describe(
        "Full apply_patch text. Supports Add File, Update File, Delete File, Update File with Move to sections, and standard Git-style unified diffs for text file updates, additions, deletions, and renames.",
      ),
  })
  .strict();

export const bashToolArgumentsSchema = z
  .object({
    command: z.string().describe("Shell command to execute."),
    timeoutMs: optionalToolArgument(
      z
        .number()
        .int()
        .min(1)
        .max(60_000)
        .describe(
          "Optional command timeout in milliseconds. Defaults to 10000ms.",
        ),
    ),
  })
  .strict();
