import { z } from "zod";
import type { RecordLastBatchCheckpointOperation } from "../core/git.ts";
import type { BashPermissionPolicy } from "../permissions/bash.ts";
import { executeApplyPatch } from "./apply-patch.ts";
import { executeBash } from "./bash.ts";
import { executeEdit } from "./edit.ts";
import { executeGlob } from "./glob.ts";
import { executeGrep } from "./grep.ts";
import { executeLs } from "./ls.ts";
import { executeRead } from "./read.ts";
import type { ProjectInstructionVisibilityState } from "./scoped-project-instructions.ts";
import {
  applyPatchToolArgumentsSchema,
  bashToolArgumentsSchema,
  editToolArgumentsSchema,
  globToolArgumentsSchema,
  grepToolArgumentsSchema,
  lsToolArgumentsSchema,
  readToolArgumentsSchema,
  writeToolArgumentsSchema,
} from "./tool-arguments.ts";
import { invalidBuiltinToolCallError } from "./tool-error.ts";
import {
  stripUndefinedProperties,
  toolArgumentKeys,
  toolRequiredArgumentKeys,
} from "./tool-schema.ts";
import {
  resolveWorkspaceCreateTarget,
  resolveWorkspaceTarget,
} from "./workspace-path.ts";
import { executeWrite } from "./write.ts";

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
  | { readonly kind: "trusted-shell" };

export type ToolConcurrency =
  | { readonly kind: "parallel-safe" }
  | { readonly kind: "exclusive"; readonly reason: string };

export interface BuiltinToolExecutionContext {
  readonly workspace: string;
  readonly signal: AbortSignal;
  readonly allowBash: boolean;
  readonly bashPermission?: BashPermissionPolicy;
  readonly readBeforeEdit?: {
    readonly hasRead: (targetPath: string) => boolean;
  };
  readonly projectInstructions?: ProjectInstructionVisibilityState;
}

export interface ToolExecution {
  readonly content: string;
  readonly ok: boolean;
  readonly readTargetPath?: string;
  readonly readTargetOffset?: number;
  readonly readTargetLimit?: number;
  readonly mutatedTargetPath?: string;
  readonly mutatedTargetPaths?: readonly string[];
  readonly visibleProjectInstructionPaths?: readonly string[];
  readonly checkpointOperations?: readonly RecordLastBatchCheckpointOperation[];
}

type BuiltinToolExecution<Args> = (
  context: BuiltinToolExecutionContext,
  args: Args,
) => ToolExecution | Promise<ToolExecution>;

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
  readonly description: string;
  readonly args: {
    readonly schema: ToolArgsSchema<Shape>;
  };
  readonly permission: ToolPermission<z.infer<ToolArgsSchema<Shape>>>;
  readonly output: ToolOutput;
  readonly display: ToolDisplay<z.infer<ToolArgsSchema<Shape>>>;
  readonly risk: ToolRisk;
  readonly concurrency: ToolConcurrency;
  readonly execute: BuiltinToolExecution<z.infer<ToolArgsSchema<Shape>>>;
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
    executeCall: (
      context: BuiltinToolExecutionContext,
      toolCall: BuiltinToolCallInput,
    ) => {
      const parsedArgs = parseArgumentsFromCall(toolCall);
      if (parsedArgs.success) {
        return tool.execute(context, parsedArgs.data);
      }
      throw invalidBuiltinToolCallError(tool.name, parsedArgs.error);
    },
  });
}

function toolArgs<const Shape extends ToolArgShape>(
  schema: ToolArgsSchema<Shape>,
): { readonly schema: ToolArgsSchema<Shape> } {
  return { schema };
}

function disabledBashMessage(): string {
  return "Tool failed: bash failed: shell commands are disabled. Re-run with --bash-policy ask, --bash-policy trusted, or --allow-bash to enable them.";
}

