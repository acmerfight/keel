import { z } from "zod";

interface OpenAICompatibleToolParameter {
  readonly type: "string" | "integer" | "object" | "boolean";
  readonly description?: string;
  readonly minimum?: number;
  readonly maximum?: number;
}

interface OpenAICompatibleToolParameters {
  readonly type: "object";
  readonly properties: Record<string, OpenAICompatibleToolParameter>;
  readonly required: readonly string[];
  readonly additionalProperties: false;
}

export interface OpenAICompatibleToolDefinition {
  readonly type: "function";
  readonly function: {
    readonly name: ToolName;
    readonly description: string;
    readonly parameters: OpenAICompatibleToolParameters;
  };
}

export type ToolCall =
  | {
      readonly id: string;
      readonly tool: "read";
      readonly path: string;
      readonly offset?: number;
      readonly limit?: number;
    }
  | {
      readonly id: string;
      readonly tool: "grep";
      readonly pattern: string;
      readonly path?: string;
    }
  | {
      readonly id: string;
      readonly tool: "edit";
      readonly path: string;
      readonly oldString: string;
      readonly newString: string;
      readonly replaceAll?: boolean;
    }
  | {
      readonly id: string;
      readonly tool: "write";
      readonly path: string;
      readonly content: string;
    }
  | {
      readonly id: string;
      readonly tool: "bash";
      readonly command: string;
      readonly timeoutMs?: number;
    };

export type ToolName = ToolCall["tool"];

const readToolArgumentsSchema = z
  .object({
    path: z.string(),
    offset: z.number().int().positive().optional(),
    limit: z.number().int().positive().optional(),
  })
  .strict();

const grepToolArgumentsSchema = z
  .object({
    pattern: z.string(),
    path: z.string().optional(),
  })
  .strict();

const editToolArgumentsSchema = z
  .object({
    path: z.string(),
    oldString: z.string(),
    newString: z.string(),
    replaceAll: z.boolean().optional(),
  })
  .strict();

const writeToolArgumentsSchema = z
  .object({
    path: z.string(),
    content: z.string(),
  })
  .strict();

const bashToolArgumentsSchema = z
  .object({
    command: z.string(),
    timeoutMs: z.number().int().positive().max(60_000).optional(),
  })
  .strict();

