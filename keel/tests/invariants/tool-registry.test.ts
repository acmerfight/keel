import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, test } from "vitest";

interface ParsedSource {
  readonly path: string;
  readonly sourceFile: ts.SourceFile;
}

const registryPath = "src/tools/registry.ts";
const executionPath = "src/tools/execution.ts";
const cliOutputPath = "src/cli/output.ts";
const contextCompactionPath = "src/agent/context-compaction.ts";
const fakeProviderPath = "src/llm/providers/fake.ts";
const registrySource = parseSource(registryPath);
const executionSource = parseSource(executionPath);
const cliOutputSource = parseSource(cliOutputPath);
const contextCompactionSource = parseSource(contextCompactionPath);
const fakeProviderSource = parseSource(fakeProviderPath);
const builtinToolConstantNames = new Set([
  "readTool",
  "lsTool",
  "globTool",
  "grepTool",
  "editTool",
  "writeTool",
  "bashTool",
]);
const builtinToolNames = new Set([
  "read",
  "ls",
  "glob",
  "grep",
  "edit",
  "write",
  "bash",
]);
const perToolArgumentSchemaNames = new Set([
  "readToolArgumentsSchema",
  "lsToolArgumentsSchema",
  "globToolArgumentsSchema",
  "grepToolArgumentsSchema",
  "editToolArgumentsSchema",
  "writeToolArgumentsSchema",
  "bashToolArgumentsSchema",
]);
const perToolExecutorNames = new Set([
  "executeRead",
  "executeLs",
  "executeGlob",
  "executeGrep",
  "executeEdit",
  "executeWrite",
  "executeBash",
]);

function parseSource(path: string): ParsedSource {
  const text = readFileSync(path, "utf8");
  return {
    path,
    sourceFile: ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true),
  };
}

function location(source: ParsedSource, node: ts.Node): string {
  const position = source.sourceFile.getLineAndCharacterOfPosition(
    node.getStart(source.sourceFile),
  );
  return `${source.path}:${position.line + 1}:${position.character + 1}`;
}

function stringLiteralText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return null;
}

function isNameExpression(node: ts.Node): boolean {
  if (ts.isIdentifier(node)) {
    return node.text === "name";
  }
  return ts.isPropertyAccessExpression(node) && node.name.text === "name";
}

function isEqualityOperator(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
    kind === ts.SyntaxKind.EqualsEqualsToken ||
    kind === ts.SyntaxKind.ExclamationEqualsToken
  );
}

function toolNameComparison(
  source: ParsedSource,
  node: ts.BinaryExpression,
): string | null {
  if (!isEqualityOperator(node.operatorToken.kind)) {
    return null;
  }

  const leftLiteral = stringLiteralText(node.left);
  if (
    leftLiteral !== null &&
    builtinToolNames.has(leftLiteral) &&
    isNameExpression(node.right)
  ) {
    return `${location(source, node)} ${node.getText(source.sourceFile)}`;
  }

  const rightLiteral = stringLiteralText(node.right);
  if (
    rightLiteral !== null &&
    builtinToolNames.has(rightLiteral) &&
    isNameExpression(node.left)
  ) {
    return `${location(source, node)} ${node.getText(source.sourceFile)}`;
  }

  return null;
}

function perToolProviderConstants(source: ParsedSource): readonly string[] {
  const violations: string[] = [];

  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      builtinToolConstantNames.has(node.name.text)
    ) {
      violations.push(`${location(source, node)} ${node.name.text}`);
    }
    ts.forEachChild(node, visit);
  }

  visit(source.sourceFile);
  return violations;
}

