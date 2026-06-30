import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

export interface ParsedSource {
  readonly path: string;
  readonly text: string;
  readonly sourceFile: ts.SourceFile;
}

export interface ImportedBinding {
  readonly name: string;
  readonly importedName: string;
  readonly moduleSpecifier: string;
  readonly location: string;
}

export type LiteralValue = string | number;
export type TestExpectationMatcher = "toBe" | "toContain" | "toHaveLength";

export type TestExpectationArgument =
  | {
      readonly kind: "literal";
      readonly value: LiteralValue;
    }
  | {
      readonly kind: "identifier";
      readonly name: string;
    }
  | {
      readonly kind: "containsString";
      readonly value: string;
    };

export interface TestExpectationEvidence {
  readonly matcher: TestExpectationMatcher;
  readonly argument: TestExpectationArgument;
  readonly negated: boolean;
}

export interface ActiveTestEvidence {
  readonly bodyStrings: readonly string[];
  readonly testEachValues: readonly LiteralValue[];
  readonly expectations: readonly TestExpectationEvidence[];
}

export interface ActiveTestBody {
  readonly body: ts.ConciseBody;
  readonly testEachValues: readonly LiteralValue[];
}

export function collectTypeScriptFiles(directory: string): readonly string[] {
  const files: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTypeScriptFiles(path));
      continue;
    }
    /* v8 ignore next -- invariant source directories only need TypeScript files. */
    if (entry.isFile() && path.endsWith(".ts")) {
      files.push(path);
    }
  }

  return files.sort();
}

export function parseSource(path: string): ParsedSource {
  return parseSourceText(path, readFileSync(path, "utf8"));
}

export function parseSourceText(path: string, text: string): ParsedSource {
  /* v8 ignore next -- current invariant sources are TypeScript; TSX is supported for reuse. */
  const scriptKind = path.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : ts.ScriptKind.TS;
  return {
    path,
    text,
    sourceFile: ts.createSourceFile(
      path,
      text,
      ts.ScriptTarget.Latest,
      true,
      scriptKind,
    ),
  };
}

export function location(source: ParsedSource, node: ts.Node): string {
  const position = source.sourceFile.getLineAndCharacterOfPosition(
    node.getStart(source.sourceFile),
  );
  return `${source.path}:${position.line + 1}:${position.character + 1}`;
}

export function propertyNameText(node: ts.PropertyName): string | null {
  /* v8 ignore next 5 -- invariant scans only need literal property names. */
  if (
    ts.isIdentifier(node) ||
    ts.isStringLiteral(node) ||
    ts.isNumericLiteral(node)
  ) {
    return node.text;
  }
  /* v8 ignore next -- invariant scans intentionally ignore computed keys. */
  return null;
}

export function stringLiteralValue(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return null;
}

function literalValue(node: ts.Node): LiteralValue | null {
  const stringValue = stringLiteralValue(node);
  if (stringValue !== null) return stringValue;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  return null;
}

function stringLiteralsIn(node: ts.Node): readonly string[] {
  const literals: string[] = [];

  function visit(child: ts.Node): void {
    const value = stringLiteralValue(child);
    if (value !== null) {
      literals.push(value);
    }
    ts.forEachChild(child, visit);
  }

  visit(node);
  return literals;
}

function expressionContainsStringLiteral(
  expression: ts.Expression,
  expected: string,
): boolean {
  let found = false;

  function visit(node: ts.Node): void {
    if (found) return;
    if (stringLiteralValue(node) === expected) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(expression);
  return found;
}

function argumentMatchesEvidence(
  argument: ts.Expression,
  expected: TestExpectationArgument,
): boolean {
  if (expected.kind === "literal") {
    return literalValue(argument) === expected.value;
  }
  if (expected.kind === "identifier") {
    return ts.isIdentifier(argument) && argument.text === expected.name;
  }
  return expressionContainsStringLiteral(argument, expected.value);
}

function testEachValues(
  expression: ts.Expression,
): readonly LiteralValue[] | null {
  if (
    !ts.isCallExpression(expression) ||
    !ts.isPropertyAccessExpression(expression.expression) ||
    expression.expression.name.text !== "each" ||
    !ts.isIdentifier(expression.expression.expression) ||
    expression.expression.expression.text !== "test"
  ) {
    return null;
  }

  const cases = expression.arguments[0];
  if (cases === undefined || !ts.isArrayLiteralExpression(cases)) return [];
  const values: LiteralValue[] = [];
  for (const element of cases.elements) {
    const value = literalValue(element);
    if (value !== null) values.push(value);
  }
  return values;
}

function activeTestBody(node: ts.CallExpression): ActiveTestBody | null {
  const eachValues = testEachValues(node.expression);
  const isTestCall =
    ts.isIdentifier(node.expression) && node.expression.text === "test";
  if (!isTestCall && eachValues === null) return null;

  const callback = node.arguments[1];
  if (
    callback === undefined ||
    (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))
  ) {
    return null;
  }

  return {
    body: callback.body,
    testEachValues: eachValues ?? [],
  };
}

