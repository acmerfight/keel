import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, test } from "vitest";

const registryPath = "src/tools/registry.ts";
const registrySource = readFileSync(registryPath, "utf8");
const registrySourceFile = ts.createSourceFile(
  registryPath,
  registrySource,
  ts.ScriptTarget.Latest,
  true,
);
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

function location(node: ts.Node): string {
  const position = registrySourceFile.getLineAndCharacterOfPosition(
    node.getStart(registrySourceFile),
  );
  return `${registryPath}:${position.line + 1}:${position.character + 1}`;
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

function toolNameComparison(node: ts.BinaryExpression): string | null {
  if (!isEqualityOperator(node.operatorToken.kind)) {
    return null;
  }

  const leftLiteral = stringLiteralText(node.left);
  if (
    leftLiteral !== null &&
    builtinToolNames.has(leftLiteral) &&
    isNameExpression(node.right)
  ) {
    return `${location(node)} ${node.getText(registrySourceFile)}`;
  }

  const rightLiteral = stringLiteralText(node.right);
  if (
    rightLiteral !== null &&
    builtinToolNames.has(rightLiteral) &&
    isNameExpression(node.left)
  ) {
    return `${location(node)} ${node.getText(registrySourceFile)}`;
  }

  return null;
}

function perToolProviderConstants(
  sourceFile: ts.SourceFile,
): readonly string[] {
  const violations: string[] = [];

  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      builtinToolConstantNames.has(node.name.text)
    ) {
      violations.push(`${location(node)} ${node.name.text}`);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

function toolNameStringComparisons(
  sourceFile: ts.SourceFile,
): readonly string[] {
  const violations: string[] = [];

  function visit(node: ts.Node): void {
    if (ts.isBinaryExpression(node)) {
      const violation = toolNameComparison(node);
      if (violation !== null) {
        violations.push(violation);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

describe("builtin tool registry invariants", () => {
  test(`Given provider exposure is a registry-derived surface,
    When registry syntax is inspected,
    Then it does not keep per-tool provider definition objects`, () => {
    expect(perToolProviderConstants(registrySourceFile)).toEqual([]);
  });

  test(`Given builtin tool names are owned by builtinTools,
    When registry syntax is inspected,
    Then tool name checks do not duplicate the names as string comparisons`, () => {
    expect(toolNameStringComparisons(registrySourceFile)).toEqual([]);
  });
});