const readTool: OpenAICompatibleToolDefinition = {
  type: "function",
  function: {
    name: "read",
    description: [
      "Read a workspace text file. Output is capped at 2000 lines or 50KB; use offset and limit to read later sections.",
      "Use when: you need exact file content, especially before editing or after grep located a match.",
      "Do not use when: the path is a directory or a binary file, or you only need to find where text lives across files (use grep).",
      "On failure: if the file is not found, grep for a distinctive string to discover the correct path; if output is truncated, read again with offset and limit.",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative file path to read.",
        },
        offset: {
          type: "integer",
          minimum: 1,
          description: "Optional 1-indexed line number to start reading from.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          description: "Optional maximum number of lines to read.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
};

const grepTool: OpenAICompatibleToolDefinition = {
  type: "function",
  function: {
    name: "grep",
    description: [
      "Search workspace text files for a literal single-line string, skipping gitignored files. Returns capped path:line:snippet matches.",
      "Use when: locating code, file paths, or usages before reading or editing - do not guess file paths.",
      "Do not use when: you already know the exact file and need its content (use read); the pattern is a regex or spans multiple lines (not supported).",
      "On failure: if the pattern contains newlines, search for a unique single-line substring instead; zero matches means the text is absent from non-ignored files - retry with a shorter or different substring before concluding it does not exist.",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Literal text to search for.",
        },
        path: {
          type: "string",
          description:
            "Optional workspace-relative file or directory to search. Defaults to the whole workspace.",
        },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
};

const editTool: OpenAICompatibleToolDefinition = {
  type: "function",
  function: {
    name: "edit",
    description: [
      "Replace text in an existing workspace file. oldString should be copied from the current file content and identify one target unless replaceAll is true.",
      "Use when: changing an existing file after read confirmed the exact target text.",
      "Do not use when: creating a new file (use write), or when you have not read the file and would be guessing oldString from memory.",
      "Keel can correct harmless line-ending, trailing-space, and common-indentation differences while preserving unrelated file bytes.",
      "On failure: if the string is not found, read the file and retry with the exact current text; if it appears more than once, include more surrounding lines in oldString to make it unique.",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative file path to edit.",
        },
        oldString: {
          type: "string",
          description:
            "Text to replace. Copy it from read output; by default it must identify one target.",
        },
        newString: {
          type: "string",
          description: "Replacement text.",
        },
        replaceAll: {
          type: "boolean",
          description:
            "When true, replace every exact occurrence of oldString. Defaults to false, which requires oldString to identify one target.",
        },
      },
      required: ["path", "oldString", "newString"],
      additionalProperties: false,
    },
  },
};

const writeTool: OpenAICompatibleToolDefinition = {
  type: "function",
  function: {
    name: "write",
    description: [
      "Create a new workspace file with the given content. Fails if the file already exists. Automatically creates parent directories.",
      "Use when: adding a file that does not exist yet.",
      "Do not use when: the file already exists (use edit to change it).",
      "On failure: if the file already exists, read it and apply edit instead of recreating it.",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative file path to create.",
        },
        content: {
          type: "string",
          description: "Complete file content to write.",
        },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
};

const bashTool: OpenAICompatibleToolDefinition = {
  type: "function",
  function: {
    name: "bash",
    description: [
      "Run a trusted shell command in the workspace. Commands use the current OS user's permissions and are not constrained by Keel's gitignore file-tool policy. Output is capped to the last 20KB per stream.",
      "Use when: the task needs commands the file tools cannot do, such as running builds, tests, or git.",
      "Do not use when: a dedicated tool can do the job - prefer read, grep, edit, and write for file inspection and changes.",
      "On failure: a non-zero exit code returns stdout/stderr for diagnosis - fix the command rather than retrying it unchanged; if the command timed out, raise timeoutMs (up to 60000) or run a narrower command.",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Shell command to execute.",
        },
        timeoutMs: {
          type: "integer",
          minimum: 1,
          maximum: 60_000,
          description:
            "Optional command timeout in milliseconds. Defaults to 10000ms.",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
};

export function isToolName(name: string): name is ToolName {
  return (
    name === "read" ||
    name === "grep" ||
    name === "edit" ||
    name === "write" ||
    name === "bash"
  );
}

export function openAICompatibleTools(
  allowBash: boolean,
): readonly OpenAICompatibleToolDefinition[] {
  return allowBash
    ? [readTool, grepTool, editTool, writeTool, bashTool]
    : [readTool, grepTool, editTool, writeTool];
}

export function toolCallFromParsedArguments(
  id: string,
  name: ToolName,
  parsedArguments: unknown,
): ToolCall | null {
  switch (name) {
    case "read": {
      const result = readToolArgumentsSchema.safeParse(parsedArguments);
      if (!result.success) return null;
      return {
        id,
        tool: "read",
        path: result.data.path,
        ...(result.data.offset !== undefined
          ? { offset: result.data.offset }
          : {}),
        ...(result.data.limit !== undefined
          ? { limit: result.data.limit }
          : {}),
      };
    }
    case "grep": {
      const result = grepToolArgumentsSchema.safeParse(parsedArguments);
      if (!result.success) return null;
      return {
        id,
        tool: "grep",
        pattern: result.data.pattern,
        ...(result.data.path !== undefined ? { path: result.data.path } : {}),
      };
    }
    case "edit": {
      const result = editToolArgumentsSchema.safeParse(parsedArguments);
      if (!result.success) return null;
      return {
        id,
        tool: "edit",
        path: result.data.path,
        oldString: result.data.oldString,
        newString: result.data.newString,
        ...(result.data.replaceAll !== undefined
          ? { replaceAll: result.data.replaceAll }
          : {}),
      };
    }
    case "write": {
      const result = writeToolArgumentsSchema.safeParse(parsedArguments);
      if (!result.success) return null;
      return {
        id,
        tool: "write",
        path: result.data.path,
        content: result.data.content,
      };
    }
    case "bash": {
      const result = bashToolArgumentsSchema.safeParse(parsedArguments);
      if (!result.success) return null;
      return {
        id,
        tool: "bash",
        command: result.data.command,
        ...(result.data.timeoutMs !== undefined
          ? { timeoutMs: result.data.timeoutMs }
          : {}),
      };
    }
  }
}

export function toolCallArguments(toolCall: ToolCall): Record<string, unknown> {
  switch (toolCall.tool) {
    case "read":
      return {
        path: toolCall.path,
        ...(toolCall.offset !== undefined ? { offset: toolCall.offset } : {}),
        ...(toolCall.limit !== undefined ? { limit: toolCall.limit } : {}),
      };
    case "grep":
      return {
        pattern: toolCall.pattern,
        ...(toolCall.path !== undefined ? { path: toolCall.path } : {}),
      };
    case "edit":
      return {
        path: toolCall.path,
        oldString: toolCall.oldString,
        newString: toolCall.newString,
        ...(toolCall.replaceAll !== undefined
          ? { replaceAll: toolCall.replaceAll }
          : {}),
      };
    case "write":
      return {
        path: toolCall.path,
        content: toolCall.content,
      };
    case "bash":
      return {
        command: toolCall.command,
        ...(toolCall.timeoutMs !== undefined
          ? { timeoutMs: toolCall.timeoutMs }
          : {}),
      };
  }
}
