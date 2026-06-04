import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, test } from "vitest";

function collectTypeScriptFiles(directory: string): readonly string[] {
  const files: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTypeScriptFiles(path));
      continue;
    }
    if (entry.isFile() && path.endsWith(".ts")) {
      files.push(path);
    }
  }

  return files.sort();
}

function location(sourceFile: ts.SourceFile, node: ts.Node): string {
  const position = sourceFile.getLineAndCharacterOfPosition(
    node.getStart(sourceFile),
  );
  return `${sourceFile.fileName}:${position.line + 1}:${position.character + 1}`;
}

function isConstAssertion(
  sourceFile: ts.SourceFile,
  node: ts.AsExpression,
): boolean {
  return node.type.getText(sourceFile) === "const";
}

function findTypeAssertions(file: string): readonly string[] {
  const source = readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const failures: string[] = [];

  function visit(node: ts.Node): void {
    if (ts.isAsExpression(node) && !isConstAssertion(sourceFile, node)) {
      failures.push(location(sourceFile, node));
    }
    if (node.kind === ts.SyntaxKind.TypeAssertionExpression) {
      failures.push(location(sourceFile, node));
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return failures;
}

describe("type precision invariants", () => {
  test("Given TypeScript source files, When checking project conventions, Then no type assertions are used except as const", () => {
    const files = [
      ...collectTypeScriptFiles("src"),
      ...collectTypeScriptFiles("tests"),
    ];

    expect(files.flatMap(findTypeAssertions)).toEqual([]);
  });
});
