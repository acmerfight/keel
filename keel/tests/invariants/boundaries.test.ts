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

function importedNamesFromResolvedSpecifier(
  file: string,
  source: string,
  target: string,
): readonly string[] {
  const sourceFile = parseSource(file, source);
  const names: string[] = [];

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) {
      const specifier = stringLiteralText(node.moduleSpecifier);
      const resolved =
        specifier === null ? null : resolvedRelativeSpecifier(file, specifier);
      if (resolved === target) {
        const namedBindings = node.importClause?.namedBindings;
        if (namedBindings !== undefined && ts.isNamedImports(namedBindings)) {
          for (const element of namedBindings.elements) {
            names.push(element.propertyName?.text ?? element.name.text);
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return names;
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

  test(`src/cli/index.ts stays a thin command router`, () => {
    const source = readFileSync("src/cli/index.ts", "utf8");
    const specifiers = importSpecifiers("src/cli/index.ts", source);

    expect(specifiers).toEqual([
      "node:fs",
      "node:url",
      "./args.ts",
      "./fork-points-command.ts",
      "./interactive-run.ts",
      "./one-shot-run.ts",
      "./runtime.ts",
      "./sessions-command.ts",
      "./top-level-commands.ts",
    ]);
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

  test(`agent event contracts are imported from the dedicated event module`, () => {
    const violations: string[] = [];
    const contractNames = ["AgentEvent", "CostReport"];

    for (const file of sourceAndTestFiles()) {
      if (file === "src/agent/loop.ts") {
        continue;
      }

      const source = readFileSync(file, "utf8");
      if (!source.includes("loop.ts")) {
        continue;
      }
      const importedContracts = importedNamesFromResolvedSpecifier(
        file,
        source,
        "src/agent/loop.ts",
      ).filter((name) => contractNames.includes(name));

      for (const name of importedContracts) {
        violations.push(`${file} imports ${name} from src/agent/loop.ts`);
      }
    }

    expect(violations).toEqual([]);
  }, 15_000);

  test(`src/agent/loop.ts does not export agent event contracts`, () => {
    const source = readFileSync("src/agent/loop.ts", "utf8");

    expect(source).not.toMatch(/\bexport\s+interface\s+CostReport\b/u);
    expect(source).not.toMatch(/\bexport\s+type\s+AgentEvent\b/u);
  });

  test(`agent provider turn boundary does not depend on ledger compaction or tools`, () => {
    const source = readFileSync("src/agent/provider-turn.ts", "utf8");
    const specifiers = importSpecifiers("src/agent/provider-turn.ts", source);

    expect(specifiers).not.toContain("./session-ledger.ts");
    expect(specifiers).not.toContain("./context-compaction.ts");
    expect(specifiers).not.toContain("../tools/registry.ts");
    expect(specifiers).not.toContain("../tools/execution.ts");
    expect(specifiers).not.toContain("./tool-scheduler.ts");
  });

  test(`agent compaction retry boundary does not depend on tool execution`, () => {
    const source = readFileSync("src/agent/turn-compaction.ts", "utf8");
    const specifiers = importSpecifiers("src/agent/turn-compaction.ts", source);

    expect(specifiers).not.toContain("../tools/execution.ts");
    expect(specifiers).not.toContain("./tool-scheduler.ts");
    expect(specifiers).not.toContain("../permissions/bash.ts");
  });

  test(`llm modules import the stable tool-call contract instead of tool execution surfaces`, () => {
    const violations: string[] = [];

    for (const file of layerFiles("src/llm")) {
      const source = readFileSync(file, "utf8");
      for (const specifier of importSpecifiers(file, source)) {
        const resolved = resolvedRelativeSpecifier(file, specifier);
        if (
          resolved?.startsWith("src/tools/") === true &&
          resolved !== "src/tools/tool-call.ts"
        ) {
          violations.push(`${file} imports ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  test(`session records validate tool calls through the stable contract`, () => {
    const file = "src/cli/session-store/records.ts";
    const source = readFileSync(file, "utf8");
    const specifiers = importSpecifiers(file, source);

    expect(specifiers).toContain("../../tools/tool-call.ts");
    expect(specifiers).not.toContain("../../tools/builtin.ts");
    expect(specifiers).not.toContain("../../tools/registry.ts");
  });

  test(`tool definitions keep metadata separate from builtin executors`, () => {
    const file = "src/tools/tool-definitions.ts";
    const source = readFileSync(file, "utf8");
    const specifiers = importSpecifiers(file, source);

    expect(
      specifiers.filter((specifier) =>
        /^\.\/(?:apply-patch|bash|edit|glob|grep|ls|read|write)\.ts$/u.test(
          specifier,
        ),
      ),
    ).toEqual([]);
    expect(source).not.toMatch(/\bexecute[A-Z]/u);
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
      "src/cli/args.ts",
      "src/cli/interactive-session.ts",
      "src/cli/interactive-session/types.ts",
      "src/cli/provider-config.ts",
      "src/cli/session-store.ts",
      "src/llm/providers/openai-compatible.ts",
      "src/llm/types.ts",
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

  test(`external modules import apply-patch through the facade`, () => {
    const violations: string[] = [];

    for (const file of sourceAndTestFiles()) {
      if (
        file === "src/tools/apply-patch.ts" ||
        file.startsWith("src/tools/apply-patch/")
      ) {
        continue;
      }

      const source = readFileSync(file, "utf8");
      if (!source.includes("apply-patch/")) {
        continue;
      }

      for (const specifier of importSpecifiers(file, source)) {
        const resolved = resolvedRelativeSpecifier(file, specifier);
        if (resolved?.startsWith("src/tools/apply-patch/") === true) {
          violations.push(`${file} imports ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  test(`CLI args parsing keeps command parsers behind the args facade`, () => {
    const facadeSource = readFileSync("src/cli/args.ts", "utf8");

    expect(namedReExportSpecifiers("src/cli/args.ts", facadeSource)).toEqual([
      "./args/types.ts",
      "./args/usage.ts",
    ]);
    expect(facadeSource).not.toMatch(/export\s+\*/u);

    const facadeSpecifiers = importSpecifiers("src/cli/args.ts", facadeSource);
    expect(facadeSpecifiers).not.toContain("zod");
    expect(facadeSpecifiers).not.toContain("node:path");
    expect(facadeSpecifiers).not.toContain("../core/provider-id.ts");
    expect(facadeSpecifiers).not.toContain("../permissions/bash.ts");

    expect(
      importSpecifiers(
        "src/cli/args/shared.ts",
        readFileSync("src/cli/args/shared.ts", "utf8"),
      ),
    ).toEqual([
      "zod",
      "../../core/provider-id.ts",
      "../../permissions/bash.ts",
    ]);
    expect(
      importSpecifiers(
        "src/cli/args/eval.ts",
        readFileSync("src/cli/args/eval.ts", "utf8"),
      ),
    ).toEqual(["node:path", "./shared.ts", "./types.ts"]);
    expect(
      importSpecifiers(
        "src/cli/args/run.ts",
        readFileSync("src/cli/args/run.ts", "utf8"),
      ),
    ).toEqual(["../../permissions/bash.ts", "./shared.ts", "./types.ts"]);
    expect(
      importSpecifiers(
        "src/cli/args/sessions.ts",
        readFileSync("src/cli/args/sessions.ts", "utf8"),
      ),
    ).toEqual(["./shared.ts", "./types.ts"]);
    expect(
      importSpecifiers(
        "src/cli/args/doctor.ts",
        readFileSync("src/cli/args/doctor.ts", "utf8"),
      ),
    ).toEqual(["./shared.ts", "./types.ts"]);
    expect(
      importSpecifiers(
        "src/cli/args/usage.ts",
        readFileSync("src/cli/args/usage.ts", "utf8"),
      ),
    ).toEqual([]);
  });

  test(`external modules import CLI args through the facade`, () => {
    const internalFiles = new Set([
      "src/cli/args.ts",
      "src/cli/args/doctor.ts",
      "src/cli/args/eval.ts",
      "src/cli/args/run.ts",
      "src/cli/args/sessions.ts",
      "src/cli/args/shared.ts",
      "src/cli/args/types.ts",
      "src/cli/args/usage.ts",
    ]);
    const internalTargets = new Set(
      [...internalFiles].filter((file) => file !== "src/cli/args.ts"),
    );
    const violations: string[] = [];

    for (const file of sourceAndTestFiles()) {
      if (internalFiles.has(file)) {
        continue;
      }

      const source = readFileSync(file, "utf8");
      if (!source.includes("args/")) {
        continue;
      }

      for (const specifier of importSpecifiers(file, source)) {
        const resolved = resolvedRelativeSpecifier(file, specifier);
        if (resolved !== null && internalTargets.has(resolved)) {
          violations.push(`${file} imports ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  test(`provider configuration internals keep profile, diagnostics, fake demo, and resolver boundaries separate`, () => {
    const providerConfigSource = readFileSync(
      "src/cli/provider-config.ts",
      "utf8",
    );
    expect(
      namedReExportSpecifiers(
        "src/cli/provider-config.ts",
        providerConfigSource,
      ),
    ).toEqual([
      "./provider-diagnostics.ts",
      "./provider-resolver.ts",
      "./provider-selection.ts",
    ]);

    expect(providerConfigSource).not.toMatch(/export\s+\*/u);

    const profileSource = readFileSync("src/cli/provider-profiles.ts", "utf8");
    expect(profileSource).not.toMatch(
      /\bexport\s+const\s+PROVIDER_PROFILES\b/u,
    );
    const profileSpecifiers = importSpecifiers(
      "src/cli/provider-profiles.ts",
      profileSource,
    );
    expect(profileSpecifiers).toEqual(["../core/provider-id.ts"]);

    const selectionSpecifiers = importSpecifiers(
      "src/cli/provider-selection.ts",
      readFileSync("src/cli/provider-selection.ts", "utf8"),
    );
    expect(selectionSpecifiers).toEqual([
      "../core/provider-id.ts",
      "./provider-profiles.ts",
    ]);

    const diagnosticsSpecifiers = importSpecifiers(
      "src/cli/provider-diagnostics.ts",
      readFileSync("src/cli/provider-diagnostics.ts", "utf8"),
    );
    expect(diagnosticsSpecifiers).not.toContain("./provider-resolver.ts");
    expect(diagnosticsSpecifiers).not.toContain("./fake-provider-demo.ts");
    expect(
      diagnosticsSpecifiers.filter((specifier) =>
        specifier.includes("/llm/providers/"),
      ),
    ).toEqual([]);

    const fakeDemoSpecifiers = importSpecifiers(
      "src/cli/fake-provider-demo.ts",
      readFileSync("src/cli/fake-provider-demo.ts", "utf8"),
    );
    expect(fakeDemoSpecifiers).not.toContain("./provider-diagnostics.ts");
    expect(fakeDemoSpecifiers).not.toContain("./provider-resolver.ts");
    expect(
      fakeDemoSpecifiers.filter((specifier) =>
        /\/llm\/providers\/(?:deepseek|kimi|qwen)\.ts$/u.test(specifier),
      ),
    ).toEqual([]);

    const resolverSpecifiers = importSpecifiers(
      "src/cli/provider-resolver.ts",
      readFileSync("src/cli/provider-resolver.ts", "utf8"),
    );
    expect(resolverSpecifiers).toContain("./fake-provider-demo.ts");
    expect(resolverSpecifiers).toContain("../llm/providers/deepseek.ts");
    expect(resolverSpecifiers).toContain("../llm/providers/kimi.ts");
    expect(resolverSpecifiers).toContain("../llm/providers/qwen.ts");
  });

  test(`external modules import provider configuration through the facade`, () => {
    const internalFiles = new Set([
      "src/cli/fake-provider-demo.ts",
      "src/cli/provider-config.ts",
      "src/cli/provider-diagnostics.ts",
      "src/cli/provider-profiles.ts",
      "src/cli/provider-resolver.ts",
      "src/cli/provider-selection.ts",
    ]);
    const internalTargets = new Set(
      [...internalFiles].filter(
        (file) => file !== "src/cli/provider-config.ts",
      ),
    );
    const violations: string[] = [];

    for (const file of sourceAndTestFiles()) {
      if (internalFiles.has(file)) {
        continue;
      }

      const source = readFileSync(file, "utf8");
      if (!source.includes("provider-")) {
        continue;
      }

      for (const specifier of importSpecifiers(file, source)) {
        const resolved = resolvedRelativeSpecifier(file, specifier);
        if (resolved !== null && internalTargets.has(resolved)) {
          violations.push(`${file} imports ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
