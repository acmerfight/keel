import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { builtinTools } from "../../src/tools/builtin.ts";
import type { OpenAICompatibleToolDefinition } from "../../src/tools/registry.ts";
import {
  isToolName,
  openAICompatibleTools,
  type ToolName,
  toolCallArguments,
  toolCallCanonicalArguments,
  toolCallFromParsedArguments,
} from "../../src/tools/registry.ts";

type ProviderField = {
  readonly type: "string" | "integer" | "boolean";
  readonly description: string;
  readonly required: boolean;
  readonly minimum?: number;
  readonly maximum?: number;
};

type ProviderParameter =
  OpenAICompatibleToolDefinition["function"]["parameters"]["properties"][string];
type RegisteredBuiltinTool = (typeof builtinTools)[number];

function builtinToolByName<Name extends ToolName>(
  name: Name,
): Extract<RegisteredBuiltinTool, { readonly name: Name }> {
  const tool = builtinTools.find(
    (
      candidate,
    ): candidate is Extract<RegisteredBuiltinTool, { readonly name: Name }> =>
      candidate.name === name,
  );
  if (tool === undefined) {
    throw new Error(`Expected builtin tool ${name} to be registered`);
  }
  return tool;
}

function inclusiveIntegerMinimum(
  schemaField: z.core.JSONSchema.JSONSchema,
): number | undefined {
  if (typeof schemaField.minimum === "number") {
    return schemaField.minimum;
  }

  if (
    schemaField.type === "integer" &&
    typeof schemaField.exclusiveMinimum === "number"
  ) {
    return schemaField.exclusiveMinimum + 1;
  }

  return undefined;
}

function inclusiveIntegerMaximum(
  schemaField: z.core.JSONSchema.JSONSchema,
): number | undefined {
  if (
    schemaField.type === "integer" &&
    schemaField.maximum === Number.MAX_SAFE_INTEGER
  ) {
    return undefined;
  }

  if (typeof schemaField.maximum === "number") {
    return schemaField.maximum;
  }

  if (
    schemaField.type === "integer" &&
    typeof schemaField.exclusiveMaximum === "number"
  ) {
    return schemaField.exclusiveMaximum - 1;
  }

  return undefined;
}

function validProviderValue(field: ProviderField): string | number | boolean {
  switch (field.type) {
    case "string":
      return "value";
    case "integer":
      if (field.minimum === undefined) {
        throw new Error("integer provider field is missing minimum");
      }
      return field.minimum;
    case "boolean":
      return true;
  }
}

function providerParameterFromField(field: ProviderField): ProviderParameter {
  return {
    type: field.type,
    description: field.description,
    ...(field.minimum !== undefined ? { minimum: field.minimum } : {}),
    ...(field.maximum !== undefined ? { maximum: field.maximum } : {}),
  };
}

function providerDefinitionFromBuiltinTool(
  tool: (typeof builtinTools)[number],
): OpenAICompatibleToolDefinition {
  const properties: Record<string, ProviderParameter> = {};
  const required: string[] = [];

  for (const [name, field] of Object.entries(tool.args.fields)) {
    properties[name] = providerParameterFromField(field);
    if (field.required) {
      required.push(name);
    }
  }

  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: "object",
        properties,
        required,
        additionalProperties: false,
      },
    },
  };
}

