import { z } from "zod";
import { MAX_COMMAND_TIMEOUT_MS } from "../core/command-timeout.ts";
import {
  applyPatchToolArgumentsSchema,
  bashToolArgumentsSchema,
  editToolArgumentsSchema,
  gitDiffToolArgumentsSchema,
  gitStatusToolArgumentsSchema,
  globToolArgumentsSchema,
  grepToolArgumentsSchema,
  lsToolArgumentsSchema,
  readToolArgumentsSchema,
  skillToolArgumentsSchema,
  updateGoalToolArgumentsSchema,
  updatePlanToolArgumentsSchema,
  writeToolArgumentsSchema,
} from "./tool-arguments.ts";
import { invalidBuiltinToolCallError } from "./tool-error.ts";
import {
  stripUndefinedProperties,
  toolArgumentKeys,
  toolRequiredArgumentKeys,
} from "./tool-schema.ts";

type ToolArgShape = z.ZodRawShape;

type ToolArgsSchema<Shape extends ToolArgShape> = z.ZodObject<
  Shape,
  z.core.$strict
>;

type ToolPermission<Args> =
  | { readonly kind: "none" }
  | {
      readonly kind: "approval";
      readonly renderPrompt: (args: Args) => string;
    };

type ToolOutput =
  | { readonly kind: "text" }
  | {
      readonly kind: "structured";
      readonly schema: Readonly<Record<string, unknown>>;
    };

interface ToolDisplay<Args> {
  readonly formatLabel: (args: Args) => string;
}

type ToolRisk =
  | { readonly kind: "workspace-read" }
  | { readonly kind: "workspace-write"; readonly destructive: boolean }
  | { readonly kind: "trusted-shell" }
  | { readonly kind: "agent-state" };

interface BuiltinToolCallInput {
  readonly id: string;
  readonly tool: string;
}

type ObjectFieldValue =
  | { readonly exists: false }
  | { readonly exists: true; readonly value: unknown };

type ParsedToolArguments<Args> =
  | { readonly success: true; readonly data: Args }
  | { readonly success: false; readonly error?: z.ZodError };

interface BuiltinTool<Name extends string, Shape extends ToolArgShape> {
  readonly name: Name;
  readonly availability?: "skill-catalog";
  readonly description: string;
  readonly args: {
    readonly schema: ToolArgsSchema<Shape>;
  };
  readonly permission: ToolPermission<z.infer<ToolArgsSchema<Shape>>>;
  readonly output: ToolOutput;
  readonly display: ToolDisplay<z.infer<ToolArgsSchema<Shape>>>;
  readonly risk: ToolRisk;
}

function objectFieldValue(input: object, key: string): ObjectFieldValue {
  for (const [name, value] of Object.entries(input)) {
    if (name === key) {
      return { exists: true, value };
    }
  }
  return { exists: false };
}

function defineTool<
  const Name extends string,
  const Shape extends ToolArgShape,
