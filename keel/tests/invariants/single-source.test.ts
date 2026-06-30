import ts from "typescript";
import { describe, expect, test } from "vitest";
import {
  importedBindings,
  location,
  objectLiteralPropertyNames,
  type ParsedSource,
  parseSource,
  parseSourceText,
  unwrapExpression,
  variableInitializer,
} from "./_ast.ts";

const editMatchSource = parseSource("src/tools/edit-match.ts");
const editSource = parseSource("src/tools/edit.ts");
const patchHunksSource = parseSource("src/tools/apply-patch/hunks.ts");

const editMatchStrategyConsumers = [
  {
    functionName: "locateUniqueEditSpan",
    propertyName: "locate",
  },
  {
    functionName: "sourcePreservingReplacement",
    propertyName: "reconstruct",
  },
] satisfies readonly StrategyConsumer[];

const sourceReprojectionConsumers = [
  {
    source: editSource,
    moduleSpecifier: "./edit-match.ts",
  },
  {
    source: patchHunksSource,
    moduleSpecifier: "../edit-match.ts",
  },
] satisfies readonly SourceReprojectionConsumer[];

const sourceReprojectionHelpers = [
  "normalizeLineEndings",
  "normalizeWithSourceMap",
  "originalSpan",
  "sourceLineEnding",
  "sourceSpanReplacement",
] satisfies readonly string[];

interface StrategyConsumer {
  readonly functionName: string;
  readonly propertyName: string;
}

interface SourceReprojectionConsumer {
  readonly source: ParsedSource;
  readonly moduleSpecifier: string;
}

function variableArrayLiteral(
  source: ParsedSource,
  variableName: string,
): ts.ArrayLiteralExpression {
  const initializer = variableInitializer(source, variableName);
  const expression =
    initializer === null ? null : unwrapExpression(initializer);
  if (expression === null || !ts.isArrayLiteralExpression(expression)) {
    throw new Error(`${source.path} missing ${variableName} array literal`);
  }
  return expression;
}

function functionDeclaration(
  source: ParsedSource,
  functionName: string,
): ts.FunctionDeclaration {
  let declaration: ts.FunctionDeclaration | null = null;

  function visit(node: ts.Node): void {
    if (
      declaration === null &&
      ts.isFunctionDeclaration(node) &&
      node.name?.text === functionName
    ) {
      declaration = node;
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(source.sourceFile);
  if (declaration === null) {
    throw new Error(`${source.path} missing function ${functionName}`);
  }
  return declaration;
}

function functionDeclarations(source: ParsedSource): readonly string[] {
  const names: string[] = [];

  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
      names.push(node.name.text);
    }
    ts.forEachChild(node, visit);
  }

  visit(source.sourceFile);
  return names;
}

function propertyAccesses(node: ts.Node, propertyName: string): boolean {
  let found = false;

  function visit(current: ts.Node): void {
    if (
      !found &&
      ts.isPropertyAccessExpression(current) &&
      current.name.text === propertyName
    ) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  }

  visit(node);
  return found;
}