describe("tool registry", () => {
  test(`Given apply_patch receives an add-only patch through the builtin registry,
    When the call has no read-before-edit state,
    Then the tool writes the new file and returns every mutated target`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-registry-patch-"));
    const workspacePath = await realpath(workspace);
    const applyPatchTool = builtinToolByName("apply_patch");
    const patch = [
      "*** Begin Patch",
      "*** Add File: note.txt",
      "+created",
      "*** End Patch",
    ].join("\n");
    const call = toolCallFromParsedArguments("call_patch", "apply_patch", {
      patch,
    });
    if (call === null) {
      throw new Error("Expected apply_patch call to parse");
    }
    expect(applyPatchTool.name).toBe("apply_patch");

    try {
      // When
      const result = await applyPatchTool.executeCall(
        {
          workspace,
          signal: new AbortController().signal,
          allowBash: false,
        },
        call,
      );

      // Then
      expect(result).toEqual({
        ok: true,
        content: "Applied patch:\nA note.txt",
        mutatedTargetPaths: [join(workspacePath, "note.txt")],
        checkpointOperations: [
          {
            operation: "create",
            filePath: join(workspacePath, "note.txt"),
            afterContent: "created\n",
          },
        ],
      });
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "created\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given builtin tools declare display contracts,
    When labels and approval prompts are rendered,
    Then each tool has explicit user-visible text without generic fallback`, () => {
    const readTool = builtinToolByName("read");
    const lsTool = builtinToolByName("ls");
    const globTool = builtinToolByName("glob");
    const grepTool = builtinToolByName("grep");
    const editTool = builtinToolByName("edit");
    const writeTool = builtinToolByName("write");
    const applyPatchTool = builtinToolByName("apply_patch");
    const bashTool = builtinToolByName("bash");

    expect(readTool.display.formatLabel({ path: "src/index.ts" })).toBe(
      "read src/index.ts",
    );
    expect(lsTool.display.formatLabel({})).toBe("ls .");
    expect(lsTool.display.formatLabel({ path: "src" })).toBe("ls src");
    expect(
      globTool.display.formatLabel({ pattern: "**/*.ts", path: "src" }),
    ).toBe("glob **/*.ts src");
    expect(globTool.display.formatLabel({ pattern: "**/*.ts" })).toBe(
      "glob **/*.ts",
    );
    expect(grepTool.display.formatLabel({ pattern: "needle" })).toBe(
      "grep needle",
    );
    expect(
      grepTool.display.formatLabel({ pattern: "needle", path: "src" }),
    ).toBe("grep needle src");
    expect(
      editTool.display.formatLabel({
        path: "a.ts",
        oldString: "old",
        newString: "new",
      }),
    ).toBe("edit a.ts");
    expect(
      writeTool.display.formatLabel({ path: "new.ts", content: "new" }),
    ).toBe("write new.ts");
    expect(
      applyPatchTool.display.formatLabel({
        patch: "*** Begin Patch\n*** End Patch",
      }),
    ).toBe("apply_patch");
    expect(bashTool.display.formatLabel({ command: "pnpm test" })).toBe(
      "bash pnpm test",
    );

    expect(bashTool.permission.kind).toBe("approval");
    if (bashTool.permission.kind === "approval") {
      expect(bashTool.permission.renderPrompt({ command: "pnpm test" })).toBe(
        "Run shell command: pnpm test",
      );
    }
  });

  test(`Given builtin tools declare their contracts,
    When the registry metadata is inspected,
    Then every builtin tool has a unique name in stable order`, () => {
    const names = builtinTools.map((tool) => tool.name);

    expect(names).toEqual([
      "read",
      "ls",
      "glob",
      "grep",
      "edit",
      "write",
      "apply_patch",
      "bash",
    ]);
    expect(new Set(names).size).toBe(names.length);
  });

  test(`Given builtin tools declare their behavior contracts,
    When the registry metadata is inspected,
    Then each tool makes permission output risk and concurrency explicit`, () => {
    const contracts = builtinTools.map((tool) => ({
      name: tool.name,
      permission: tool.permission.kind,
      output: tool.output.kind,
      risk: tool.risk,
      concurrency: tool.concurrency,
      hasFormatLabel: typeof tool.display.formatLabel === "function",
      hasExecute: typeof tool.execute === "function",
    }));

    expect(contracts).toEqual([
      {
        name: "read",
        permission: "none",
        output: "text",
        risk: { kind: "workspace-read" },
        concurrency: { kind: "parallel-safe" },
        hasFormatLabel: true,
        hasExecute: true,
      },
      {
        name: "ls",
        permission: "none",
        output: "text",
        risk: { kind: "workspace-read" },
        concurrency: { kind: "parallel-safe" },
        hasFormatLabel: true,
        hasExecute: true,
      },
      {
        name: "glob",
        permission: "none",
        output: "text",
        risk: { kind: "workspace-read" },
        concurrency: { kind: "parallel-safe" },
        hasFormatLabel: true,
        hasExecute: true,
      },
      {
        name: "grep",
        permission: "none",
        output: "text",
        risk: { kind: "workspace-read" },
        concurrency: { kind: "parallel-safe" },
        hasFormatLabel: true,
        hasExecute: true,
      },
      {
        name: "edit",
        permission: "none",
        output: "text",
        risk: { kind: "workspace-write", destructive: false },
        concurrency: {
          kind: "exclusive",
          reason: "May mutate workspace files.",
        },
        hasFormatLabel: true,
        hasExecute: true,
      },
      {
        name: "write",
        permission: "none",
        output: "text",
        risk: { kind: "workspace-write", destructive: true },
        concurrency: {
          kind: "exclusive",
          reason: "Creates workspace files.",
        },
        hasFormatLabel: true,
        hasExecute: true,
      },
      {
        name: "apply_patch",
        permission: "none",
        output: "text",
        risk: { kind: "workspace-write", destructive: true },
        concurrency: {
          kind: "exclusive",
          reason: "May mutate multiple workspace files.",
        },
        hasFormatLabel: true,
        hasExecute: true,
      },
      {
        name: "bash",
        permission: "approval",
        output: "text",
        risk: { kind: "trusted-shell" },
        concurrency: {
          kind: "exclusive",
          reason: "May mutate workspace or depend on process state.",
        },
        hasFormatLabel: true,
        hasExecute: true,
      },
    ]);
  });

  test(`Given builtin tool execution receives a matching call without required arguments,
    When the registry-owned execution guard validates the call,
    Then it rejects the malformed internal call before reaching the tool executor`, () => {
    const readTool = builtinToolByName("read");
    expect(readTool.name).toBe("read");

    expect(() =>
      readTool.executeCall(
        {
          workspace: ".",
          signal: new AbortController().signal,
          allowBash: false,
        },
        { id: "call_read", tool: "read" },
      ),
    ).toThrow("Invalid builtin tool call for read");
  });

  test(`Given builtin tool execution receives a matching call with an invalid argument type,
    When the registry-owned execution guard validates the call,
    Then it rejects the malformed internal call before tool-specific validation runs`, () => {
    const readTool = builtinToolByName("read");
    const malformedCall = {
      id: "call_read",
      tool: "read",
      path: "note.txt",
      offset: "1",
    };
    expect(readTool.name).toBe("read");

    expect(() =>
      readTool.executeCall(
        {
          workspace: ".",
          signal: new AbortController().signal,
          allowBash: false,
        },
        malformedCall,
      ),
    ).toThrow("Invalid builtin tool call for read");
  });

  test(`Given builtin tool execution receives an integer argument with a fractional value,
    When the registry-owned execution guard validates the call,
    Then it rejects the malformed internal call before tool-specific validation runs`, () => {
    const bashTool = builtinToolByName("bash");
    const malformedCall = {
      id: "call_bash",
      tool: "bash",
      command: "printf ok",
      timeoutMs: 1.5,
    };
    expect(bashTool.name).toBe("bash");

    expect(() =>
      bashTool.executeCall(
        {
          workspace: ".",
          signal: new AbortController().signal,
          allowBash: false,
        },
        malformedCall,
      ),
    ).toThrow("Invalid builtin tool call for bash");
  });

  test(`Given builtin tool execution receives a matching call with an explicit undefined optional argument,
    When the registry-owned execution guard validates the call,
    Then it treats the optional argument as absent`, async () => {
    const bashTool = builtinToolByName("bash");
    const callWithAbsentOptional = {
      id: "call_bash",
      tool: "bash",
      command: "printf ok",
      timeoutMs: undefined,
    };
    expect(bashTool.name).toBe("bash");

    await expect(
      bashTool.executeCall(
        {
          workspace: ".",
          signal: new AbortController().signal,
          allowBash: false,
        },
        callWithAbsentOptional,
      ),
    ).resolves.toEqual({
      ok: false,
      content:
        "Tool failed: bash failed: shell commands are disabled. Re-run with --bash-policy ask, --bash-policy trusted, or --allow-bash to enable them.",
    });
  });

  test(`Given builtin tool execution receives a matching call with an explicit null optional argument,
    When the registry-owned execution guard validates the internal call,
    Then it rejects the malformed call instead of widening the ToolCall type`, () => {
    const bashTool = builtinToolByName("bash");
    const malformedCall = {
      id: "call_bash",
      tool: "bash",
      command: "printf ok",
      timeoutMs: null,
    };
    expect(bashTool.name).toBe("bash");

    expect(() =>
      bashTool.executeCall(
        {
          workspace: ".",
          signal: new AbortController().signal,
          allowBash: false,
        },
        malformedCall,
      ),
    ).toThrow("Invalid builtin tool call for bash");
  });

  test(`Given registry-derived builtin call helpers receive malformed internal calls,
    When they validate the call before deriving labels or canonical arguments,
    Then they reject missing required fields`, () => {
    const readTool = builtinToolByName("read");
    const malformedCall = { id: "call_read", tool: "read" };
    expect(readTool.name).toBe("read");

    expect(() => readTool.formatCallLabel(malformedCall)).toThrow(
      "Invalid builtin tool call for read",
    );
    expect(() => readTool.canonicalArgumentsFromCall(malformedCall)).toThrow(
      "Invalid builtin tool call for read",
    );
  });

  test(`Given builtin tools declare their argument contracts,
    When the registry metadata is inspected,
    Then each tool lists its provider-visible arguments and required fields`, () => {
    const argumentsByTool = Object.fromEntries(
      builtinTools.map((tool) => [
        tool.name,
        {
          fields: Object.keys(tool.args.fields),
          required: Object.entries(tool.args.fields)
            .filter(([, field]) => field.required)
            .map(([name]) => name),
        },
      ]),
    );

    expect(argumentsByTool).toEqual({
      read: { fields: ["path", "offset", "limit"], required: ["path"] },
      ls: { fields: ["path", "limit"], required: [] },
      glob: { fields: ["pattern", "path"], required: ["pattern"] },
      grep: { fields: ["pattern", "path"], required: ["pattern"] },
      edit: {
        fields: ["path", "oldString", "newString", "replaceAll"],
        required: ["path", "oldString", "newString"],
      },
      write: { fields: ["path", "content"], required: ["path", "content"] },
      apply_patch: { fields: ["patch"], required: ["patch"] },
      bash: { fields: ["command", "timeoutMs"], required: ["command"] },
    });
  });

  test(`Given builtin tools declare arguments in Zod and provider metadata,
    When metadata is compared with generated JSON schema,
    Then keys requiredness types and numeric bounds stay equivalent`, () => {
    for (const tool of builtinTools) {
      const jsonSchema = z.toJSONSchema(tool.args.schema);
      const schemaFields = jsonSchema.properties ?? {};
      const metadataFields = tool.args.fields;
      const fieldKeys = Object.keys(metadataFields).sort();
      const requiredFields = Object.entries(metadataFields)
        .filter(([, field]) => field.required)
        .map(([name]) => name)
        .sort();
      const completeArgs = Object.fromEntries(
        Object.entries(metadataFields).map(([name, field]) => [
          name,
          validProviderValue(field),
        ]),
      );

      expect(jsonSchema.type, `${tool.name} schema must be an object`).toBe(
        "object",
      );
      expect(
        jsonSchema.additionalProperties,
        `${tool.name} schema must reject unknown fields`,
      ).toBe(false);
      expect(
        Object.keys(schemaFields).sort(),
        `${tool.name} fields/schema key mismatch`,
      ).toEqual(fieldKeys);
      expect(
        [...(jsonSchema.required ?? [])].sort(),
        `${tool.name} required field drift`,
      ).toEqual(requiredFields);
      expect(
        tool.args.schema.safeParse(completeArgs).success,
        `${tool.name} metadata-derived arguments must parse`,
      ).toBe(true);

      for (const [fieldName, field] of Object.entries(metadataFields)) {
        const schemaField = schemaFields[fieldName];

        if (schemaField === undefined || typeof schemaField === "boolean") {
          throw new Error(`${tool.name}.${fieldName} schema field is missing`);
        }

        expect(schemaField.type, `${tool.name}.${fieldName} type drift`).toBe(
          field.type,
        );
        expect(
          inclusiveIntegerMinimum(schemaField),
          `${tool.name}.${fieldName} minimum drift`,
        ).toBe(field.minimum);
        expect(
          inclusiveIntegerMaximum(schemaField),
          `${tool.name}.${fieldName} maximum drift`,
        ).toBe(field.maximum);
      }
    }
  });

  test(`Given provider exposure is derived from the builtin registry,
    When builtin metadata is compared with provider tools,
    Then bash filtering matches the explicit trusted shell risk`, () => {
    const allBuiltinToolNames = builtinTools.map((tool) => tool.name);
    const nonShellBuiltinToolNames = builtinTools
      .filter((tool) => tool.risk.kind !== "trusted-shell")
      .map((tool) => tool.name);

    expect(
      openAICompatibleTools(false).map((tool) => tool.function.name),
    ).toEqual(nonShellBuiltinToolNames);
    expect(
      openAICompatibleTools(true).map((tool) => tool.function.name),
    ).toEqual(allBuiltinToolNames);
  });

  test(`Given provider tools are requested,
    When OpenAI-compatible definitions are built,
    Then descriptions and parameter schemas match the builtin registry metadata`, () => {
    const expectedProviderTools = builtinTools.map(
      providerDefinitionFromBuiltinTool,
    );

    expect(openAICompatibleTools(true)).toEqual(expectedProviderTools);
  });

  test(`Given provider tool names arrive as strings,
    When the registry validates them,
    Then every builtin tool name is accepted and unknown names are rejected`, () => {
    for (const tool of builtinTools) {
      expect(isToolName(tool.name), `${tool.name} should be a tool name`).toBe(
        true,
      );
    }

    expect(isToolName("unknown")).toBe(false);
  });

  test(`Given bash is disabled,
    When provider tools are requested,
    Then only file tools are exposed in stable order`, () => {
    const tools = openAICompatibleTools(false);

    expect(tools.map((tool) => tool.function.name)).toEqual([
      "read",
      "ls",
      "glob",
      "grep",
      "edit",
      "write",
      "apply_patch",
    ]);
  });

  test(`Given bash is enabled,
    When provider tools are requested,
    Then the bash tool is exposed after the file tools`, () => {
    const tools = openAICompatibleTools(true);

    expect(tools.map((tool) => tool.function.name)).toEqual([
      "read",
      "ls",
      "glob",
      "grep",
      "edit",
      "write",
      "apply_patch",
      "bash",
    ]);
  });

  test(`Given a provider returns valid tool arguments,
    When the registry parses and serializes the call,
    Then the same protocol fields are preserved`, () => {
    const parsed = toolCallFromParsedArguments("call_1", "read", {
      path: "src/index.ts",
      offset: 2,
      limit: 3,
    });

    expect(parsed).toEqual({
      id: "call_1",
      tool: "read",
      path: "src/index.ts",
      offset: 2,
      limit: 3,
    });
    expect(parsed === null ? null : toolCallArguments(parsed)).toEqual({
      path: "src/index.ts",
      offset: 2,
      limit: 3,
    });
  });

  test(`Given a provider returns an edit call with replaceAll enabled,
    When the registry parses and serializes the call,
    Then the replaceAll flag is preserved for tool execution`, () => {
    const parsed = toolCallFromParsedArguments("call_edit", "edit", {
      path: "src/index.ts",
      oldString: "old",
      newString: "new",
      replaceAll: true,
    });

    expect(parsed).toEqual({
      id: "call_edit",
      tool: "edit",
      path: "src/index.ts",
      oldString: "old",
      newString: "new",
      replaceAll: true,
    });
    expect(parsed === null ? null : toolCallArguments(parsed)).toEqual({
      path: "src/index.ts",
      oldString: "old",
      newString: "new",
      replaceAll: true,
    });
  });

  test(`Given a provider returns an ls call,
    When the registry parses and serializes the call,
    Then the path and optional limit are preserved for tool execution`, () => {
    const parsed = toolCallFromParsedArguments("call_ls", "ls", {
      path: "src/tools",
      limit: 25,
    });

    expect(parsed).toEqual({
      id: "call_ls",
      tool: "ls",
      path: "src/tools",
      limit: 25,
    });
    expect(parsed === null ? null : toolCallArguments(parsed)).toEqual({
      path: "src/tools",
      limit: 25,
    });
  });

  test(`Given a provider returns an ls call without optional fields,
    When the registry parses and serializes the call,
    Then no default arguments are serialized`, () => {
    const parsed = toolCallFromParsedArguments("call_ls", "ls", {});

    expect(parsed).toEqual({
      id: "call_ls",
      tool: "ls",
    });
    expect(parsed === null ? null : toolCallArguments(parsed)).toEqual({});
  });

  test(`Given a provider returns optional arguments as omitted undefined or null,
    When the registry parses and canonicalizes the calls,
    Then semantic equivalents share the same canonical argument shape`, () => {
    const omitted = toolCallFromParsedArguments("call_read", "read", {
      path: "src/index.ts",
    });
    const explicitUndefined = toolCallFromParsedArguments("call_read", "read", {
      path: "src/index.ts",
      offset: undefined,
      limit: undefined,
    });
    const explicitNull = toolCallFromParsedArguments("call_read", "read", {
      path: "src/index.ts",
      offset: null,
      limit: null,
    });

    expect(omitted === null ? null : toolCallArguments(omitted)).toEqual({
      path: "src/index.ts",
    });
    expect(
      explicitUndefined === null ? null : toolCallArguments(explicitUndefined),
    ).toEqual({ path: "src/index.ts" });
    expect(
      explicitNull === null ? null : toolCallArguments(explicitNull),
    ).toEqual({ path: "src/index.ts" });
    expect(
      omitted === null ? null : toolCallCanonicalArguments(omitted),
    ).toEqual({
      path: "src/index.ts",
      offset: null,
      limit: null,
    });
    expect(
      explicitUndefined === null
        ? null
        : toolCallCanonicalArguments(explicitUndefined),
    ).toEqual(omitted === null ? null : toolCallCanonicalArguments(omitted));
    expect(
      explicitNull === null ? null : toolCallCanonicalArguments(explicitNull),
    ).toEqual(omitted === null ? null : toolCallCanonicalArguments(omitted));
  });

  test(`Given a provider returns invalid tool arguments,
    When the registry parses the call,
    Then it rejects the arguments without constructing a tool call`, () => {
    expect(
      toolCallFromParsedArguments("call_1", "grep", { path: "src" }),
    ).toBeNull();
  });

  test(`Given a provider returns a non-object tool argument payload,
    When the registry parses the call,
    Then it rejects the payload without constructing a tool call`, () => {
    expect(toolCallFromParsedArguments("call_1", "read", null)).toBeNull();
  });

  test(`Given a provider returns an unknown argument field,
    When the registry parses the call,
    Then strict argument validation rejects the extra field`, () => {
    expect(
      toolCallFromParsedArguments("call_1", "read", {
        path: "src/index.ts",
        unexpected: null,
      }),
    ).toBeNull();
  });

  test(`Given a provider returns invalid ls arguments,
    When the registry parses the call,
    Then it rejects the ls call without constructing a tool call`, () => {
    expect(
      toolCallFromParsedArguments("call_ls", "ls", { limit: 0 }),
    ).toBeNull();
  });

  test(`Given a provider returns invalid glob arguments,
    When the registry parses the call,
    Then it rejects the glob call without constructing a tool call`, () => {
    expect(
      toolCallFromParsedArguments("call_glob", "glob", { path: "tests" }),
    ).toBeNull();
  });

  test(`Given a provider returns a glob call without a search path,
    When the registry parses and serializes the call,
    Then only the required pattern field is preserved`, () => {
    const parsed = toolCallFromParsedArguments("call_glob", "glob", {
      pattern: "**/*.test.ts",
    });

    expect(parsed).toEqual({
      id: "call_glob",
      tool: "glob",
      pattern: "**/*.test.ts",
    });
    expect(parsed === null ? null : toolCallArguments(parsed)).toEqual({
      pattern: "**/*.test.ts",
    });
  });

  test(`Given a provider returns a glob call,
    When the registry parses and serializes the call,
    Then the pattern and optional search path are preserved for tool execution`, () => {
    const parsed = toolCallFromParsedArguments("call_glob", "glob", {
      pattern: "**/*.test.ts",
      path: "tests",
    });

    expect(parsed).toEqual({
      id: "call_glob",
      tool: "glob",
      pattern: "**/*.test.ts",
      path: "tests",
    });
    expect(parsed === null ? null : toolCallArguments(parsed)).toEqual({
      pattern: "**/*.test.ts",
      path: "tests",
    });
  });
});