function toolNameStringComparisons(source: ParsedSource): readonly string[] {
  const violations: string[] = [];

  function visit(node: ts.Node): void {
    if (ts.isBinaryExpression(node)) {
      const violation = toolNameComparison(source, node);
      if (violation !== null) {
        violations.push(violation);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(source.sourceFile);
  return violations;
}

function functionDeclaration(
  source: ParsedSource,
  name: string,
): ts.FunctionDeclaration | null {
  let declaration: ts.FunctionDeclaration | null = null;

  function visit(node: ts.Node): void {
    if (
      declaration === null &&
      ts.isFunctionDeclaration(node) &&
      node.name?.text === name
    ) {
      declaration = node;
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(source.sourceFile);
  return declaration;
}

function switchStatements(
  source: ParsedSource,
  node: ts.Node,
): readonly string[] {
  const switches: string[] = [];

  function visit(current: ts.Node): void {
    if (ts.isSwitchStatement(current)) {
      switches.push(
        `${location(source, current)} ${current.expression.getText(
          source.sourceFile,
        )}`,
      );
    }
    ts.forEachChild(current, visit);
  }

  visit(node);
  return switches;
}

function builtinToolSwitchCases(
  source: ParsedSource,
  node: ts.Node,
): readonly string[] {
  const cases: string[] = [];

  function visit(current: ts.Node): void {
    if (ts.isCaseClause(current)) {
      const label = stringLiteralText(current.expression);
      if (label !== null && builtinToolNames.has(label)) {
        cases.push(`${location(source, current)} case "${label}"`);
      }
    }
    ts.forEachChild(current, visit);
  }

  visit(node);
  return cases;
}

function importedBindings(
  source: ParsedSource,
  names: ReadonlySet<string>,
): readonly string[] {
  const violations: string[] = [];

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) {
      const namedBindings = node.importClause?.namedBindings;
      if (namedBindings !== undefined && ts.isNamedImports(namedBindings)) {
        for (const element of namedBindings.elements) {
          if (names.has(element.name.text)) {
            violations.push(
              `${location(source, element)} ${element.name.text}`,
            );
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(source.sourceFile);
  return violations;
}

describe("builtin tool registry invariants", () => {
  test(`Given provider exposure is a registry-derived surface,
    When registry syntax is inspected,
    Then it does not keep per-tool provider definition objects`, () => {
    expect(perToolProviderConstants(registrySource)).toEqual([]);
  });

  test(`Given builtin tool names are owned by builtinTools,
    When registry syntax is inspected,
    Then tool name checks do not duplicate the names as string comparisons`, () => {
    expect(toolNameStringComparisons(registrySource)).toEqual([]);
  });

  test(`Given tool call parsing is derived from builtin tool metadata,
    When registry syntax is inspected,
    Then parsing does not import per-tool argument schemas or switch on tool names`, () => {
    const parser = functionDeclaration(
      registrySource,
      "toolCallFromParsedArguments",
    );

    expect(
      importedBindings(registrySource, perToolArgumentSchemaNames),
    ).toEqual([]);
    expect(
      parser === null ? [] : switchStatements(registrySource, parser),
    ).toEqual([]);
  });

  test(`Given tool execution is derived from builtin tool metadata,
    When execution syntax is inspected,
    Then executeToolCall does not import per-tool executors or switch on tool names`, () => {
    const executor = functionDeclaration(executionSource, "executeToolCall");

    expect(importedBindings(executionSource, perToolExecutorNames)).toEqual([]);
    expect(
      executor === null ? [] : switchStatements(executionSource, executor),
    ).toEqual([]);
  });

  test(`Given canonical tool arguments are derived from builtin metadata,
    When registry syntax is inspected,
    Then toolCallArguments does not switch on builtin tool names`, () => {
    const serializer = functionDeclaration(registrySource, "toolCallArguments");

    expect(
      serializer === null
        ? []
        : builtinToolSwitchCases(registrySource, serializer),
    ).toEqual([]);
  });

  test(`Given CLI tool labels are derived from builtin display metadata,
    When CLI output syntax is inspected,
    Then toolCallLabel does not switch on builtin tool names`, () => {
    const registryLabeler = functionDeclaration(
      registrySource,
      "toolCallLabel",
    );
    const printer = functionDeclaration(cliOutputSource, "printAgentEvents");

    expect(
      importedBindings(cliOutputSource, new Set(["toolCallLabel"])),
    ).toHaveLength(1);
    expect(
      registryLabeler === null
        ? ["missing registry toolCallLabel"]
        : builtinToolSwitchCases(registrySource, registryLabeler),
    ).toEqual([]);
    expect(
      printer === null
        ? ["missing printAgentEvents"]
        : builtinToolSwitchCases(cliOutputSource, printer),
    ).toEqual([]);
  });

  test(`Given context accounting fingerprints are derived from canonical tool arguments,
    When compaction syntax is inspected,
    Then fingerprinting does not switch on builtin tool names`, () => {
    const fingerprintParts = functionDeclaration(
      contextCompactionSource,
      "toolCallFingerprintParts",
    );
    const fingerprint = functionDeclaration(
      contextCompactionSource,
      "toolCallFingerprint",
    );
    const capture = functionDeclaration(
      contextCompactionSource,
      "captureToolCallFingerprint",
    );
    const matches = functionDeclaration(
      contextCompactionSource,
      "toolCallMatchesFingerprintCache",
    );

    expect(fingerprintParts).toBeNull();
    expect([
      ...(fingerprint === null
        ? []
        : builtinToolSwitchCases(contextCompactionSource, fingerprint)),
      ...(capture === null
        ? []
        : builtinToolSwitchCases(contextCompactionSource, capture)),
      ...(matches === null
        ? []
        : builtinToolSwitchCases(contextCompactionSource, matches)),
    ]).toEqual([]);
  });

  test(`Given fake provider tool calls are scripted through the registry,
    When fake provider syntax is inspected,
    Then createFakeProvider does not switch on builtin tool names`, () => {
    const createProvider = functionDeclaration(
      fakeProviderSource,
      "createFakeProvider",
    );

    expect(
      createProvider === null
        ? []
        : builtinToolSwitchCases(fakeProviderSource, createProvider),
    ).toEqual([]);
  });
});