>(tool: BuiltinTool<Name, Shape>) {
  const argumentNames = toolArgumentKeys(tool.args.schema);
  const requiredArgumentNames = new Set(
    toolRequiredArgumentKeys(tool.args.schema),
  );
  const toolCallSchema = tool.args.schema.extend({
    id: z.string(),
    tool: z.literal(tool.name),
  });

  function rawArgumentsFromCall(
    toolCall: BuiltinToolCallInput,
  ): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(toolCall)) {
      if (name !== "id" && name !== "tool") {
        args[name] = value;
      }
    }
    return args;
  }

  function parseArgumentsFromCall(
    toolCall: BuiltinToolCallInput,
  ): ParsedToolArguments<z.infer<ToolArgsSchema<Shape>>> {
    if (toolCall.tool !== tool.name) {
      return { success: false };
    }

    const result = tool.args.schema.safeParse(rawArgumentsFromCall(toolCall));
    return result.success
      ? { success: true, data: result.data }
      : { success: false, error: result.error };
  }

  function argumentsFromParsed(
    parsedArgs: z.infer<ToolArgsSchema<Shape>>,
  ): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    for (const name of argumentNames) {
      const value = objectFieldValue(parsedArgs, name);
      if (value.exists && value.value !== undefined && value.value !== null) {
        args[name] = value.value;
      }
    }
    return args;
  }

  function argumentsFromCall(
    toolCall: BuiltinToolCallInput,
  ): Record<string, unknown> {
    const parsedArgs = parseArgumentsFromCall(toolCall);
    if (!parsedArgs.success) {
      throw invalidBuiltinToolCallError(tool.name, parsedArgs.error);
    }
    return argumentsFromParsed(parsedArgs.data);
  }

  function canonicalArgumentsFromCall(
    toolCall: BuiltinToolCallInput,
  ): Record<string, unknown> {
    const parsedArgs = parseArgumentsFromCall(toolCall);
    if (!parsedArgs.success) {
      throw invalidBuiltinToolCallError(tool.name, parsedArgs.error);
    }

    const args: Record<string, unknown> = {};
    for (const name of argumentNames) {
      const value = objectFieldValue(parsedArgs.data, name);
      if (!value.exists || value.value === undefined || value.value === null) {
        /* v8 ignore next 3: required fields cannot be absent after this tool's Zod schema has parsed successfully. */
        if (requiredArgumentNames.has(name)) {
          throw invalidBuiltinToolCallError(tool.name);
        }
        args[name] = null;
      } else {
        args[name] = value.value;
      }
    }
    return args;
  }

  function isCallForThisTool(
    toolCall: BuiltinToolCallInput,
  ): toolCall is BuiltinToolCallInput & {
    readonly tool: Name;
  } & z.infer<ToolArgsSchema<Shape>> {
    return parseArgumentsFromCall(toolCall).success;
  }

  function formatCallLabel(toolCall: BuiltinToolCallInput): string {
    const parsedArgs = parseArgumentsFromCall(toolCall);
    if (parsedArgs.success) {
      return tool.display.formatLabel(parsedArgs.data);
    }
    throw invalidBuiltinToolCallError(tool.name, parsedArgs.error);
  }

  return Object.assign({}, tool, {
    toolCallSchema,
    isCall: isCallForThisTool,
    argumentsFromCall,
    canonicalArgumentsFromCall,
    formatCallLabel,
  });
}

function toolArgs<const Shape extends ToolArgShape>(
  schema: ToolArgsSchema<Shape>,
): { readonly schema: ToolArgsSchema<Shape> } {
  return { schema };
}

const readTool = defineTool({
  name: "read",
  description: [
    "Read a workspace text file. Output is capped at 2000 lines or 50KB; use offset and limit to read later sections.",
    "Use when: you need exact file content, especially before editing or after grep located a match.",
    "Do not use when: the path is a directory or a binary file, or you only need to find where text lives across files (use grep).",
    "On failure: if the file is not found, grep for a distinctive string to discover the correct path; if output is truncated, read again with offset and limit.",
  ].join("\n"),
  args: toolArgs(readToolArgumentsSchema),
  permission: { kind: "none" },
  output: { kind: "text" },
  display: {
    formatLabel: (args) => `read ${args.path}`,
  },
  risk: { kind: "workspace-read" },
});

const skillTool = defineTool({
  name: "skill",
  availability: "skill-catalog",
  description: [
    "Activate one project skill whose metadata appears in the available project skills catalog.",
    "Use when: the current task clearly matches a listed skill description and the skill body has not already been activated.",
    "Do not use when: no matching project skill is listed, the user explicitly selected a workflow skill at launch, or a skill is already active.",
    "On failure: use an exact listed name, or continue without a skill if the catalog changed or no longer contains it.",
  ].join("\n"),
  args: toolArgs(skillToolArgumentsSchema),
  permission: { kind: "none" },
  output: { kind: "text" },
  display: {
    formatLabel: (args) => `skill ${args.name}`,
  },
  risk: { kind: "workspace-read" },
});

