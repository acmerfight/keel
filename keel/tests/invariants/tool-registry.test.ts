import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, test } from "vitest";

interface ParsedSource {
  readonly path: string;
  readonly sourceFile: ts.SourceFile;
}

const registryPath = "src/tools/registry.ts";
const toolCallPath = "src/tools/tool-call.ts";
const toolDefinitionsPath = "src/tools/tool-definitions.ts";
const executionPath = "src/tools/execution.ts";
const cliOutputPath = "src/cli/output.ts";
const contextCompactionPath = "src/agent/context-compaction.ts";
const fakeProviderPath = "src/llm/providers/fake.ts";
const registrySource = parseSource(registryPath);
const toolCallSource = parseSource(toolCallPath);
const toolDefinitionsSource = parseSource(toolDefinitionsPath);
const executionSource = parseSource(executionPath);
const cliOutputSource = parseSource(cliOutputPath);
const contextCompactionSource = parseSource(contextCompactionPath);
const fakeProviderSource = parseSource(fakeProviderPath);
const builtinToolConstantNames = new Set(
  arrayIdentifierElements(toolDefinitionsSource, "builtinTools"),
);
const builtinToolNames = new Set(
  builtinToolLiteralNames(toolDefinitionsSource, builtinToolConstantNames),
);
const perToolArgumentSchemaNames = new Set(
  builtinToolArgumentSchemaNames(
    toolDefinitionsSource,
    builtinToolConstantNames,
  ),
);
const perToolExecutorNames = new Set(importedExecutorNames(executionSource));

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

function propertyNameText(node: ts.PropertyName): string | null {
  if (
    ts.isIdentifier(node) ||
    ts.isStringLiteral(node) ||
    ts.isNumericLiteral(node)
  ) {
    return node.text;
  }
  return null;
}

