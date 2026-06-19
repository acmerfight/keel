import { describe, expect, test } from "vitest";
import { builtinTools } from "../../src/tools/builtin.ts";
import {
  openAICompatibleTools,
  toolCallArguments,
  toolCallFromParsedArguments,
} from "../../src/tools/registry.ts";

describe("tool registry", () => {
  test(`Given builtin tools declare display contracts,
    When labels and approval prompts are rendered,
    Then each tool has explicit user-visible text without generic fallback`, () => {
    const [
      readTool,
      lsTool,
      globTool,
      grepTool,
      editTool,
      writeTool,
      bashTool,
    ] = builtinTools;

    expect(readTool.display.formatLabel({ path: "src/index.ts" })).toBe(
      "read src/index.ts",
    );
    expect(lsTool.display.formatLabel({})).toBe("ls .");
    expect(lsTool.display.formatLabel({ path: "src" })).toBe("ls src");
    expect(
      globTool.display.formatLabel({ pattern: "**/*.ts", path: "src" }),
    ).toBe("glob **/*.ts src");
    expect(grepTool.display.formatLabel({ pattern: "needle" })).toBe(
      "grep needle",
    );
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
      execute: tool.execute,
    }));

    expect(contracts).toEqual([
      {
        name: "read",
        permission: "none",
        output: "text",
        risk: { kind: "workspace-read" },
        concurrency: { kind: "parallel-safe" },
        hasFormatLabel: true,
        execute: { kind: "legacy-switch", owner: "executeToolCall" },
      },
      {
        name: "ls",
        permission: "none",
        output: "text",
        risk: { kind: "workspace-read" },
        concurrency: { kind: "parallel-safe" },
        hasFormatLabel: true,
        execute: { kind: "legacy-switch", owner: "executeToolCall" },
      },
      {
        name: "glob",
        permission: "none",
        output: "text",
        risk: { kind: "workspace-read" },
        concurrency: { kind: "parallel-safe" },
        hasFormatLabel: true,
        execute: { kind: "legacy-switch", owner: "executeToolCall" },
      },
      {
        name: "grep",
        permission: "none",
        output: "text",
        risk: { kind: "workspace-read" },
        concurrency: { kind: "parallel-safe" },
        hasFormatLabel: true,
        execute: { kind: "legacy-switch", owner: "executeToolCall" },
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
        execute: { kind: "legacy-switch", owner: "executeToolCall" },
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
        execute: { kind: "legacy-switch", owner: "executeToolCall" },
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
        execute: { kind: "legacy-switch", owner: "executeToolCall" },
      },
    ]);
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
      bash: { fields: ["command", "timeoutMs"], required: ["command"] },
    });
  });

  test(`Given provider exposure still uses the legacy list,
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

  test(`Given a provider returns invalid tool arguments,
    When the registry parses the call,
    Then it rejects the arguments without constructing a tool call`, () => {
    expect(
      toolCallFromParsedArguments("call_1", "grep", { path: "src" }),
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
