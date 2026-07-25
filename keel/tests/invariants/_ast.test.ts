import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, test } from "vitest";
import {
  collectTypeScriptFiles,
  importedBindings,
  objectLiteralPropertyNames,
  objectProperty,
  parseSourceText,
  variableInitializer,
} from "./_ast.ts";

describe("Invariant AST Helpers", () => {
  test(`Given a source tree contains TypeScript and unrelated files,
    When invariant sources are collected recursively,
    Then only TypeScript files are returned in stable order`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-invariant-ast-"));
    await mkdir(join(workspace, "nested"));
    await writeFile(join(workspace, "z.ts"), "export {};\n", "utf8");
    await writeFile(join(workspace, "notes.md"), "# Notes\n", "utf8");
    await symlink("z.ts", join(workspace, "linked.ts"));
    await writeFile(
      join(workspace, "nested", "a.ts"),
      "export {};\n",
      "utf8",
    );

    try {
      // When
      const files = collectTypeScriptFiles(workspace);

      // Then
      expect(files).toEqual([
        join(workspace, "nested", "a.ts"),
        join(workspace, "z.ts"),
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given TSX source text,
    When it is parsed for invariant evidence,
    Then the source file uses the TSX script kind`, () => {
    // Given / When
    const source = parseSourceText("component.tsx", "const view = <div />;\n");

    // Then
    expect(source.sourceFile.scriptKind).toBe(ts.ScriptKind.TSX);
  });

  test(`Given an object mixes literal, computed, and spread properties,
    When invariant metadata is extracted,
    Then only literal property assignments are reported`, () => {
    // Given
    const source = parseSourceText(
      "metadata.ts",
      'const metadata = { plain: 1, "quoted": 2, 3: 3, [dynamic]: 4, ...rest };\n',
    );
    const initializer = variableInitializer(source, "metadata");
    if (initializer === null || !ts.isObjectLiteralExpression(initializer)) {
      throw new Error("expected metadata object initializer");
    }

    // When
    const names = objectLiteralPropertyNames(initializer);
    const missing = objectProperty(initializer, "missing");

    // Then
    expect(names).toEqual(["plain", "quoted", "3"]);
    expect(missing).toBeNull();
  });

  test(`Given a declared variable has no initializer,
    When its initializer is inspected,
    Then the helper reports the missing syntax`, () => {
    // Given
    const source = parseSourceText("declaration.ts", "let pending;\n");

    // When / Then
    expect(variableInitializer(source, "pending")).toBeNull();
  });

  test(`Given a malformed import has a non-literal module specifier,
    When imported bindings are extracted fail-closed,
    Then no binding evidence is returned`, () => {
    // Given
    const source = parseSourceText(
      "consumer.ts",
      "import { value } from source;\n",
    );

    // When / Then
    expect(importedBindings(source)).toEqual([]);
  });
});