function consumesEditMatchStrategies(
  source: ParsedSource,
  consumer: StrategyConsumer,
): boolean {
  const declaration = functionDeclaration(source, consumer.functionName);
  let consumes = false;

  // This intentionally requires an explicit registry loop; update the matcher if
  // a future consumer shape still derives from EDIT_MATCH_STRATEGIES.
  function visit(node: ts.Node): void {
    if (
      !consumes &&
      ts.isForOfStatement(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "EDIT_MATCH_STRATEGIES" &&
      propertyAccesses(node.statement, consumer.propertyName)
    ) {
      consumes = true;
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(declaration);
  return consumes;
}

function editMatchStrategyViolations(source: ParsedSource): readonly string[] {
  const violations: string[] = [];
  for (const element of variableArrayLiteral(source, "EDIT_MATCH_STRATEGIES")
    .elements) {
    if (!ts.isObjectLiteralExpression(element)) {
      violations.push(
        `${location(source, element)} EDIT_MATCH_STRATEGIES entry must be an object literal`,
      );
      continue;
    }
    const properties = objectLiteralPropertyNames(element);
    for (const requiredProperty of ["locate", "reconstruct"]) {
      if (!properties.includes(requiredProperty)) {
        violations.push(
          `${location(source, element)} EDIT_MATCH_STRATEGIES entry missing ${requiredProperty}`,
        );
      }
    }
  }

  for (const consumer of editMatchStrategyConsumers) {
    if (!consumesEditMatchStrategies(source, consumer)) {
      violations.push(
        `${source.path} ${consumer.functionName} must derive ${consumer.propertyName} from EDIT_MATCH_STRATEGIES`,
      );
    }
  }
  return violations;
}

function importedHelperNames(
  consumer: SourceReprojectionConsumer,
): readonly string[] {
  return importedBindings(consumer.source)
    .filter((binding) => binding.moduleSpecifier === consumer.moduleSpecifier)
    .map((binding) => binding.name);
}

function sourceReprojectionViolations(
  consumers: readonly SourceReprojectionConsumer[],
): readonly string[] {
  const violations: string[] = [];
  for (const consumer of consumers) {
    const imported = importedHelperNames(consumer);
    const localFunctions = new Set(functionDeclarations(consumer.source));
    for (const helperName of sourceReprojectionHelpers) {
      if (!imported.includes(helperName)) {
        violations.push(
          `${consumer.source.path} must import ${helperName} from ${consumer.moduleSpecifier}`,
        );
      }
      if (localFunctions.has(helperName)) {
        violations.push(
          `${consumer.source.path} must not define local ${helperName}; use ${consumer.moduleSpecifier}`,
        );
      }
    }
  }
  return violations;
}

describe("single-source anti-drift invariants", () => {
  test(`Given an edit match strategy table entry is missing its reconstruction pair,
    When the paired-table invariant inspects the source,
    Then it reports the incomplete entry`, () => {
    const source = parseSourceText(
      "src/tools/edit-match.ts",
      [
        "function exactMatches(): readonly unknown[] { return []; }",
        "const EDIT_MATCH_STRATEGIES = [{ locate: exactMatches }];",
        "export function locateUniqueEditSpan(): void {",
        "  for (const strategy of EDIT_MATCH_STRATEGIES) strategy.locate();",
        "}",
        "export function sourcePreservingReplacement(): void {",
        "  for (const strategy of EDIT_MATCH_STRATEGIES) strategy.reconstruct();",
        "}",
      ].join("\n"),
    );

    expect(editMatchStrategyViolations(source)).toEqual([
      "src/tools/edit-match.ts:2:32 EDIT_MATCH_STRATEGIES entry missing reconstruct",
    ]);
  });

  test(`Given a consumer maintains a parallel strategy list,
    When the paired-table invariant inspects edit matching,
    Then it reports the consumer that stopped deriving from the shared table`, () => {
    const source = parseSourceText(
      "src/tools/edit-match.ts",
      [
        "function exactMatches(): readonly unknown[] { return []; }",
        "function exactReplacement(): void {}",
        "const LOCATE_STRATEGIES = [exactMatches];",
        "const EDIT_MATCH_STRATEGIES = [{ locate: exactMatches, reconstruct: exactReplacement }];",
        "export function locateUniqueEditSpan(): void {",
        "  for (const locate of LOCATE_STRATEGIES) locate();",
        "}",
        "export function sourcePreservingReplacement(): void {",
        "  for (const strategy of EDIT_MATCH_STRATEGIES) strategy.reconstruct();",
        "}",
      ].join("\n"),
    );

    expect(editMatchStrategyViolations(source)).toEqual([
      "src/tools/edit-match.ts locateUniqueEditSpan must derive locate from EDIT_MATCH_STRATEGIES",
    ]);
  });

  test(`Given fuzzy edit matching has paired locate and reconstruct behavior,
    When edit-match source is inspected,
    Then every strategy consumer derives from EDIT_MATCH_STRATEGIES`, () => {
    expect(editMatchStrategyViolations(editMatchSource)).toEqual([]);
  });

  test(`Given edit and apply_patch both reproject normalized source spans,
    When their source files are inspected,
    Then both use the same source-reprojection helpers from edit-match`, () => {
    expect(sourceReprojectionViolations(sourceReprojectionConsumers)).toEqual(
      [],
    );
  });
});