export function activeTestBodies(
  source: ParsedSource,
): readonly ActiveTestBody[] {
  const bodies: ActiveTestBody[] = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const body = activeTestBody(node);
      if (body !== null) {
        bodies.push(body);
        return;
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(source.sourceFile);
  return bodies;
}

function callMatchesExpectation(
  call: ts.CallExpression,
  expectation: TestExpectationEvidence,
): boolean {
  if (
    !ts.isPropertyAccessExpression(call.expression) ||
    call.expression.name.text !== expectation.matcher
  ) {
    return false;
  }

  const value = call.arguments[0];
  if (
    value === undefined ||
    !argumentMatchesEvidence(value, expectation.argument)
  ) {
    return false;
  }

  const receiver = call.expression.expression;
  const negated =
    ts.isPropertyAccessExpression(receiver) && receiver.name.text === "not";
  return negated === expectation.negated;
}

function bodyHasExpectation(
  body: ts.Node,
  expectation: TestExpectationEvidence,
): boolean {
  let found = false;

  function visit(node: ts.Node): void {
    if (found) return;
    if (
      ts.isCallExpression(node) &&
      callMatchesExpectation(node, expectation)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(body);
  return found;
}

export function activeTestSatisfiesEvidence(
  testBody: ActiveTestBody,
  evidence: ActiveTestEvidence,
): boolean {
  const bodyStrings = new Set(stringLiteralsIn(testBody.body));
  for (const bodyString of evidence.bodyStrings) {
    if (!bodyStrings.has(bodyString)) return false;
  }
  for (const value of evidence.testEachValues) {
    if (!testBody.testEachValues.includes(value)) return false;
  }
  for (const expectation of evidence.expectations) {
    if (!bodyHasExpectation(testBody.body, expectation)) return false;
  }
  return true;
}

export function sourceHasActiveTestEvidence(
  source: ParsedSource,
  evidence: ActiveTestEvidence,
): boolean {
  return activeTestBodies(source).some((body) =>
    activeTestSatisfiesEvidence(body, evidence),
  );
}

export function variableInitializer(
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
      /* v8 ignore next -- invariant callers pass initialized constants. */
      initializer = node.initializer ?? null;
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(source.sourceFile);
  return initializer;
}

export function unwrapExpression(expression: ts.Expression): ts.Expression {
  if (
    ts.isAsExpression(expression) ||
    ts.isParenthesizedExpression(expression)
  ) {
    return unwrapExpression(expression.expression);
  }
  return expression;
}

export function arrayIdentifierElements(
  source: ParsedSource,
  variableName: string,
): readonly string[] {
  const initializer = variableInitializer(source, variableName);
  /* v8 ignore next -- missing constants are reported below as invariant wiring failures. */
  const expression =
    initializer === null ? null : unwrapExpression(initializer);
  /* v8 ignore next 3: invariant callers pass known array constants; this reports future wiring mistakes. */
  if (expression === null || !ts.isArrayLiteralExpression(expression)) {
    throw new Error(`${source.path} missing ${variableName} array literal`);
  }

  const names: string[] = [];
  for (const element of expression.elements) {
    /* v8 ignore next 3: invariant callers use identifier arrays; this reports future wiring mistakes. */
    if (!ts.isIdentifier(element)) {
      throw new Error(`${location(source, element)} must be an identifier`);
    }
    names.push(element.text);
  }
  return names;
}

export function objectProperty(
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
  /* v8 ignore next: callers use this to report optional/missing syntax explicitly. */
  return null;
}

export function objectLiteralPropertyNames(
  object: ts.ObjectLiteralExpression,
): readonly string[] {
  const names: string[] = [];
  for (const property of object.properties) {
    /* v8 ignore next -- invariant metadata objects use property assignments. */
    if (ts.isPropertyAssignment(property)) {
      const name = propertyNameText(property.name);
      /* v8 ignore next: invariant metadata uses plain property names. */
      if (name !== null) names.push(name);
    }
  }
  return names;
}

function importModuleSpecifier(node: ts.ImportDeclaration): string | null {
  /* v8 ignore next -- import declarations in parsed TypeScript use string module specifiers. */
  return ts.isStringLiteral(node.moduleSpecifier)
    ? node.moduleSpecifier.text
    : null;
}

export function importedBindings(
  source: ParsedSource,
): readonly ImportedBinding[] {
  const bindings: ImportedBinding[] = [];

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) {
      const moduleSpecifier = importModuleSpecifier(node);
      const namedBindings = node.importClause?.namedBindings;
      if (
        moduleSpecifier !== null &&
        namedBindings !== undefined &&
        ts.isNamedImports(namedBindings)
      ) {
        for (const element of namedBindings.elements) {
          bindings.push({
            name: element.name.text,
            importedName: element.propertyName?.text ?? element.name.text,
            moduleSpecifier,
            location: location(source, element),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(source.sourceFile);
  return bindings;
}
