import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import ts from "typescript";
import { describe, expect, test } from "vitest";

interface LayerRule {
  readonly layer: string;
  readonly contract: string;
  readonly forbidden: readonly RegExp[];
}

const layerRules: readonly LayerRule[] = [
  {
    layer: "src/agent",
    contract: "does not import fs, child_process, or cli/",
    forbidden: [
      /^(?:node:)?fs(?:\/|$)/,
      /^(?:node:)?child_process$/,
      /\/cli\//,
    ],
  },
  {
    layer: "src/llm",
    contract: "does not import cli/ or agent/",
    forbidden: [/\/cli\//, /\/agent\//],
  },
  {
    layer: "src/cli",
    contract: "does not import testing/",
    forbidden: [/\/testing\//],
  },
  {
    // The eval runner must measure keel through the same CLI surface a user
    // runs (spawned subprocess), never by importing harness internals.
    layer: "src/eval",
    contract: "does not import agent/, llm/, cli/, or testing/",
    forbidden: [/\/agent\//, /\/llm\//, /\/cli\//, /\/testing\//],
  },
];

function layerFiles(layer: string): readonly string[] {
  return readdirSync(layer, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(layer, name))
    .sort();
}

function projectFiles(root: string): readonly string[] {
  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".ts") || name.endsWith(".tsx"))
    .map((name) => join(root, name))
    .sort();
}

function sourceFiles(): readonly string[] {
  return projectFiles("src");
}

function sourceAndTestFiles(): readonly string[] {
  return [...projectFiles("src"), ...projectFiles("tests")];
}

function scriptKind(file: string): ts.ScriptKind {
  return file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function parseSource(file: string, source: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(file),
  );
}

function resolvedRelativeSpecifier(
  file: string,
  specifier: string,
): string | null {
  if (!specifier.startsWith(".")) {
    return null;
  }
  return normalize(join(dirname(file), specifier));
}

function stringLiteralText(node: ts.Node | undefined): string | null {
  if (
    node !== undefined &&
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
  ) {
    return node.text;
  }
  return null;
}

function importSpecifiers(file: string, source: string): readonly string[] {
  const sourceFile = parseSource(file, source);
  const specifiers: string[] = [];

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = stringLiteralText(node.moduleSpecifier);
      if (specifier !== null) {
        specifiers.push(specifier);
      }
    }

    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const [argument] = node.arguments;
      const specifier = stringLiteralText(argument);
      if (specifier !== null) {
        specifiers.push(specifier);
      }
    }

    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      const specifier = stringLiteralText(node.argument.literal);
      if (specifier !== null) {
        specifiers.push(specifier);
      }
    }

    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      const specifier = stringLiteralText(node.moduleReference.expression);
      if (specifier !== null) {
        specifiers.push(specifier);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return specifiers;
}

