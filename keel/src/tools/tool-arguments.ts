import { z } from "zod";
import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  MAX_COMMAND_TIMEOUT_MS,
} from "../core/command-timeout.ts";
import { SESSION_GOAL_STATUS_REASON_MAX_LENGTH } from "../core/session-goal.ts";
import { sessionTaskPlanSchema } from "../core/task-progress.ts";
import { optionalToolArgument } from "./tool-schema.ts";

export const delegateToolArgumentsSchema = z
  .object({
    task: z
      .string()
      .trim()
      .min(1)
      .max(4_000)
      .describe(
        "Self-contained read-only investigation task with scope, expected output, and completion criteria.",
      ),
    focusPaths: optionalToolArgument(
      z
        .array(z.string().trim().min(1).max(500))
        .min(1)
        .max(20)
        .describe(
          "Optional workspace-relative files or directories that should receive most of the child agent's attention.",
        ),
    ),
  })
  .strict();

export const skillToolArgumentsSchema = z
  .object({
    name: z
      .string()
      .describe("Exact project skill name from the available skills catalog."),
  })
  .strict();

export const skillSearchToolArgumentsSchema = z
  .object({
    query: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .describe("Words describing the workflow skill to find."),
  })
  .strict();

export const mcpSearchToolArgumentsSchema = z
  .object({
    query: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .describe("Words describing the remote MCP capability to find."),
    server: optionalToolArgument(
      z
        .string()
        .trim()
        .min(1)
        .max(64)
        .describe("Optional exact configured MCP server ID."),
    ),
    toolName: optionalToolArgument(
      z
        .string()
        .trim()
        .min(1)
        .max(128)
        .describe("Optional exact raw MCP tool name."),
    ),
    limit: optionalToolArgument(
      z
        .number()
        .int()
        .min(1)
        .max(10)
        .describe("Optional maximum matches to activate. Defaults to 5."),
    ),
    refresh: optionalToolArgument(
      z
        .boolean()
        .describe(
          "When true, refresh matching server catalogs before searching.",
        ),
    ),
  })
  .strict();

export const skillResourceToolArgumentsSchema = z
  .object({
    skill: z.string().describe("Exact qualified name of an active skill."),
    path: z
      .string()
      .describe(
        "Skill-relative resource path under references/, scripts/, or assets/.",
      ),
  })
  .strict();

export const memoryAddToolArgumentsSchema = z
  .object({
    text: z
      .string()
      .trim()
      .min(1)
      .describe(
        "One exact contiguous durable-claim span copied from the latest current-user message. Preserve meaningful punctuation; do not paraphrase, broaden, or infer it.",
      ),
  })
  .strict();

export const memoryForgetToolArgumentsSchema = z
  .object({
    memoryId: z
      .string()
      .describe(
        "Exact active project-memory ID selected from the current project memory block.",
      ),
  })
  .strict();

export const memoryProposeToolArgumentsSchema = z
  .object({
    kind: z.enum([
      "user_preference",
      "feedback",
      "project_context",
      "reference",
    ]),
    statement: z
      .string()
      .trim()
      .min(1)
      .max(1_000)
      .describe("One concise durable project-memory statement to review."),
    why: z
      .string()
      .trim()
      .min(1)
      .max(1_000)
      .describe("Why this statement is likely to help in a later session."),
    sourceQuote: z
      .string()
      .min(1)
      .max(2_000)
      .describe(
        "One exact contiguous quote copied from the latest current-user message that supports the proposed statement.",
      ),
    conflictMemoryIds: z
      .array(z.string())
      .max(8)
      .describe(
        "Every active project-memory ID that conflicts with this proposal; use an empty array when none conflict.",
      ),
  })
  .strict();

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
          "Which current git changes to inspect. Defaults to all, which includes unstaged, staged, and untracked changes. Do not combine with baseRef.",
        ),
    ),
    baseRef: optionalToolArgument(
      z
        .string()
        .describe(
          "Optional older/base Git ref to compare from, such as HEAD~1 or origin/main. Must be a single safe ref, not a range, option, blob spec, or shell string.",
        ),
    ),
    headRef: optionalToolArgument(
      z
        .string()
        .describe(
          "Optional newer/head Git ref to compare to when baseRef is set. Defaults to HEAD. Must be a single safe ref.",
        ),
    ),
    mergeBase: optionalToolArgument(
      z
        .boolean()
        .describe(
          "When true with baseRef, compare the merge base of baseRef and headRef to headRef, matching PR-style base...head diffs.",
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

export const gitStatusToolArgumentsSchema = z
  .object({
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
          "Optional path filters to narrow the status to specific workspace-relative files or directories.",
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
        "Full apply_patch text. Supports Add File, Update File, Delete File, Update File with Move to sections, and standard Git-style unified diffs for text file updates, additions, deletions, 100644/100755 regular file mode changes, renames, and copies.",
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
        .max(MAX_COMMAND_TIMEOUT_MS)
        .describe(
          `Optional command timeout in milliseconds. Defaults to ${DEFAULT_COMMAND_TIMEOUT_MS}ms.`,
        ),
    ),
  })
  .strict();

export const updatePlanToolArgumentsSchema = z
  .object({
    plan: sessionTaskPlanSchema.describe(
      "The full replacement list of task steps and statuses. Pass an empty list to clear task progress.",
    ),
  })
  .strict();

export const updateGoalToolArgumentsSchema = z
  .object({
    status: z
      .enum(["completed", "blocked"])
      .describe(
        "Propose a lifecycle state for the active saved session goal. Use completed only when the completion gate passes. Use blocked only when progress is genuinely blocked.",
      ),
    reason: optionalToolArgument(
      z
        .string()
        .trim()
        .min(1)
        .max(SESSION_GOAL_STATUS_REASON_MAX_LENGTH)
        .describe(
          "Required when status is blocked. Concisely state the blocking condition. Omit for completed.",
        ),
    ),
  })
  .strict()
  .superRefine((args, ctx) => {
    if (args.status === "blocked" && args.reason === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["reason"],
        message: "reason is required when status is blocked",
      });
    }
    if (args.status === "completed" && args.reason !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["reason"],
        message: "reason is only valid when status is blocked",
      });
    }
  });
