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
const MCP_SDK_IMPORT = /^@modelcontextprotocol(?:\/|$)/u;

const providerConfigFacade = "src/cli/provider-config.ts";
const providerConfigOwnedFiles = [
  "src/cli/fake-provider-demo.ts",
  "src/cli/provider-diagnostics.ts",
  "src/cli/provider-profiles.ts",
  "src/cli/provider-resolver.ts",
  "src/cli/provider-selection.ts",
  "src/cli/provider-user-config.ts",
] as const;

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

function namedExports(file: string, source: string): readonly string[] {
  const sourceFile = parseSource(file, source);
  const names: string[] = [];

  function visit(node: ts.Node): void {
    if (
      ts.isExportDeclaration(node) &&
      node.exportClause !== undefined &&
      ts.isNamedExports(node.exportClause)
    ) {
      for (const element of node.exportClause.elements) {
        names.push(element.name.text);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return names;
}

function nonNamedExportStatements(
  file: string,
  source: string,
): readonly ts.Statement[] {
  return parseSource(file, source).statements.filter(
    (statement) =>
      !ts.isExportDeclaration(statement) ||
      statement.exportClause === undefined ||
      !ts.isNamedExports(statement.exportClause),
  );
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

describe("module boundaries", () => {
  for (const { layer, contract, forbidden } of layerRules) {
    test(`Given files in ${layer}/,
      When their imports are inspected,
      Then the layer ${contract}`, () => {
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

  test(`Given the MCP SDK is an external protocol implementation,
    When source imports are inspected,
    Then only the Keel-owned MCP adapter imports it`, () => {
    const violations: string[] = [];
    for (const file of sourceFiles()) {
      if (file.startsWith("src/mcp/")) continue;
      const source = readFileSync(file, "utf8");
      for (const specifier of importSpecifiers(file, source)) {
        if (MCP_SDK_IMPORT.test(specifier)) {
          violations.push(`${file} imports ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test(`Given the CLI entrypoint routes commands,
    When its provider dependencies are inspected,
    Then provider configuration remains behind its dedicated facade`, () => {
    const source = readFileSync("src/cli/index.ts", "utf8");
    const forbidden = importSpecifiers("src/cli/index.ts", source).filter(
      (specifier) =>
        specifier.includes("/llm/providers/") ||
        specifier === "../core/cost.ts",
    );

    expect(forbidden).toEqual([]);
  });

  test(`Given interactive compaction helpers restore visible context,
    When their dependencies are inspected,
    Then restoration remains owned by the dedicated post-compaction module`, () => {
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

  test(`Given visibility and restoration have dedicated owners,
    When the agent loop exports are inspected,
    Then the loop does not re-export those helpers`, () => {
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

  test(`Given agent events have a dedicated contract module,
    When source and test imports are inspected,
    Then consumers do not import event contracts from the agent loop`, () => {
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

  test(`Given agent event contracts have a dedicated owner,
    When the agent loop exports are inspected,
    Then the loop does not declare those contracts`, () => {
    const source = readFileSync("src/agent/loop.ts", "utf8");

    expect(source).not.toMatch(/\bexport\s+interface\s+CostReport\b/u);
    expect(source).not.toMatch(/\bexport\s+type\s+AgentEvent\b/u);
  });

  test(`Given provider turns own only model streaming,
    When provider-turn dependencies are inspected,
    Then ledger compaction and tool execution remain outside that boundary`, () => {
    const source = readFileSync("src/agent/provider-turn.ts", "utf8");
    const specifiers = importSpecifiers("src/agent/provider-turn.ts", source);

    expect(specifiers).not.toContain("./session-ledger.ts");
    expect(specifiers).not.toContain("./context-compaction.ts");
    expect(specifiers).not.toContain("../tools/registry.ts");
    expect(specifiers).not.toContain("../tools/execution.ts");
    expect(specifiers).not.toContain("./tool-scheduler.ts");
  });

  test(`Given turn compaction owns request recovery,
    When its dependencies are inspected,
    Then tool execution and bash policy remain outside that boundary`, () => {
    const source = readFileSync("src/agent/turn-compaction.ts", "utf8");
    const specifiers = importSpecifiers("src/agent/turn-compaction.ts", source);

    expect(specifiers).not.toContain("../tools/execution.ts");
    expect(specifiers).not.toContain("./tool-scheduler.ts");
    expect(specifiers).not.toContain("../permissions/bash.ts");
  });

  test(`Given LLM modules consume tool-call data,
    When their tool dependencies are inspected,
    Then they import only the stable tool-call contract`, () => {
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

  test(`Given session records validate persisted tool calls,
    When their tool dependencies are inspected,
    Then validation uses the stable tool-call contract`, () => {
    const file = "src/cli/session-store/records.ts";
    const source = readFileSync(file, "utf8");
    const specifiers = importSpecifiers(file, source);

    expect(specifiers).toContain("../../tools/tool-call.ts");
    expect(specifiers).not.toContain("../../tools/builtin.ts");
    expect(specifiers).not.toContain("../../tools/registry.ts");
  });

  test(`Given tool definitions own declarative metadata,
    When their dependencies and source are inspected,
    Then builtin executors remain outside the definition module`, () => {
    const file = "src/tools/tool-definitions.ts";
    const source = readFileSync(file, "utf8");
    const specifiers = importSpecifiers(file, source);

    expect(
      specifiers.filter((specifier) =>
        /^\.\/(?:apply-patch|bash|edit|git-diff|glob|grep|ls|read|write)\.ts$/u.test(
          specifier,
        ),
      ),
    ).toEqual([]);
    expect(source).not.toMatch(/\bexecute[A-Z]/u);
  });

  test(`Given source modules expose public contracts,
    When re-export declarations are inspected,
    Then wildcard re-exports are forbidden`, () => {
    const violations = sourceFiles().flatMap((file) =>
      wildcardReExportSpecifiers(file, readFileSync(file, "utf8")).map(
        (specifier) => `${file} re-exports wildcard from ${specifier}`,
      ),
    );

    expect(violations).toEqual([]);
  }, 15_000);

  test(`Given value and type wildcard export syntax,
    When the architecture detector parses each form,
    Then every wildcard form is reported`, () => {
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

  test(`Given source entrypoints have explicit ownership,
    When generic index modules are enumerated,
    Then only the executable CLI entrypoint exists`, () => {
    const indexFiles = sourceFiles().filter(
      (file) => file.endsWith("/index.ts") || file.endsWith("/index.tsx"),
    );

    expect(indexFiles).toEqual(["src/cli/index.ts"]);
  });

  test(`Given session-store internals have a public facade,
    When external imports are inspected,
    Then consumers do not bypass the session-store facade`, () => {
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

  test(`Given context-compaction internals have a public facade,
    When external imports are inspected,
    Then consumers do not bypass the context-compaction facade`, () => {
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

  test(`Given tool execution has domain-owned internals behind a public facade,
    When execution dependencies are inspected,
    Then consumers enter through the facade and internal ownership stays one-way`, () => {
    const facade = "src/tools/execution.ts";
    const internalRoot = "src/tools/execution/";
    const goalOwner = "src/tools/execution/goal.ts";
    const facadeSource = readFileSync(facade, "utf8");
    const facadeTargets = importSpecifiers(facade, facadeSource).flatMap(
      (specifier) => {
        const resolved = resolvedRelativeSpecifier(facade, specifier);
        return resolved?.startsWith(internalRoot) === true ? [resolved] : [];
      },
    );

    expect(facadeTargets).toContain(goalOwner);

    const violations: string[] = [];
    for (const file of sourceAndTestFiles()) {
      if (file === facade || file.startsWith(internalRoot)) {
        continue;
      }
      const source = readFileSync(file, "utf8");
      if (!source.includes("execution/")) {
        continue;
      }
      for (const specifier of importSpecifiers(file, source)) {
        const resolved = resolvedRelativeSpecifier(file, specifier);
        if (resolved?.startsWith(internalRoot) === true) {
          violations.push(`${file} imports ${specifier}`);
        }
      }
    }

    for (const file of layerFiles("src/tools/execution")) {
      for (const specifier of importSpecifiers(
        file,
        readFileSync(file, "utf8"),
      )) {
        if (resolvedRelativeSpecifier(file, specifier) === facade) {
          violations.push(`${file} imports execution facade ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  test(`Given apply-patch internals have a public facade,
    When external imports are inspected,
    Then consumers do not bypass the apply-patch facade`, () => {
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

  test(`Given MCP OAuth has independent credential, login, runtime-auth, and revocation owners,
    When facade and internal dependencies are inspected,
    Then consumers enter through the facade and OAuth flows do not depend on each other`, () => {
    const facade = "src/mcp/oauth.ts";
    const internalRoot = "src/mcp/oauth/";
    const credentialStore = "src/mcp/oauth/credential-store.ts";
    const flowFiles = new Set([
      "src/mcp/oauth/login-provider.ts",
      "src/mcp/oauth/runtime-auth.ts",
      "src/mcp/oauth/revocation.ts",
    ]);
    const internalFiles = layerFiles("src/mcp/oauth");
    const facadeSource = readFileSync(facade, "utf8");
    const facadeSpecifiers = importSpecifiers(facade, facadeSource);
    const facadeTargets = facadeSpecifiers.flatMap((specifier) => {
      const resolved = resolvedRelativeSpecifier(facade, specifier);
      return resolved?.startsWith(internalRoot) === true ? [resolved] : [];
    });
    expect(new Set(facadeTargets)).toEqual(
      new Set([credentialStore, ...flowFiles]),
    );
    expect(
      facadeSpecifiers.filter((specifier) => !specifier.startsWith("./oauth/")),
    ).toEqual([]);
    expect(nonNamedExportStatements(facade, facadeSource)).toEqual([]);
    expect(new Set(namedExports(facade, facadeSource))).toEqual(
      new Set([
        "McpOAuthServerEndpoint",
        "McpSecretBackend",
        "McpOAuthCredentialError",
        "McpOAuthServerUnavailableError",
        "McpOAuthLoginProvider",
        "McpPreRegisteredClient",
        "createMcpOAuthLoginProvider",
        "deleteMcpOAuthCredentials",
        "deleteMcpOAuthCredentialsUnderLock",
        "revokeAndDeleteMcpOAuthCredentialsUnderLock",
        "withMcpOAuthCredentialLock",
        "McpAuthorizationIdentity",
        "McpRuntimeAuthProvider",
        "createMcpBearerAuthProvider",
        "isMcpAuthenticationRequiredError",
        "McpOAuthAuthenticationRequiredError",
        "sameMcpAuthorizationIdentity",
      ]),
    );

    const violations: string[] = [];
    for (const file of sourceAndTestFiles()) {
      if (file === facade || file.startsWith(internalRoot)) {
        continue;
      }
      const source = readFileSync(file, "utf8");
      if (!source.includes("oauth/")) {
        continue;
      }
      for (const specifier of importSpecifiers(file, source)) {
        const resolved = resolvedRelativeSpecifier(file, specifier);
        if (resolved?.startsWith(internalRoot) === true) {
          violations.push(`${file} imports ${specifier}`);
        }
      }
    }

    for (const file of internalFiles) {
      for (const specifier of importSpecifiers(
        file,
        readFileSync(file, "utf8"),
      )) {
        const resolved = resolvedRelativeSpecifier(file, specifier);
        if (resolved === facade) {
          violations.push(`${file} imports OAuth facade ${specifier}`);
        }
        if (
          resolved?.startsWith(internalRoot) === true &&
          !(flowFiles.has(file) && resolved === credentialStore)
        ) {
          violations.push(`${file} imports forbidden OAuth owner ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  test(`Given the OAuth facade permits only explicit named re-exports,
    When direct exported declarations are inspected,
    Then the architecture detector rejects every direct declaration form`, () => {
    const directExports = nonNamedExportStatements(
      "inline.ts",
      `export const value = 1;
       export function operation(): void {}
       export interface Contract { readonly value: number; }`,
    );
    const namedReExports = nonNamedExportStatements(
      "inline.ts",
      `export { value } from "./value.ts";
       export type { Contract } from "./contract.ts";`,
    );

    expect(directExports).toHaveLength(3);
    expect(namedReExports).toEqual([]);
  });

  test(`Given CLI command parsers share common argument contracts,
    When facade and internal dependencies are inspected,
    Then parser ownership remains behind the args boundary`, () => {
    const facadeSource = readFileSync("src/cli/args.ts", "utf8");
    const facadeSpecifiers = importSpecifiers("src/cli/args.ts", facadeSource);
    expect(facadeSpecifiers).not.toContain("zod");
    expect(facadeSpecifiers).not.toContain("node:path");
    expect(facadeSpecifiers).not.toContain("../core/provider-id.ts");
    expect(facadeSpecifiers).not.toContain("../permissions/bash.ts");

    const internalFiles = layerFiles("src/cli/args");
    const sharedTargets = new Set([
      "src/cli/args/shared.ts",
      "src/cli/args/types.ts",
    ]);
    const violations = internalFiles.flatMap((file) =>
      importSpecifiers(file, readFileSync(file, "utf8")).flatMap(
        (specifier) => {
          const resolved = resolvedRelativeSpecifier(file, specifier);
          return resolved?.startsWith("src/cli/args/") === true &&
            !sharedTargets.has(resolved)
            ? [`${file} imports ${specifier}`]
            : [];
        },
      ),
    );

    expect(violations).toEqual([]);
  });

  test(`Given CLI args internals have a public facade,
    When external imports are inspected,
    Then consumers do not bypass the args facade`, () => {
    const internalTargets = new Set(layerFiles("src/cli/args"));
    const internalFiles = new Set(["src/cli/args.ts", ...internalTargets]);
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

  test(`Given provider configuration modules have distinct responsibilities,
    When their dependency edges are inspected,
    Then profiles, selection, diagnostics, demos, and resolution remain separate`, () => {
    const profileFile = "src/cli/provider-profiles.ts";
    const selectionFile = "src/cli/provider-selection.ts";
    const diagnosticsFile = "src/cli/provider-diagnostics.ts";
    const resolverFile = "src/cli/provider-resolver.ts";
    const fakeDemoFile = "src/cli/fake-provider-demo.ts";
    const profileSource = readFileSync(profileFile, "utf8");
    expect(profileSource).not.toMatch(
      /\bexport\s+const\s+PROVIDER_PROFILES\b/u,
    );
    const internalTargets = new Set<string>([
      providerConfigFacade,
      ...providerConfigOwnedFiles,
    ]);
    const forbiddenSiblingTargets = new Map<string, ReadonlySet<string>>([
      [
        profileFile,
        new Set([...internalTargets].filter((file) => file !== profileFile)),
      ],
      [selectionFile, new Set([resolverFile, diagnosticsFile, fakeDemoFile])],
      [diagnosticsFile, new Set([resolverFile, fakeDemoFile])],
      [fakeDemoFile, new Set([resolverFile, diagnosticsFile])],
    ]);
    const dependencyViolations = providerConfigOwnedFiles.flatMap((file) =>
      importSpecifiers(file, readFileSync(file, "utf8")).flatMap(
        (specifier) => {
          const resolved = resolvedRelativeSpecifier(file, specifier);
          if (
            resolved !== null &&
            internalTargets.has(resolved) &&
            forbiddenSiblingTargets.get(file)?.has(resolved) === true
          ) {
            return [`${file} imports ${specifier}`];
          }

          return [];
        },
      ),
    );
    const providerImplementationViolations = layerFiles("src/cli").flatMap(
      (file) =>
        importSpecifiers(file, readFileSync(file, "utf8")).flatMap(
          (specifier) => {
            const resolved = resolvedRelativeSpecifier(file, specifier);
            if (resolved?.startsWith("src/llm/providers/") !== true) {
              return [];
            }

            const importsOwnedFakeProvider =
              file === fakeDemoFile && resolved === "src/llm/providers/fake.ts";
            const importsRealProviderFromResolver =
              file === resolverFile && resolved !== "src/llm/providers/fake.ts";
            return importsOwnedFakeProvider || importsRealProviderFromResolver
              ? []
              : [`${file} imports ${specifier}`];
          },
        ),
    );

    expect(dependencyViolations).toEqual([]);
    expect(providerImplementationViolations).toEqual([]);
  });

  test(`Given provider configuration internals have a public facade,
    When external imports are inspected,
    Then consumers do not bypass the provider-config facade`, () => {
    const internalTargets = new Set<string>(providerConfigOwnedFiles);
    const internalFiles = new Set([providerConfigFacade, ...internalTargets]);
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
  }, 15_000);
});