const lsTool = defineTool({
  name: "ls",
  description: [
    "List direct entries in a workspace directory, skipping gitignored and built-in ignored paths. Directories are suffixed with '/'.",
    "Use when: you know a directory path and need to inspect its immediate children before choosing files to read.",
    "Do not use when: searching by file name or extension across a tree (use glob), searching file contents (use grep), or reading file contents (use read).",
    "On failure: if the path is not a directory, use glob or grep to discover the correct directory; if output is truncated, list a narrower directory or increase limit.",
  ].join("\n"),
  args: toolArgs(lsToolArgumentsSchema),
  permission: { kind: "none" },
  output: { kind: "text" },
  display: {
    formatLabel: (args) =>
      args.path === undefined ? "ls ." : `ls ${args.path}`,
  },
  risk: { kind: "workspace-read" },
});

const globTool = defineTool({
  name: "glob",
  description: [
    "Find workspace files by glob pattern, skipping gitignored files. Returns capped workspace-relative file paths.",
    "Use when: locating files by name or extension before reading them - do not guess file paths.",
    "Do not use when: searching inside file contents (use grep), reading exact content (use read), or writing changes.",
    'On failure: if there are too many matches, narrow pattern or path; if there are zero matches, retry with a broader pattern such as "**/*.ts" before concluding the file is absent.',
  ].join("\n"),
  args: toolArgs(globToolArgumentsSchema),
  permission: { kind: "none" },
  output: { kind: "text" },
  display: {
    formatLabel: (args) =>
      args.path === undefined
        ? `glob ${args.pattern}`
        : `glob ${args.pattern} ${args.path}`,
  },
  risk: { kind: "workspace-read" },
});

const grepTool = defineTool({
  name: "grep",
  description: [
    "Search workspace text files for a literal single-line string, skipping gitignored files. Returns capped path:line:snippet matches.",
    "Use when: locating code, file paths, or usages before reading or editing - do not guess file paths.",
    "Do not use when: you already know the exact file and need its content (use read); the pattern is a regex or spans multiple lines (not supported).",
    "On failure: if the pattern contains newlines, search for a unique single-line substring instead; zero matches means the text is absent from non-ignored files - retry with a shorter or different substring before concluding it does not exist.",
  ].join("\n"),
  args: toolArgs(grepToolArgumentsSchema),
  permission: { kind: "none" },
  output: { kind: "text" },
  display: {
    formatLabel: (args) =>
      args.path === undefined
        ? `grep ${args.pattern}`
        : `grep ${args.pattern} ${args.path}`,
  },
  risk: { kind: "workspace-read" },
});

const gitDiffTool = defineTool({
  name: "git_diff",
  description: [
    "Read git changes in the workspace without using a shell. Output is capped and external diff/textconv/filter helpers are disabled.",
    "Use when: inspecting staged, unstaged, untracked, or committed ref-to-ref changes before review, summary, or verification, especially when bash is disabled.",
    "For committed comparisons, pass baseRef and optional headRef instead of a range string; set mergeBase true for PR-style base...head diffs.",
    "Do not use when: running git status, committing, inspecting logs, or performing other git operations (use bash if enabled and appropriate).",
    "On failure: if the workspace is not a git repository, inspect files with read/grep; if output is truncated, pass paths to narrow the diff.",
  ].join("\n"),
  args: toolArgs(gitDiffToolArgumentsSchema),
  permission: { kind: "none" },
  output: { kind: "text" },
  display: {
    formatLabel: (args) => {
      const pathSuffix =
        args.paths === undefined || args.paths.length === 0
          ? ""
          : ` ${args.paths.join(" ")}`;
      if (args.baseRef !== undefined) {
        const separator = args.mergeBase === true ? "..." : "..";
        return `git_diff ${args.baseRef}${separator}${
          args.headRef ?? "HEAD"
        }${pathSuffix}`;
      }
      return `git_diff${pathSuffix}`;
    },
  },
  risk: { kind: "workspace-read" },
});

