import type { z } from "zod";
import type { BashPermissionPolicy } from "../permissions/bash.ts";
import { executeBash } from "./bash.ts";
import { executeEdit } from "./edit.ts";
import { executeGlob } from "./glob.ts";
import { executeGrep } from "./grep.ts";
import { executeLs } from "./ls.ts";
import { executeRead } from "./read.ts";
import {
  bashToolArgumentsSchema,
  editToolArgumentsSchema,
  globToolArgumentsSchema,
  grepToolArgumentsSchema,
  lsToolArgumentsSchema,
  readToolArgumentsSchema,
  writeToolArgumentsSchema,
} from "./tool-arguments.ts";
import { executeWrite } from "./write.ts";

export interface ToolArgDefinition {
  readonly type: "string" | "integer" | "boolean";
  readonly description: string;
  readonly required: boolean;
  readonly minimum?: number;
  readonly maximum?: number;
}

type ToolArgShape = z.ZodRawShape;

type ToolArgFields<Shape extends ToolArgShape> = Readonly<{
  [Field in keyof Shape & string]: ToolArgDefinition;
}>;

type ToolArgsSchema<Shape extends ToolArgShape> = z.ZodObject<
  Shape,
  z.core.$strict
>;

interface ToolArgsSpec<Shape extends ToolArgShape> {
  readonly schema: ToolArgsSchema<Shape>;
  readonly fields: ToolArgFields<Shape>;
}

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

type ToolConcurrency =
  | { readonly kind: "parallel-safe" }
  | { readonly kind: "exclusive"; readonly reason: string };

export interface BuiltinToolExecutionContext {
  readonly workspace: string;
  readonly signal: AbortSignal;
  readonly allowBash: boolean;
  readonly bashPermission?: BashPermissionPolicy;
}

export interface ToolExecution {
  readonly content: string;
  readonly ok: boolean;
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

interface BuiltinTool<Name extends string, Shape extends ToolArgShape> {
  readonly name: Name;
  readonly description: string;
  readonly args: ToolArgsSpec<Shape>;
  readonly permission: ToolPermission<z.infer<ToolArgsSchema<Shape>>>;
  readonly output: ToolOutput;
  readonly display: ToolDisplay<z.infer<ToolArgsSchema<Shape>>>;
  readonly risk: ToolRisk;
  readonly concurrency: ToolConcurrency;
  readonly execute: BuiltinToolExecution<z.infer<ToolArgsSchema<Shape>>>;
}

interface BuiltinToolRuntime<Name extends string, Shape extends ToolArgShape>
  extends BuiltinTool<Name, Shape> {
  readonly isCall: (
    toolCall: BuiltinToolCallInput,
  ) => toolCall is BuiltinToolCallInput & {
    readonly tool: Name;
  } & z.infer<ToolArgsSchema<Shape>>;
  readonly argumentsFromCall: (
    toolCall: BuiltinToolCallInput,
  ) => Record<string, unknown>;
  readonly canonicalArgumentsFromCall: (
    toolCall: BuiltinToolCallInput,
  ) => Record<string, unknown>;
  readonly formatCallLabel: (toolCall: BuiltinToolCallInput) => string;
  readonly executeCall: (
    context: BuiltinToolExecutionContext,
    toolCall: BuiltinToolCallInput,
  ) => ToolExecution | Promise<ToolExecution>;
}

interface ToolArgOptions {
  readonly required: boolean;
  readonly description: string;
}

interface IntegerToolArgOptions extends ToolArgOptions {
  readonly minimum: number;
  readonly maximum?: number;
}

function objectFieldValue(input: object, key: string): ObjectFieldValue {
  for (const [name, value] of Object.entries(input)) {
    if (name === key) {
      return { exists: true, value };
    }
  }
  return { exists: false };
}

function isToolArgValue(field: ToolArgDefinition, value: unknown): boolean {
  if (value === undefined) {
    return !field.required;
  }

  switch (field.type) {
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
  }
}

function defineTool<
  const Name extends string,
  const Shape extends ToolArgShape,
>(tool: BuiltinTool<Name, Shape>): BuiltinToolRuntime<Name, Shape> {
  function argumentsFromCall(
    toolCall: BuiltinToolCallInput,
  ): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    for (const [name] of Object.entries(tool.args.fields)) {
      const value = objectFieldValue(toolCall, name);
      if (value.exists && value.value !== undefined && value.value !== null) {
        args[name] = value.value;
      }
    }
    return args;
  }

  function canonicalArgumentsFromCall(
    toolCall: BuiltinToolCallInput,
  ): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    for (const [name, field] of Object.entries(tool.args.fields)) {
      const value = objectFieldValue(toolCall, name);
      if (!value.exists || value.value === undefined || value.value === null) {
        if (field.required) {
          throw new Error(`Invalid builtin tool call for ${tool.name}`);
        }
        args[name] = null;
        continue;
      }
      args[name] = value.value;
    }
    return args;
  }

  function hasCallArgumentShape(toolCall: BuiltinToolCallInput): boolean {
    for (const [name, field] of Object.entries(tool.args.fields)) {
      const value = objectFieldValue(toolCall, name);
      if (!value.exists) {
        if (field.required) {
          return false;
        }
        continue;
      }

      if (!isToolArgValue(field, value.value)) {
        return false;
      }
    }
    return true;
  }

  function isCallForThisTool(
    toolCall: BuiltinToolCallInput,
  ): toolCall is BuiltinToolCallInput & {
    readonly tool: Name;
  } & z.infer<ToolArgsSchema<Shape>> {
    return toolCall.tool === tool.name && hasCallArgumentShape(toolCall);
  }

  function formatCallLabel(toolCall: BuiltinToolCallInput): string {
    if (isCallForThisTool(toolCall)) {
      return tool.display.formatLabel(toolCall);
    }
    throw new Error(`Invalid builtin tool call for ${tool.name}`);
  }

  return Object.assign({}, tool, {
    isCall: isCallForThisTool,
    argumentsFromCall,
    canonicalArgumentsFromCall,
    formatCallLabel,
    executeCall: (
      context: BuiltinToolExecutionContext,
      toolCall: BuiltinToolCallInput,
    ) => {
      if (isCallForThisTool(toolCall)) {
        return tool.execute(context, toolCall);
      }
      throw new Error(`Invalid builtin tool call for ${tool.name}`);
    },
  });
}