function variableInitializer(
  source: ParsedSource,
  name: string,
): ts.Expression | null {
  let initializer: ts.Expression | null = null;

  function visit(node: ts.Node): void {
    if (
      initializer === null &&
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      initializer = node.initializer ?? null;
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(source.sourceFile);
  return initializer;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  if (
    ts.isAsExpression(expression) ||
    ts.isParenthesizedExpression(expression)
  ) {
    return unwrapExpression(expression.expression);
  }
  return expression;
}

function arrayIdentifierElements(
  source: ParsedSource,
  variableName: string,
): readonly string[] {
  const initializer = variableInitializer(source, variableName);
  const expression =
    initializer === null ? null : unwrapExpression(initializer);
  if (expression === null || !ts.isArrayLiteralExpression(expression)) {
    throw new Error(`${source.path} missing ${variableName} array literal`);
  }

  const names: string[] = [];
  for (const element of expression.elements) {
    if (!ts.isIdentifier(element)) {
      throw new Error(`${location(source, element)} must be an identifier`);
    }
    names.push(element.text);
  }
  return names;
}

function objectProperty(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.PropertyAssignment | null {
  for (const property of object.properties) {
    if (
      ts.isPropertyAssignment(property) &&
      propertyNameText(property.name) === name
    ) {
      return property;
    }
  }
  return null;
}

function defineToolObject(
  source: ParsedSource,
  constantName: string,
): ts.ObjectLiteralExpression {
  const initializer = variableInitializer(source, constantName);
  const expression =
    initializer === null ? null : unwrapExpression(initializer);
  if (
    expression === null ||
    !ts.isCallExpression(expression) ||
    !ts.isIdentifier(expression.expression) ||
    expression.expression.text !== "defineTool"
  ) {
    throw new Error(`${source.path} missing defineTool for ${constantName}`);
  }

  const [toolDefinition] = expression.arguments;
  if (
    toolDefinition === undefined ||
    !ts.isObjectLiteralExpression(toolDefinition)
  ) {
    throw new Error(
      `${location(source, expression)} defineTool must receive an object literal`,
    );
  }
  return toolDefinition;
}

function builtinToolLiteralNames(
  source: ParsedSource,
  constantNames: ReadonlySet<string>,
): readonly string[] {
  const names: string[] = [];
  for (const constantName of constantNames) {
    const nameProperty = objectProperty(
      defineToolObject(source, constantName),
      "name",
    );
    if (
      nameProperty === null ||
      !ts.isStringLiteral(nameProperty.initializer)
    ) {
      throw new Error(`${source.path} missing string name for ${constantName}`);
    }
    names.push(nameProperty.initializer.text);
  }
  return names;
}

function builtinToolArgumentSchemaNames(
  source: ParsedSource,
  constantNames: ReadonlySet<string>,
): readonly string[] {
  const names: string[] = [];
  for (const constantName of constantNames) {
    const argsProperty = objectProperty(
      defineToolObject(source, constantName),
      "args",
    );
    const initializer = argsProperty?.initializer;
    if (
      initializer === undefined ||
      !ts.isCallExpression(initializer) ||
      !ts.isIdentifier(initializer.expression) ||
      initializer.expression.text !== "toolArgs"
    ) {
      throw new Error(`${source.path} missing toolArgs for ${constantName}`);
    }

    const [schema] = initializer.arguments;
    if (schema === undefined || !ts.isIdentifier(schema)) {
      throw new Error(
        `${location(source, initializer)} toolArgs must receive a schema identifier`,
      );
    }
    names.push(schema.text);
  }
  return names;
}

function importedExecutorNames(source: ParsedSource): readonly string[] {
  const names: string[] = [];

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) {
      const namedBindings = node.importClause?.namedBindings;
      if (namedBindings !== undefined && ts.isNamedImports(namedBindings)) {
        for (const element of namedBindings.elements) {
          if (/^execute[A-Z]/.test(element.name.text)) {
            names.push(element.name.text);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(source.sourceFile);
  return names;
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

function perToolFakeResponseHelpers(source: ParsedSource): readonly string[] {
  const violations: string[] = [];

  function isPerToolFakeResponseHelperName(name: string): boolean {
    return name !== "fakeToolResponse" && /^fake[A-Z].*Response$/.test(name);
  }

  function visit(node: ts.Node): void {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name !== undefined &&
      isPerToolFakeResponseHelperName(node.name.text)
    ) {
      violations.push(`${location(source, node)} ${node.name.text}`);
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      isPerToolFakeResponseHelperName(node.name.text)
    ) {
      violations.push(`${location(source, node)} ${node.name.text}`);
    }
    ts.forEachChild(node, visit);
  }

  visit(source.sourceFile);
  return violations;
}

function identifierOccurrences(
  source: ParsedSource,
  names: ReadonlySet<string>,
): readonly string[] {
  const occurrences: string[] = [];

  function visit(node: ts.Node): void {
    if (ts.isIdentifier(node) && names.has(node.text)) {
      occurrences.push(`${location(source, node)} ${node.text}`);
    }
    ts.forEachChild(node, visit);
  }

  visit(source.sourceFile);
  return occurrences;
}

function propertyNames(
  source: ParsedSource,
  names: ReadonlySet<string>,
): readonly string[] {
  const occurrences: string[] = [];

  function visit(node: ts.Node): void {
    if (ts.isPropertyAssignment(node)) {
      const name = ts.isIdentifier(node.name) ? node.name.text : null;
      if (name !== null && names.has(name)) {
        occurrences.push(`${location(source, node)} ${name}`);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(source.sourceFile);
  return occurrences;
}

describe("builtin tool registry invariants", () => {
  test(`Given Zod schemas own builtin tool arguments,
    When definition, contract, and registry syntax is inspected,
    Then no parallel ToolArgDefinition field layer remains`, () => {
    const customArgumentIdentifiers = new Set([
      "ToolArgDefinition",
      "ToolArgFields",
      "ToolArgsSpec",
      "stringArg",
      "integerArg",
      "booleanArg",
      "arrayArg",
      "objectArg",
    ]);

    expect(
      identifierOccurrences(toolDefinitionsSource, customArgumentIdentifiers),
    ).toEqual([]);
    expect(propertyNames(toolDefinitionsSource, new Set(["fields"]))).toEqual(
      [],
    );
    expect(
      importedBindings(toolCallSource, new Set(["ToolArgDefinition"])),
    ).toEqual([]);
    expect(
      importedBindings(registrySource, new Set(["ToolArgDefinition"])),
    ).toEqual([]);
  });

  test(`Given provider exposure is a tool-call-contract-derived surface,
    When tool-call contract syntax is inspected,
    Then it does not keep per-tool provider definition objects`, () => {
    expect(perToolProviderConstants(toolCallSource)).toEqual([]);
  });

  test(`Given builtin tool names are owned by builtinTools,
    When tool-call contract syntax is inspected,
    Then tool name checks do not duplicate the names as string comparisons`, () => {
    expect(toolNameStringComparisons(toolCallSource)).toEqual([]);
  });

  test(`Given tool call parsing is derived from builtin tool metadata,
    When tool-call contract syntax is inspected,
    Then parsing does not import per-tool argument schemas or switch on tool names`, () => {
    const parser = functionDeclaration(
      toolCallSource,
      "toolCallFromParsedArguments",
    );

    expect(
      importedBindings(toolCallSource, perToolArgumentSchemaNames),
    ).toEqual([]);
    expect(
      parser === null ? [] : switchStatements(toolCallSource, parser),
    ).toEqual([]);
  });

  test(`Given tool execution owns builtin executor binding,
    When definition, contract, and registry syntax is inspected,
    Then metadata and provider-facing contracts do not import per-tool executors`, () => {
    expect(perToolExecutorNames.size).toBeGreaterThan(0);
    expect(
      importedBindings(toolDefinitionsSource, perToolExecutorNames),
    ).toEqual([]);
    expect(importedBindings(toolCallSource, perToolExecutorNames)).toEqual([]);
    expect(importedBindings(registrySource, perToolExecutorNames)).toEqual([]);
  });

  test(`Given canonical tool arguments are derived from builtin metadata,
    When tool-call contract syntax is inspected,
    Then toolCallArguments does not switch on builtin tool names`, () => {
    const serializer = functionDeclaration(toolCallSource, "toolCallArguments");

    expect(
      serializer === null
        ? []
        : builtinToolSwitchCases(toolCallSource, serializer),
    ).toEqual([]);
  });

  test(`Given CLI tool labels are derived from builtin display metadata,
    When CLI output syntax is inspected,
    Then toolCallLabel does not switch on builtin tool names`, () => {
    const contractLabeler = functionDeclaration(
      toolCallSource,
      "toolCallLabel",
    );
    const printer = functionDeclaration(cliOutputSource, "printAgentEvents");

    expect(
      importedBindings(cliOutputSource, new Set(["toolCallLabel"])),
    ).toHaveLength(1);
    expect(
      contractLabeler === null
        ? ["missing toolCallLabel"]
        : builtinToolSwitchCases(toolCallSource, contractLabeler),
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

  test(`Given fake provider tool calls are scripted through the tool-call contract,
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

  test(`Given fake provider tool scripting is contract-generic,
    When fake provider syntax is inspected,
    Then it does not expose per-tool response helper functions`, () => {
    expect(perToolFakeResponseHelpers(fakeProviderSource)).toEqual([]);
  });
});