const gitStatusTool = defineTool({
  name: "git_status",
  description: [
    "Read the current git working tree status without using a shell. Output is grouped and capped; git hooks, fsmonitor helpers, and unsafe git environment overrides are disabled.",
    "Use when: checking branch, staged, unstaged, unmerged, or untracked file status before committing, reviewing work, or deciding which files changed, especially when bash is disabled.",
    "Do not use when: inspecting patch contents or committed ref-to-ref diffs (use git_diff); committing, inspecting logs, or performing other git operations (use bash if enabled and appropriate).",
    "On failure: if the workspace is not a git repository, inspect files with read/grep; if output is truncated, pass paths to narrow the status.",
  ].join("\n"),
  args: toolArgs(gitStatusToolArgumentsSchema),
  permission: { kind: "none" },
  output: { kind: "text" },
  display: {
    formatLabel: (args) =>
      args.paths === undefined || args.paths.length === 0
        ? "git_status"
        : `git_status ${args.paths.join(" ")}`,
  },
  risk: { kind: "workspace-read" },
});

const editTool = defineTool({
  name: "edit",
  description: [
    "Replace text in an existing workspace file. Each edits[].oldText should be copied from the current file content and identify one target unless that edit's replaceAll is true.",
    "Use when: changing an existing file after read confirmed the exact target text.",
    "When changing multiple separate locations in the same file, use one edit call with multiple entries in edits[]. Each edit is matched against the original file, not after earlier edits are applied.",
    "Do not use when: creating a new file (use write), or when you have not read the file and would be guessing oldText from memory.",
    "For non-replaceAll edits, Keel can correct harmless line-ending, trailing-space, smart-punctuation, and common-indentation differences while preserving unrelated file bytes.",
    "Large generated files, bundles, and logs may exceed the edit safety limit; inspect them with grep/read and use a targeted external command when appropriate.",
    "On failure: if the string is not found, use the Recovery current-file context to retry, and read only if the target is outside the excerpt; if it appears more than once, use the reported matching locations to add surrounding lines in oldText or set replaceAll when every occurrence should change.",
  ].join("\n"),
  args: toolArgs(editToolArgumentsSchema),
  permission: { kind: "none" },
  output: { kind: "text" },
  display: {
    formatLabel: (args) => `edit ${args.path}`,
  },
  risk: { kind: "workspace-write", destructive: false },
});

const writeTool = defineTool({
  name: "write",
  description: [
    "Create a new workspace file with the given content. Fails if the file already exists. Automatically creates parent directories.",
    "Use when: adding a file that does not exist yet.",
    "Do not use when: the file already exists (use edit to change it).",
    "On failure: if the file already exists, read it and apply edit instead of recreating it.",
  ].join("\n"),
  args: toolArgs(writeToolArgumentsSchema),
  permission: { kind: "none" },
  output: { kind: "text" },
  display: {
    formatLabel: (args) => `write ${args.path}`,
  },
  risk: { kind: "workspace-write", destructive: true },
});

const applyPatchTool = defineTool({
  name: "apply_patch",
  description: [
    "Apply one patch containing workspace file additions, updates, deletions, and Move to renames.",
    "Patch format: *** Begin Patch, then one or more *** Add File: <path>, *** Update File: <path> with optional *** Move to: <path>, or *** Delete File: <path> sections, then *** End Patch.",
    "Also accepts standard Git-style unified diffs for text file updates, additions, deletions, regular file mode changes between 100644 and 100755, rename diffs with rename from/to metadata, and copy diffs with copy from/to metadata.",
    "Use when: making coordinated changes across multiple files after reading every file that will be copied, updated, moved, or deleted.",
    "Do not use when: editing binary files, symlinks, submodules, directories, or special file modes.",
    "On failure: read the current target files and regenerate the patch with exact context.",
  ].join("\n"),
  args: toolArgs(applyPatchToolArgumentsSchema),
  permission: { kind: "none" },
  output: { kind: "text" },
  display: {
    formatLabel: () => "apply_patch",
  },
  risk: { kind: "workspace-write", destructive: true },
});

