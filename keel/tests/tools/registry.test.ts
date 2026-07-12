import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { WorkflowSkillError } from "../../src/skills/model.ts";
import { executeToolCall } from "../../src/tools/execution.ts";
import type {
  OpenAICompatibleToolDefinition,
  OpenAICompatibleToolParameter,
} from "../../src/tools/registry.ts";
import {
  isToolName,
  normalizeProviderToolCall,
  openAICompatibleTools,
  type ToolName,
  toolCallArguments,
  toolCallCanonicalArguments,
  toolCallFromParsedArguments,
} from "../../src/tools/registry.ts";
import { builtinTools } from "../../src/tools/tool-definitions.ts";

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

function isJsonSchema(value: unknown): value is z.core.JSONSchema.JSONSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaField(
  value: unknown,
  context: string,
): z.core.JSONSchema.JSONSchema {
  if (!isJsonSchema(value)) {
    throw new Error(`${context} schema field is missing`);
  }
  return value;
}

function providerToolByName(
  tools: readonly OpenAICompatibleToolDefinition[],
  name: ToolName,
): OpenAICompatibleToolDefinition {
  const tool = tools.find((candidate) => candidate.function.name === name);
  if (tool === undefined) {
    throw new Error(`Expected provider tool ${name} to be exposed`);
  }
  return tool;
}

function validProviderValue(
  field: OpenAICompatibleToolParameter,
): string | number | boolean | readonly unknown[] | Record<string, unknown> {
  switch (field.type) {
    case "string":
      return field.enum?.[0] ?? "value";
    case "integer":
      return field.minimum ?? 1;
    case "boolean":
      return true;
    case "array":
      if (field.items === undefined) {
        throw new Error("array provider field is missing items");
      }
      return [validProviderValue(field.items)];
    case "object": {
      if (field.properties === undefined) {
        throw new Error("object provider field is missing properties");
      }
      const required = new Set(field.required ?? []);
      const value: Record<string, unknown> = {};
      for (const [name, property] of Object.entries(field.properties)) {
        if (required.has(name)) {
          value[name] = validProviderValue(property);
        }
      }
      return value;
    }
  }
}

function expectProviderParameterMatchesSchema(
  providerField: OpenAICompatibleToolParameter,
  jsonSchemaField: z.core.JSONSchema.JSONSchema,
  context: string,
): void {
  expect(providerField.type, `${context} type drift`).toBe(
    jsonSchemaField.type,
  );
  expect(providerField.description, `${context} description drift`).toBe(
    jsonSchemaField.description,
  );

  switch (providerField.type) {
    case "string":
      expect(providerField.enum, `${context} enum drift`).toEqual(
        jsonSchemaField.enum,
      );
      return;
    case "boolean":
      return;
    case "integer":
      expect(providerField.minimum, `${context} minimum drift`).toBe(
        inclusiveIntegerMinimum(jsonSchemaField),
      );
      expect(providerField.maximum, `${context} maximum drift`).toBe(
        inclusiveIntegerMaximum(jsonSchemaField),
      );
      return;
    case "array":
      if (providerField.items === undefined) {
        throw new Error(`${context} provider array item schema is missing`);
      }
      expectProviderParameterMatchesSchema(
        providerField.items,
        schemaField(jsonSchemaField.items, `${context}.items`),
        `${context}.items`,
      );
      return;
    case "object": {
      if (providerField.properties === undefined) {
        throw new Error(`${context} provider object properties are missing`);
      }
      const jsonSchemaProperties = jsonSchemaField.properties ?? {};
      expect(
        Object.keys(providerField.properties).sort(),
        `${context} property key drift`,
      ).toEqual(Object.keys(jsonSchemaProperties).sort());
      expect(
        [...(providerField.required ?? [])].sort(),
        `${context} required field drift`,
      ).toEqual([...(jsonSchemaField.required ?? [])].sort());
      expect(
        providerField.additionalProperties,
        `${context} strictness drift`,
      ).toBe(jsonSchemaField.additionalProperties);
      for (const [name, property] of Object.entries(providerField.properties)) {
        expectProviderParameterMatchesSchema(
          property,
          schemaField(jsonSchemaProperties[name], `${context}.${name}`),
          `${context}.${name}`,
        );
      }
      return;
    }
  }
}

