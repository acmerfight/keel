import type { z } from "zod";
import {
  bashToolArgumentsSchema,
  editToolArgumentsSchema,
  globToolArgumentsSchema,
  grepToolArgumentsSchema,
  lsToolArgumentsSchema,
  readToolArgumentsSchema,
  writeToolArgumentsSchema,
} from "./tool-arguments.ts";

type ToolArgType = "string" | "integer" | "boolean";

interface ToolArgDefinition {
  readonly type: ToolArgType;
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
  z.core.$ZodObjectConfig
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

interface BuiltinToolExecution {
  readonly kind: "legacy-switch";
  readonly owner: "executeToolCall";
}

interface BuiltinTool<Name extends string, Shape extends ToolArgShape> {
  readonly name: Name;
  readonly description: string;
  readonly args: ToolArgsSpec<Shape>;
  readonly permission: ToolPermission<z.infer<ToolArgsSchema<Shape>>>;
  readonly output: ToolOutput;
  readonly display: ToolDisplay<z.infer<ToolArgsSchema<Shape>>>;
  readonly risk: ToolRisk;
  readonly concurrency: ToolConcurrency;
  readonly execute: BuiltinToolExecution;
}

interface ToolArgOptions {
  readonly required: boolean;
  readonly description: string;
}

interface IntegerToolArgOptions extends ToolArgOptions {
  readonly minimum: number;
  readonly maximum?: number;
}

function defineTool<
  const Name extends string,
  const Shape extends ToolArgShape,
>(tool: BuiltinTool<Name, Shape>): BuiltinTool<Name, Shape> {
  return tool;
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

const legacySwitchExecution: BuiltinToolExecution = {
  kind: "legacy-switch",
  owner: "executeToolCall",
};

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
  execute: legacySwitchExecution,
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
  execute: legacySwitchExecution,
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
  execute: legacySwitchExecution,
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
  execute: legacySwitchExecution,
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
  execute: legacySwitchExecution,
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
  execute: legacySwitchExecution,
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
  execute: legacySwitchExecution,
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