function deniedBashMessage(message: string): string {
  return `Tool failed: bash permission denied: ${message}\nRecovery: Ask the user for permission or choose a non-shell approach.`;
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
  concurrency: { kind: "parallel-safe" },
  execute: ({ workspace, projectInstructions }, args) => {
    const result = executeRead(workspace, args.path, {
      offset: args.offset,
      limit: args.limit,
    });
    const scopedOutput = projectInstructions?.formatReadOutput(
      result.targetPath,
      result.content,
    );
    return {
      content: scopedOutput?.content ?? result.content,
      ok: true,
      readTargetPath: result.targetPath,
      ...(scopedOutput !== undefined && scopedOutput.instructionPaths.length > 0
        ? { visibleProjectInstructionPaths: scopedOutput.instructionPaths }
        : {}),
      ...(args.offset !== undefined ? { readTargetOffset: args.offset } : {}),
      ...(args.limit !== undefined ? { readTargetLimit: args.limit } : {}),
    };
  },
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
  concurrency: { kind: "parallel-safe" },
  execute: ({ workspace }, args) => {
    const result = executeLs(workspace, {
      ...(args.path !== undefined ? { path: args.path } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
    });
    return { content: result.content, ok: true };
  },
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
  concurrency: { kind: "parallel-safe" },
  execute: async ({ workspace, signal }, args) => {
    const result = await executeGlob(workspace, args.pattern, {
      ...(args.path !== undefined ? { path: args.path } : {}),
      signal,
    });
    return { content: result.content, ok: true };
  },
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
  concurrency: { kind: "parallel-safe" },
  execute: async ({ workspace, signal }, args) => {
    const result = await executeGrep(workspace, args.pattern, {
      ...(args.path !== undefined ? { path: args.path } : {}),
      signal,
    });
    return { content: result.content, ok: true };
  },
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
    "On failure: if the string is not found, read the file and retry with the exact current text; if it appears more than once, include more surrounding lines in oldText to make it unique.",
  ].join("\n"),
  args: toolArgs(editToolArgumentsSchema),
  permission: { kind: "none" },
  output: { kind: "text" },
  display: {
    formatLabel: (args) => `edit ${args.path}`,
  },
  risk: { kind: "workspace-write", destructive: false },
  concurrency: {
    kind: "exclusive",
    reason: "May mutate workspace files.",
  },
  execute: ({ workspace, readBeforeEdit, projectInstructions }, args) => {
    if (projectInstructions !== undefined) {
      const target = resolveWorkspaceTarget(workspace, args.path, "edit");
      projectInstructions.assertMutationAllowed([target.targetPath]);
    }
    const edits = args.edits.map((edit) => ({
      oldText: edit.oldText,
      newText: edit.newText,
      ...(edit.replaceAll !== undefined ? { replaceAll: edit.replaceAll } : {}),
    }));
    const result = executeEdit(workspace, args.path, edits, {
      ...(readBeforeEdit !== undefined ? { readBeforeEdit } : {}),
    });
    return {
      content: result.content,
      ok: true,
      mutatedTargetPath: result.targetPath,
      checkpointOperations: [result.checkpointOperation],
    };
  },
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
  concurrency: {
    kind: "exclusive",
    reason: "Creates workspace files.",
  },
  execute: ({ workspace, projectInstructions }, args) => {
    if (projectInstructions !== undefined) {
      const target = resolveWorkspaceCreateTarget(
        workspace,
        args.path,
        "write",
      );
      projectInstructions.assertMutationAllowed([target.targetPath]);
    }
    const result = executeWrite(workspace, args.path, args.content);
    return {
      content: result.content,
      ok: true,
      mutatedTargetPath: result.targetPath,
      checkpointOperations: [result.checkpointOperation],
    };
  },
});

const applyPatchTool = defineTool({
  name: "apply_patch",
  description: [
    "Apply one patch containing workspace file additions and updates.",
    "Patch format: *** Begin Patch, then one or more *** Add File: <path> or *** Update File: <path> sections, then *** End Patch.",
    "Use when: making coordinated changes across multiple files after reading every file that will be updated.",
    "Do not use when: deleting, renaming, changing file modes, or editing binary files.",
    "On failure: read the current target files and regenerate the patch with exact context.",
  ].join("\n"),
  args: toolArgs(applyPatchToolArgumentsSchema),
  permission: { kind: "none" },
  output: { kind: "text" },
  display: {
    formatLabel: () => "apply_patch",
  },
  risk: { kind: "workspace-write", destructive: true },
  concurrency: {
    kind: "exclusive",
    reason: "May mutate multiple workspace files.",
  },
  execute: ({ workspace, readBeforeEdit, projectInstructions }, args) => {
    const result = executeApplyPatch(workspace, args.patch, {
      ...(readBeforeEdit !== undefined ? { readBeforeEdit } : {}),
      ...(projectInstructions !== undefined ? { projectInstructions } : {}),
    });
    return {
      content: result.content,
      ok: true,
      mutatedTargetPaths: result.targetPaths,
      checkpointOperations: result.checkpointOperations,
    };
  },
});

const bashTool = defineTool({
  name: "bash",
  description: [
    "Run a trusted shell command in the workspace. Commands use the current OS user's permissions and are not constrained by Keel's gitignore file-tool policy. Output is capped to the last 20KB per stream.",
    "Use when: the task needs commands the file tools cannot do, such as running builds, tests, or git.",
    "Do not use when: a dedicated tool can do the job - prefer read, ls, glob, grep, edit, and write for file inspection and changes.",
    "On failure: a non-zero exit code returns stdout/stderr for diagnosis - fix the command rather than retrying it unchanged; if the command timed out, raise timeoutMs (up to 60000) or run a narrower command.",
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
  concurrency: {
    kind: "exclusive",
    reason: "May mutate workspace or depend on process state.",
  },
  execute: async ({ workspace, signal, allowBash, bashPermission }, args) => {
    if (!allowBash) {
      return { content: disabledBashMessage(), ok: false };
    }

    if (bashPermission !== undefined) {
      const decision = await bashPermission.review({
        command: args.command,
        cwd: workspace,
        signal,
      });
      if (decision.type === "deny") {
        return {
          content: deniedBashMessage(decision.message),
          ok: false,
        };
      }
    }

    const result = await executeBash(workspace, args.command, {
      signal,
      ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
    });
    return { content: result.content, ok: true };
  },
});

export const builtinTools = [
  readTool,
  lsTool,
  globTool,
  grepTool,
  editTool,
  writeTool,
  applyPatchTool,
  bashTool,
] as const;

const rawBuiltinToolCallSchema = z.discriminatedUnion("tool", [
  readTool.toolCallSchema,
  lsTool.toolCallSchema,
  globTool.toolCallSchema,
  grepTool.toolCallSchema,
  editTool.toolCallSchema,
  writeTool.toolCallSchema,
  applyPatchTool.toolCallSchema,
  bashTool.toolCallSchema,
]);

export const builtinToolCallSchema = rawBuiltinToolCallSchema
  .transform(stripUndefinedProperties)
  .pipe(rawBuiltinToolCallSchema);