describe("tool registry", () => {
  test(`Given no project skill catalog is available,
    When builtin execution receives a skill call,
    Then it fails recoverably without loading instructions`, async () => {
    const call = toolCallFromParsedArguments("call_skill", "skill", {
      name: "review",
    });
    if (call === null) {
      throw new Error("Expected skill call to parse");
    }

    await expect(
      executeToolCall({
        workspace: ".",
        signal: new AbortController().signal,
        allowBash: false,
        toolCall: call,
      }),
    ).resolves.toMatchObject({
      ok: false,
      content: expect.stringContaining("skill activation is unavailable"),
    });
  });

  test(`Given a skill activation capability fails unexpectedly,
    When builtin execution invokes it,
    Then the unexpected fault remains distinct from a catalog miss`, async () => {
    const call = toolCallFromParsedArguments("call_skill", "skill", {
      name: "review",
    });
    if (call === null) {
      throw new Error("Expected skill call to parse");
    }

    await expect(
      executeToolCall({
        workspace: ".",
        signal: new AbortController().signal,
        allowBash: false,
        toolCall: call,
        skillActivation: {
          expose: () => {},
          registerExplicit: () => {},
          search: () => [],
          readResource: () => "",
          activate: () => {
            throw new Error("unexpected activation fault");
          },
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      content: expect.stringContaining("unexpected activation fault"),
    });
  });

  test(`Given search and resource tools run with unavailable, empty, successful, and failing capabilities,
    When builtin execution dispatches each call,
    Then every Skill tool result remains recoverable and structured`, async () => {
    const searchCall = toolCallFromParsedArguments(
      "search_skills",
      "skill_search",
      { query: "review" },
    );
    const resourceCall = toolCallFromParsedArguments(
      "read_skill_resource",
      "skill_resource",
      { skill: "repo:review", path: "references/checklist.md" },
    );
    if (searchCall === null || resourceCall === null) {
      throw new Error("Expected Skill support calls to parse");
    }
    const base = {
      workspace: ".",
      signal: new AbortController().signal,
      allowBash: false,
    } as const;
    const capability = {
      expose: () => {},
      registerExplicit: () => {},
      search: () => [],
      readResource: () => "RESOURCE-OK",
      activate: () => {
        throw new Error("not used");
      },
    };

    await expect(
      executeToolCall({ ...base, toolCall: searchCall }),
    ).resolves.toMatchObject({
      ok: false,
      content: expect.stringContaining("catalog search is unavailable"),
    });
    await expect(
      executeToolCall({
        ...base,
        toolCall: searchCall,
        skillActivation: capability,
      }),
    ).resolves.toEqual({
      ok: true,
      content: "No matching implicit workflow skills found.",
    });
    await expect(
      executeToolCall({
        ...base,
        toolCall: searchCall,
        skillActivation: {
          ...capability,
          search: () => [
            {
              id: "repo:root:review:digest",
              packageId: "repo:root:review",
              rootKey: "root",
              rootPriority: 0,
              qualifiedName: "repo:review",
              scope: "repo",
              activationPolicy: "implicit",
              name: "review",
              description: "Review changes.",
              relativePath: ".agents/skills/review/SKILL.md",
              digest: "digest",
            },
          ],
        },
      }),
    ).resolves.toEqual({
      ok: true,
      content: "repo:review: Review changes. (.agents/skills/review/SKILL.md)",
    });
    await expect(
      executeToolCall({ ...base, toolCall: resourceCall }),
    ).resolves.toMatchObject({
      ok: false,
      content: expect.stringContaining("resource access is unavailable"),
    });
    await expect(
      executeToolCall({
        ...base,
        toolCall: resourceCall,
        skillActivation: capability,
      }),
    ).resolves.toEqual({ ok: true, content: "RESOURCE-OK" });
    await expect(
      executeToolCall({
        ...base,
        toolCall: resourceCall,
        skillActivation: {
          ...capability,
          readResource: () => {
            throw new WorkflowSkillError("Error: resource denied");
          },
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      content: expect.stringContaining("resource denied"),
    });
    await expect(
      executeToolCall({
        ...base,
        toolCall: resourceCall,
        skillActivation: {
          ...capability,
          readResource: () => {
            throw new Error("resource crashed");
          },
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      content: expect.stringContaining("resource crashed"),
    });
  });

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
      const result = await executeToolCall({
        workspace,
        signal: new AbortController().signal,
        allowBash: false,
        toolCall: call,
      });

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
    const gitStatusTool = builtinToolByName("git_status");
    const gitDiffTool = builtinToolByName("git_diff");
    const editTool = builtinToolByName("edit");
    const writeTool = builtinToolByName("write");
    const applyPatchTool = builtinToolByName("apply_patch");
    const bashTool = builtinToolByName("bash");
    const updateGoalTool = builtinToolByName("update_goal");

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
    expect(gitStatusTool.display.formatLabel({})).toBe("git_status");
    expect(gitStatusTool.display.formatLabel({ paths: ["src"] })).toBe(
      "git_status src",
    );
    expect(gitDiffTool.display.formatLabel({})).toBe("git_diff");
    expect(gitDiffTool.display.formatLabel({ paths: ["src"] })).toBe(
      "git_diff src",
    );
    expect(
      gitDiffTool.display.formatLabel({
        baseRef: "origin/main",
        headRef: "HEAD",
        mergeBase: true,
      }),
    ).toBe("git_diff origin/main...HEAD");
    expect(gitDiffTool.display.formatLabel({ baseRef: "HEAD~1" })).toBe(
      "git_diff HEAD~1..HEAD",
    );
    expect(
      gitDiffTool.display.formatLabel({
        baseRef: "HEAD~1",
        paths: ["src/app.ts"],
      }),
    ).toBe("git_diff HEAD~1..HEAD src/app.ts");
    expect(
      editTool.display.formatLabel({
        path: "a.ts",
        edits: [{ oldText: "old", newText: "new" }],
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
    expect(updateGoalTool.display.formatLabel({ status: "completed" })).toBe(
      "update_goal",
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
      "update_plan",
      "update_goal",
      "skill_resource",
      "skill_search",
      "skill",
      "read",
      "ls",
      "glob",
      "grep",
      "git_status",
      "git_diff",
      "edit",
      "write",
      "apply_patch",
      "bash",
    ]);
    expect(new Set(names).size).toBe(names.length);
  });

  test(`Given builtin tools declare their behavior contracts,
    When the registry metadata is inspected,
    Then each tool makes permission output and risk explicit`, () => {
    const contracts = builtinTools.map((tool) => ({
      name: tool.name,
      permission: tool.permission.kind,
      output: tool.output.kind,
      risk: tool.risk,
      hasFormatLabel: typeof tool.display.formatLabel === "function",
    }));

    expect(contracts).toEqual([
      {
        name: "update_plan",
        permission: "none",
        output: "text",
        risk: { kind: "agent-state" },
        hasFormatLabel: true,
      },
      {
        name: "update_goal",
        permission: "none",
        output: "text",
        risk: { kind: "agent-state" },
        hasFormatLabel: true,
      },
      {
        name: "skill_resource",
        permission: "none",
        output: "text",
        risk: { kind: "workspace-read" },
        hasFormatLabel: true,
      },
      {
        name: "skill_search",
        permission: "none",
        output: "text",
        risk: { kind: "workspace-read" },
        hasFormatLabel: true,
      },
      {
        name: "skill",
        permission: "none",
        output: "text",
        risk: { kind: "workspace-read" },
        hasFormatLabel: true,
      },
      {
        name: "read",
        permission: "none",
        output: "text",
        risk: { kind: "workspace-read" },
        hasFormatLabel: true,
      },
      {
        name: "ls",
        permission: "none",
        output: "text",
        risk: { kind: "workspace-read" },
        hasFormatLabel: true,
      },
      {
        name: "glob",
        permission: "none",
        output: "text",
        risk: { kind: "workspace-read" },
        hasFormatLabel: true,
      },
      {
        name: "grep",
        permission: "none",
        output: "text",
        risk: { kind: "workspace-read" },
        hasFormatLabel: true,
      },
      {
        name: "git_status",
        permission: "none",
        output: "text",
        risk: { kind: "workspace-read" },
        hasFormatLabel: true,
      },
      {
        name: "git_diff",
        permission: "none",
        output: "text",
        risk: { kind: "workspace-read" },
        hasFormatLabel: true,
      },
      {
        name: "edit",
        permission: "none",
        output: "text",
        risk: { kind: "workspace-write", destructive: false },
        hasFormatLabel: true,
      },
      {
        name: "write",
        permission: "none",
        output: "text",
        risk: { kind: "workspace-write", destructive: true },
        hasFormatLabel: true,
      },
      {
        name: "apply_patch",
        permission: "none",
        output: "text",
        risk: { kind: "workspace-write", destructive: true },
        hasFormatLabel: true,
      },
      {
        name: "bash",
        permission: "approval",
        output: "text",
        risk: { kind: "trusted-shell" },
        hasFormatLabel: true,
      },
    ]);
  });

  test(`Given a provider tool call is missing required arguments,
    When the tool-call contract normalizes the call,
    Then it rejects the malformed call before execution`, () => {
    expect(() =>
      normalizeProviderToolCall({ id: "call_read", tool: "read" }),
    ).toThrow("Invalid provider tool call for read");
  });

  test(`Given a provider tool call has an invalid argument type,
    When the tool-call contract normalizes the call,
    Then it rejects the malformed call before execution`, () => {
    const malformedCall = {
      id: "call_read",
      tool: "read",
      path: "note.txt",
      offset: "1",
    } as const;

    expect(() => normalizeProviderToolCall(malformedCall)).toThrow(
      "Invalid provider tool call for read",
    );
  });

  test(`Given a provider tool call has a fractional integer argument,
    When the tool-call contract normalizes the call,
    Then it rejects the malformed call before execution`, () => {
    const malformedCall = {
      id: "call_bash",
      tool: "bash",
      command: "printf ok",
      timeoutMs: 1.5,
    } as const;

    expect(() => normalizeProviderToolCall(malformedCall)).toThrow(
      "Invalid provider tool call for bash",
    );
  });

  test(`Given builtin tool execution receives a matching call with an explicit undefined optional argument,
    When the tool-call contract normalizes the call before execution,
    Then it treats the optional argument as absent`, async () => {
    const providerCall = {
      id: "call_bash",
      tool: "bash",
      command: "printf ok",
      timeoutMs: undefined,
    } as const;
    const callWithAbsentOptional = normalizeProviderToolCall(providerCall);

    await expect(
      executeToolCall({
        workspace: ".",
        signal: new AbortController().signal,
        allowBash: false,
        toolCall: callWithAbsentOptional,
      }),
    ).resolves.toEqual({
      ok: false,
      content:
        "Tool failed: bash failed: shell commands are disabled. Re-run with --bash-policy ask, --bash-policy trusted, or --allow-bash to enable them.",
    });
  });

  test(`Given builtin tool execution receives a matching call with an explicit null optional argument,
    When the tool-call contract normalizes the call before execution,
    Then it treats the optional argument as absent`, async () => {
    const providerCall = {
      id: "call_bash",
      tool: "bash",
      command: "printf ok",
      timeoutMs: null,
    } as const;
    const callWithNullOptional = normalizeProviderToolCall(providerCall);

    await expect(
      executeToolCall({
        workspace: ".",
        signal: new AbortController().signal,
        allowBash: false,
        toolCall: callWithNullOptional,
      }),
    ).resolves.toEqual({
      ok: false,
      content:
        "Tool failed: bash failed: shell commands are disabled. Re-run with --bash-policy ask, --bash-policy trusted, or --allow-bash to enable them.",
    });
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

  test(`Given registry-derived builtin call helpers receive a different tool call,
    When they validate the call before deriving arguments,
    Then they reject the mismatched tool name`, () => {
    const readTool = builtinToolByName("read");
    expect(readTool.name).toBe("read");

    expect(() =>
      readTool.argumentsFromCall({
        id: "call_ls",
        tool: "ls",
      }),
    ).toThrow("Invalid builtin tool call for read");
  });

  test(`Given provider edit calls receive malformed nested arguments,
    When the tool-call contract validates the call,
    Then it rejects the malformed edit call before execution`, () => {
    const malformedCalls = [
      {
        id: "call_edit",
        tool: "edit",
        path: "note.txt",
        edits: "not an array",
      },
      {
        id: "call_edit",
        tool: "edit",
        path: "note.txt",
        edits: [{ newText: "new" }],
      },
      {
        id: "call_edit",
        tool: "edit",
        path: "note.txt",
        edits: ["not an object"],
      },
      {
        id: "call_edit",
        tool: "edit",
        path: "note.txt",
        edits: [{ oldText: "old", newText: "new", replaceAll: "yes" }],
      },
      {
        id: "call_edit",
        tool: "edit",
        path: "note.txt",
        edits: [{ oldText: "old", newText: "new", note: "extra" }],
      },
    ] as const;

    for (const malformedCall of malformedCalls) {
      expect(() => normalizeProviderToolCall(malformedCall)).toThrow(
        "Invalid provider tool call for edit",
      );
    }
  });

  test(`Given a provider yields malformed edit arguments,
    When the agent normalizes the provider call before scheduling,
    Then the provider error keeps the invalid field path`, () => {
    const malformedProviderCall = {
      id: "call_edit",
      tool: "edit",
      path: "note.txt",
      edits: "not an array",
    } as const;

    expect(() => normalizeProviderToolCall(malformedProviderCall)).toThrow(
      /Invalid provider tool call for edit: edits: Invalid input/,
    );
  });

  test(`Given builtin tools declare their argument contracts,
    When the registry metadata is inspected,
    Then each tool lists its provider-visible arguments and required fields`, () => {
    const argumentsByTool = Object.fromEntries(
      openAICompatibleTools(true, true).map((tool) => [
        tool.function.name,
        {
          fields: Object.keys(tool.function.parameters.properties),
          required: tool.function.parameters.required,
        },
      ]),
    );

    expect(argumentsByTool).toEqual({
      update_plan: { fields: ["plan"], required: ["plan"] },
      update_goal: { fields: ["status", "reason"], required: ["status"] },
      skill_resource: {
        fields: ["skill", "path"],
        required: ["skill", "path"],
      },
      skill_search: { fields: ["query"], required: ["query"] },
      skill: { fields: ["name"], required: ["name"] },
      read: { fields: ["path", "offset", "limit"], required: ["path"] },
      ls: { fields: ["path", "limit"], required: [] },
      glob: { fields: ["pattern", "path"], required: ["pattern"] },
      grep: { fields: ["pattern", "path"], required: ["pattern"] },
      git_status: {
        fields: ["paths"],
        required: [],
      },
      git_diff: {
        fields: ["mode", "baseRef", "headRef", "mergeBase", "paths"],
        required: [],
      },
      edit: {
        fields: ["path", "edits"],
        required: ["path", "edits"],
      },
      write: { fields: ["path", "content"], required: ["path", "content"] },
      apply_patch: { fields: ["patch"], required: ["patch"] },
      bash: { fields: ["command", "timeoutMs"], required: ["command"] },
    });
  });

  test(`Given builtin tools declare arguments in Zod,
    When provider metadata is compared with generated JSON schema,
    Then keys requiredness types and numeric bounds stay equivalent`, () => {
    const providerTools = openAICompatibleTools(true, true);

    for (const tool of builtinTools) {
      const providerTool = providerToolByName(providerTools, tool.name);
      const providerParameters = providerTool.function.parameters;
      const jsonSchema = z.toJSONSchema(tool.args.schema);
      const schemaFields = jsonSchema.properties ?? {};
      const providerFields = providerParameters.properties;
      const fieldKeys = Object.keys(providerFields).sort();
      const requiredFields = [...providerParameters.required].sort();
      const completeArgsFromMetadata = Object.fromEntries(
        Object.entries(providerFields).map(([name, field]) => [
          name,
          validProviderValue(field),
        ]),
      );
      const completeArgs =
        tool.name === "update_goal"
          ? { ...completeArgsFromMetadata, status: "blocked" }
          : completeArgsFromMetadata;

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

      for (const [fieldName, field] of Object.entries(providerFields)) {
        expectProviderParameterMatchesSchema(
          field,
          schemaField(schemaFields[fieldName], `${tool.name}.${fieldName}`),
          `${tool.name}.${fieldName}`,
        );
      }
    }
  });

  test(`Given provider exposure is derived from the builtin registry,
    When builtin metadata is compared with provider tools,
    Then bash filtering matches the explicit trusted shell risk`, () => {
    const allBuiltinToolNames = builtinTools.map((tool) => tool.name);
    const defaultBuiltinToolNames = builtinTools
      .filter(
        (tool) =>
          tool.risk.kind !== "trusted-shell" &&
          tool.availability !== "skill-catalog",
      )
      .map((tool) => tool.name);
    const nonShellBuiltinToolNames = builtinTools
      .filter((tool) => tool.risk.kind !== "trusted-shell")
      .map((tool) => tool.name);

    expect(
      openAICompatibleTools(false).map((tool) => tool.function.name),
    ).toEqual(defaultBuiltinToolNames);
    expect(
      openAICompatibleTools(false, true).map((tool) => tool.function.name),
    ).toEqual(nonShellBuiltinToolNames);
    expect(
      openAICompatibleTools(true, true).map((tool) => tool.function.name),
    ).toEqual(allBuiltinToolNames);
  });

  test(`Given provider tools are requested,
    When OpenAI-compatible definitions are built,
    Then descriptions match the builtin registry and parameters are strict objects`, () => {
    const providerTools = openAICompatibleTools(true, true);

    expect(
      providerTools.map((tool) => ({
        name: tool.function.name,
        description: tool.function.description,
      })),
    ).toEqual(
      builtinTools.map((tool) => ({
        name: tool.name,
        description: tool.description,
      })),
    );
    expect(
      providerTools.map((tool) => ({
        name: tool.function.name,
        parameters: {
          type: tool.function.parameters.type,
          additionalProperties: tool.function.parameters.additionalProperties,
        },
      })),
    ).toEqual(
      builtinTools.map((tool) => ({
        name: tool.name,
        parameters: { type: "object", additionalProperties: false },
      })),
    );
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
      "update_plan",
      "update_goal",
      "read",
      "ls",
      "glob",
      "grep",
      "git_status",
      "git_diff",
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
      "update_plan",
      "update_goal",
      "read",
      "ls",
      "glob",
      "grep",
      "git_status",
      "git_diff",
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
    Then the replaceAll flag is preserved inside the edit entry`, () => {
    const parsed = toolCallFromParsedArguments("call_edit", "edit", {
      path: "src/index.ts",
      edits: [{ oldText: "old", newText: "new", replaceAll: true }],
    });

    expect(parsed).toStrictEqual({
      id: "call_edit",
      tool: "edit",
      path: "src/index.ts",
      edits: [{ oldText: "old", newText: "new", replaceAll: true }],
    });
    expect(parsed === null ? null : toolCallArguments(parsed)).toEqual({
      path: "src/index.ts",
      edits: [{ oldText: "old", newText: "new", replaceAll: true }],
    });
  });

  test(`Given a provider returns nested optional edit fields as null,
    When the registry parses the call,
    Then the null optional field is omitted from the edit entry`, () => {
    const parsed = toolCallFromParsedArguments("call_edit", "edit", {
      path: "src/index.ts",
      edits: [{ oldText: "old", newText: "new", replaceAll: null }],
    });

    expect(parsed).toStrictEqual({
      id: "call_edit",
      tool: "edit",
      path: "src/index.ts",
      edits: [{ oldText: "old", newText: "new" }],
    });
  });

  test(`Given a provider returns removed legacy edit arguments,
    When the registry parses the call,
    Then the strict edit schema rejects it instead of converting it`, () => {
    const parsed = toolCallFromParsedArguments("call_edit", "edit", {
      path: "src/index.ts",
      oldString: "old",
      newString: "new",
    });

    expect(parsed).toBeNull();
  });

  test(`Given a provider returns top-level replaceAll with an edit call,
    When the registry parses the call,
    Then the strict edit schema rejects it instead of guessing intent`, () => {
    const parsed = toolCallFromParsedArguments("call_edit", "edit", {
      path: "src/index.ts",
      edits: [{ oldText: "old", newText: "new" }],
      replaceAll: true,
    });

    expect(parsed).toBeNull();
  });

  test(`Given an edit entry includes an unknown nested field,
    When the registry parses the call,
    Then the strict nested edit schema rejects the call`, () => {
    const parsed = toolCallFromParsedArguments("call_edit", "edit", {
      path: "src/index.ts",
      edits: [{ oldText: "old", newText: "new", note: "extra" }],
    });

    expect(parsed).toBeNull();
  });

  test(`Given provider tools are requested,
    When the edit schema is rendered for the model,
    Then edit exposes one edits array of replacement objects`, () => {
    const editTool = openAICompatibleTools(true).find(
      (tool) => tool.function.name === "edit",
    );
    const { edits } = editTool?.function.parameters.properties ?? {};

    expect(edits).toEqual({
      type: "array",
      description:
        "One or more targeted replacements. Each oldText is matched against the original file content. Non-replaceAll edits must be unique and all matched regions must be non-overlapping.",
      items: {
        type: "object",
        description: "One targeted replacement inside the file.",
        properties: {
          oldText: {
            type: "string",
            description:
              "Text to replace. Copy it from read output; by default it must identify one target.",
          },
          newText: {
            type: "string",
            description: "Replacement text.",
          },
          replaceAll: {
            type: "boolean",
            description:
              "When true, replace every exact occurrence of oldText for this edit. Defaults to false, which requires oldText to identify one target.",
          },
        },
        required: ["oldText", "newText"],
        additionalProperties: false,
      },
    });
  });

  test(`Given provider tools are requested,
    When the edit description is rendered for the model,
    Then edit explains how to use recovery diagnostics`, () => {
    const editTool = openAICompatibleTools(true).find(
      (tool) => tool.function.name === "edit",
    );
    const description = editTool?.function.description ?? "";

    expect(description).toContain("Recovery current-file context");
    expect(description).toContain("target is outside the excerpt");
    expect(description).toContain("reported matching locations");
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

    expect(explicitNull).toStrictEqual({
      id: "call_read",
      tool: "read",
      path: "src/index.ts",
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