const bashTool = defineTool({
  name: "bash",
  description: [
    "Run a trusted shell command in the workspace. Commands use the current OS user's permissions and are not constrained by Keel's gitignore file-tool policy. Output is capped to the last 20KB per stream.",
    "Use when: the task needs commands the dedicated tools cannot do, such as running builds, tests, commits, logs, or other git operations beyond current status, current diffs, and safe ref-to-ref diffs.",
    "Do not use when: a dedicated tool can do the job - prefer read, ls, glob, grep, git_status, git_diff, edit, and write for file inspection and changes.",
    `On failure: a non-zero exit code returns stdout/stderr for diagnosis - fix the command rather than retrying it unchanged; if the command timed out, raise timeoutMs (up to ${MAX_COMMAND_TIMEOUT_MS}) or run a narrower command.`,
  ].join("\n"),
  args: toolArgs(bashToolArgumentsSchema),
  permission: {
    kind: "approval",
    renderPrompt: (args) => `Run shell command: ${args.command}`,
  },
  output: { kind: "text" },
  display: {
    formatLabel: (args) => `bash ${args.command}`,
  },
  risk: { kind: "trusted-shell" },
});

const updatePlanTool = defineTool({
  name: "update_plan",
  description: [
    "Update the visible task progress for the current agent session.",
    "Use when: work is non-trivial, has multiple meaningful steps, or the user asks to track tasks.",
    "Provide the full replacement list each time. Use statuses pending, in_progress, and completed. Keep at most one task in_progress. Pass an empty list to clear task progress.",
    "Do not use when: the task is a trivial one-step answer or no meaningful progress state has changed.",
    "On failure: fix the plan shape to use non-empty step strings, valid statuses, and at most one in_progress task before retrying.",
  ].join("\n"),
  args: toolArgs(updatePlanToolArgumentsSchema),
  permission: { kind: "none" },
  output: { kind: "text" },
  display: {
    formatLabel: () => "update_plan",
  },
  risk: { kind: "agent-state" },
});

const updateGoalTool = defineTool({
  name: "update_goal",
  description: [
    "Propose a lifecycle update for the current active saved session goal.",
    "Use when: status completed applies when the durable session goal has actually been achieved and no required work remains. Status blocked applies when meaningful progress cannot continue without user input or an external state change; provide a concise reason. Runtime records at most one blocked proposal per agent turn and persists blocked only after three consecutive blocked turns for the active goal.",
    "Runtime treats completed as a proposal. It uses the independent evaluator for assertion criteria and runs the exact configured verifier at the completion boundary for command criteria. Runtime persists blocked with the provided reason.",
    "This tool cannot create, rewrite, pause, resume, clear, budget, or self-certify a goal.",
    "Do not use when: no saved session goal is active, the current user request is only a step toward the goal, more required work remains, or the model would merely benefit from clarification. Do not use completed when no completion criterion is set or the visible evidence does not yet support an assertion criterion.",
    "On failure: continue working toward the goal, address the evaluator or verifier reason, ask the user to set a criterion, ask the user to use /goal complete for an explicit override, or explain the blocker in normal text if blocked is rejected.",
  ].join("\n"),
  args: toolArgs(updateGoalToolArgumentsSchema),
  permission: { kind: "none" },
  output: { kind: "text" },
  display: {
    formatLabel: () => "update_goal",
  },
  risk: { kind: "agent-state" },
});

export const builtinTools = [
  updatePlanTool,
  updateGoalTool,
  skillTool,
  readTool,
  lsTool,
  globTool,
  grepTool,
  gitStatusTool,
  gitDiffTool,
  editTool,
  writeTool,
  applyPatchTool,
  bashTool,
] as const;

const rawBuiltinToolCallSchema = z.discriminatedUnion("tool", [
  updatePlanTool.toolCallSchema,
  updateGoalTool.toolCallSchema,
  skillTool.toolCallSchema,
  readTool.toolCallSchema,
  lsTool.toolCallSchema,
  globTool.toolCallSchema,
  grepTool.toolCallSchema,
  gitStatusTool.toolCallSchema,
  gitDiffTool.toolCallSchema,
  editTool.toolCallSchema,
  writeTool.toolCallSchema,
  applyPatchTool.toolCallSchema,
  bashTool.toolCallSchema,
]);

export const builtinToolCallSchema = rawBuiltinToolCallSchema
  .transform(stripUndefinedProperties)
  .pipe(rawBuiltinToolCallSchema);
