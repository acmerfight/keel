import { describe, expect, test } from "vitest";
import {
  openAICompatibleTools,
  toolCallArguments,
  toolCallFromParsedArguments,
} from "../../src/tools/registry.ts";

describe("tool registry", () => {
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