function toolArgs<const Shape extends ToolArgShape>(
  schema: ToolArgsSchema<Shape>,
  fields: ToolArgFields<Shape>,
): ToolArgsSpec<Shape> {
  return { schema, fields };
}

function stringArg(options: ToolArgOptions): ToolArgDefinition {
  return {
    type: "string",
    description: options.description,
    required: options.required,
  };
}

function integerArg(options: IntegerToolArgOptions): ToolArgDefinition {
  return {
    type: "integer",
    description: options.description,
    required: options.required,
    minimum: options.minimum,
    ...(options.maximum !== undefined ? { maximum: options.maximum } : {}),
  };
}

function booleanArg(options: ToolArgOptions): ToolArgDefinition {
  return {
    type: "boolean",
    description: options.description,
    required: options.required,
  };
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
  args: toolArgs(readToolArgumentsSchema, {
    path: stringArg({
      required: true,
      description: "Workspace-relative file path to read.",
    }),
    offset: integerArg({
      required: false,
      minimum: 1,
      description: "Optional 1-indexed line number to start reading from.",
    }),
    limit: integerArg({
      required: false,
      minimum: 1,
      description: "Optional maximum number of lines to read.",
    }),
  }),
  permission: { kind: "none" },
  output: { kind: "text" },
  display: {
    formatLabel: (args) => `read ${args.path}`,
  },
  risk: { kind: "workspace-read" },
  concurrency: { kind: "parallel-safe" },
  execute: ({ workspace }, args) => {
    const result = executeRead(workspace, args.path, {
      offset: args.offset,
      limit: args.limit,
    });
    return { content: result.content, ok: true };
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
  args: toolArgs(lsToolArgumentsSchema, {
    path: stringArg({
      required: false,
      description:
        "Optional workspace-relative directory to list. Defaults to the workspace root.",
    }),
    limit: integerArg({
      required: false,
      minimum: 1,
      maximum: 1000,
      description:
        "Optional maximum number of entries to return. Defaults to 200.",
    }),
  }),
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
  args: toolArgs(globToolArgumentsSchema, {
    pattern: stringArg({
      required: true,
      description:
        'Glob pattern for file paths, such as "**/*.test.ts" or "src/**/*.tsx".',
    }),
    path: stringArg({
      required: false,
      description:
        "Optional workspace-relative directory to search. Defaults to the whole workspace.",
    }),
  }),
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
  args: toolArgs(grepToolArgumentsSchema, {
    pattern: stringArg({
      required: true,
      description: "Literal text to search for.",
    }),
    path: stringArg({
      required: false,
      description:
        "Optional workspace-relative file or directory to search. Defaults to the whole workspace.",
    }),
  }),
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
    "Replace text in an existing workspace file. oldString should be copied from the current file content and identify one target unless replaceAll is true.",
    "Use when: changing an existing file after read confirmed the exact target text.",
    "Do not use when: creating a new file (use write), or when you have not read the file and would be guessing oldString from memory.",
    "For single-target edits, Keel can correct harmless line-ending, trailing-space, smart-punctuation, and common-indentation differences while preserving unrelated file bytes.",
    "Large generated files, bundles, and logs may exceed the edit safety limit; inspect them with grep/read and use a targeted external command when appropriate.",
    "On failure: if the string is not found, read the file and retry with the exact current text; if it appears more than once, include more surrounding lines in oldString to make it unique.",
  ].join("\n"),
  args: toolArgs(editToolArgumentsSchema, {
    path: stringArg({
      required: true,
      description: "Workspace-relative file path to edit.",
    }),
    oldString: stringArg({
      required: true,
      description:
        "Text to replace. Copy it from read output; by default it must identify one target.",
    }),
    newString: stringArg({
      required: true,
      description: "Replacement text.",
    }),
    replaceAll: booleanArg({
      required: false,
      description:
        "When true, replace every exact occurrence of oldString. Defaults to false, which requires oldString to identify one target.",
    }),
  }),
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
  execute: ({ workspace }, args) => {
    const result = executeEdit(
      workspace,
      args.path,
      args.oldString,
      args.newString,
      args.replaceAll !== undefined ? { replaceAll: args.replaceAll } : {},
    );
    return { content: result.content, ok: true };
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
  args: toolArgs(writeToolArgumentsSchema, {
    path: stringArg({
      required: true,
      description: "Workspace-relative file path to create.",
    }),
    content: stringArg({
      required: true,
      description: "Complete file content to write.",
    }),
  }),
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
  execute: ({ workspace }, args) => {
    const result = executeWrite(workspace, args.path, args.content);
    return { content: result.content, ok: true };
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
  args: toolArgs(bashToolArgumentsSchema, {
    command: stringArg({
      required: true,
      description: "Shell command to execute.",
    }),
    timeoutMs: integerArg({
      required: false,
      minimum: 1,
      maximum: 60_000,
      description:
        "Optional command timeout in milliseconds. Defaults to 10000ms.",
    }),
  }),
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
  bashTool,
] as const;