function wildcardReExportSpecifiers(
  file: string,
  source: string,
): readonly string[] {
  const sourceFile = parseSource(file, source);
  const specifiers: string[] = [];

  function visit(node: ts.Node): void {
    if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      const specifier = stringLiteralText(node.moduleSpecifier);
      if (
        specifier !== null &&
        (node.exportClause === undefined ||
          ts.isNamespaceExport(node.exportClause))
      ) {
        specifiers.push(specifier);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return specifiers;
}

function namedReExportSpecifiers(
  file: string,
  source: string,
): readonly string[] {
  const sourceFile = parseSource(file, source);
  const specifiers: string[] = [];

  function visit(node: ts.Node): void {
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      node.exportClause !== undefined &&
      ts.isNamedExports(node.exportClause)
    ) {
      const specifier = stringLiteralText(node.moduleSpecifier);
      if (specifier !== null) {
        specifiers.push(specifier);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return specifiers;
}

describe("module boundaries", () => {
  for (const { layer, contract, forbidden } of layerRules) {
    test(`every file in ${layer}/ ${contract}`, () => {
      const files = layerFiles(layer);
      expect(files.length).toBeGreaterThan(0);

      for (const file of files) {
        const source = readFileSync(file, "utf8");
        for (const specifier of importSpecifiers(file, source)) {
          const violated = forbidden.find((pattern) => pattern.test(specifier));
          expect(
            violated,
            `${file} imports "${specifier}" which violates: ${layer}/ ${contract}`,
          ).toBeUndefined();
        }
      }
    });
  }

  test(`src/cli/index.ts delegates provider configuration to a dedicated module`, () => {
    const source = readFileSync("src/cli/index.ts", "utf8");
    const forbidden = importSpecifiers("src/cli/index.ts", source).filter(
      (specifier) =>
        specifier.includes("/llm/providers/") ||
        specifier === "../core/cost.ts",
    );

    expect(forbidden).toEqual([]);
  });

  test(`interactive compaction helpers depend on dedicated post-compaction restore`, () => {
    const files = [
      "src/cli/interactive-session/manual-compact.ts",
      "src/cli/interactive-session/model-switch-compact.ts",
    ];

    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const specifiers = importSpecifiers(file, source);
      expect(
        source,
        `${file} must not import restore behavior from the agent loop`,
      ).not.toMatch(
        /\bimport\s*\{[\s\S]*\brestorePostCompactionReads\b[\s\S]*\}\s*from\s+["']\.\.\/\.\.\/agent\/loop\.ts["']/u,
      );
      expect(specifiers).toContain("../../agent/post-compaction-restore.ts");
    }
  });

  test(`src/agent/loop.ts does not re-export visibility or compaction restore helpers`, () => {
    const source = readFileSync("src/agent/loop.ts", "utf8");
    const helperNames =
      "ReadVisibilityState|createReadVisibilityState|clearReadVisibilityState|restorePostCompactionReads";

    expect(source).not.toMatch(
      new RegExp(
        `\\bexport\\s+(?:async\\s+)?(?:interface|function|const|class|type)\\s+(?:${helperNames})\\b`,
        "u",
      ),
    );
    expect(source).not.toMatch(
      new RegExp(
        `\\bexport\\s*\\{[\\s\\S]*?\\b(?:${helperNames})\\b[\\s\\S]*?\\}`,
        "u",
      ),
    );
  });

  test(`source modules do not use wildcard re-exports`, () => {
    const violations = sourceFiles().flatMap((file) =>
      wildcardReExportSpecifiers(file, readFileSync(file, "utf8")).map(
        (specifier) => `${file} re-exports wildcard from ${specifier}`,
      ),
    );

    expect(violations).toEqual([]);
  }, 15_000);

  test(`wildcard re-export detection covers value and type-only forms`, () => {
    expect(
      wildcardReExportSpecifiers("inline.ts", `export * from "./module.ts";`),
    ).toEqual(["./module.ts"]);
    expect(
      wildcardReExportSpecifiers(
        "inline.ts",
        `export * as Module from "./module.ts";`,
      ),
    ).toEqual(["./module.ts"]);
    expect(
      wildcardReExportSpecifiers(
        "inline.ts",
        `export type * from "./module.ts";`,
      ),
    ).toEqual(["./module.ts"]);
    expect(
      wildcardReExportSpecifiers(
        "inline.ts",
        `export type * as Module from "./module.ts";`,
      ),
    ).toEqual(["./module.ts"]);
    expect(
      wildcardReExportSpecifiers(
        "inline.ts",
        `export type { Module } from "./module.ts";`,
      ),
    ).toEqual([]);
    expect(
      wildcardReExportSpecifiers(
        "inline.ts",
        `const text = 'export * from "./module.ts";';`,
      ),
    ).toEqual([]);
  });

  test(`source modules do not introduce generic index barrel entrypoints`, () => {
    const indexFiles = sourceFiles().filter(
      (file) => file.endsWith("/index.ts") || file.endsWith("/index.tsx"),
    );

    expect(indexFiles).toEqual(["src/cli/index.ts"]);
  });

  test(`source re-export facades stay explicit and allowlisted`, () => {
    const allowedReExportFiles = [
      "src/cli/interactive-session.ts",
      "src/cli/interactive-session/types.ts",
      "src/cli/session-store.ts",
      "src/llm/providers/openai-compatible.ts",
      "src/llm/types.ts",
      "src/tools/execution.ts",
      "src/tools/registry.ts",
    ];
    const reExportingFiles = sourceFiles().filter(
      (file) =>
        namedReExportSpecifiers(file, readFileSync(file, "utf8")).length > 0,
    );

    expect(reExportingFiles).toEqual(allowedReExportFiles);
  }, 15_000);

  test(`external modules import session-store through the facade`, () => {
    const violations: string[] = [];

    for (const file of sourceAndTestFiles()) {
      if (
        file === "src/cli/session-store.ts" ||
        file.startsWith("src/cli/session-store/")
      ) {
        continue;
      }

      const source = readFileSync(file, "utf8");
      if (!source.includes("session-store/")) {
        continue;
      }

      for (const specifier of importSpecifiers(file, source)) {
        const resolved = resolvedRelativeSpecifier(file, specifier);
        if (resolved?.startsWith("src/cli/session-store/") === true) {
          violations.push(`${file} imports ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  test(`external modules import context compaction through the facade`, () => {
    const violations: string[] = [];

    for (const file of sourceAndTestFiles()) {
      if (
        file === "src/agent/context-compaction.ts" ||
        file.startsWith("src/agent/context-compaction/")
      ) {
        continue;
      }

      const source = readFileSync(file, "utf8");
      if (!source.includes("context-compaction/")) {
        continue;
      }

      for (const specifier of importSpecifiers(file, source)) {
        const resolved = resolvedRelativeSpecifier(file, specifier);
        if (resolved?.startsWith("src/agent/context-compaction/") === true) {
          violations.push(`${file} imports ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
