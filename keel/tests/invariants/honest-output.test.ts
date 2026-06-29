import { existsSync, readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, test } from "vitest";
import {
  collectTypeScriptFiles,
  importedBindings,
  location,
  type ParsedSource,
  parseSource,
  parseSourceText,
} from "./_ast.ts";

type BoundaryCase = "under" | "exact" | "overflow";

interface LimitedOutputBoundaryMatrixEntry {
  readonly tool: string;
  readonly sourcePath: string;
  readonly evidence: readonly BoundaryEvidence[];
}

interface BoundaryEvidence {
  readonly case: BoundaryCase;
  readonly testPath: string;
  readonly snippets: readonly string[];
}

const boundaryCases: readonly BoundaryCase[] = ["under", "exact", "overflow"];
const limitedOutputBoundaryMatrix = [
  {
    tool: "glob",
    sourcePath: "src/tools/glob.ts",
    evidence: [
      {
        case: "under",
        testPath: "tests/tools/glob.test.ts",
        snippets: [
          "test.each([49, 50])",
          'expect(result.content).not.toContain("[glob output truncated")',
        ],
      },
      {
        case: "exact",
        testPath: "tests/tools/glob.test.ts",
        snippets: [
          "test.each([49, 50])",
          "expect(lines).toHaveLength(fileCount)",
        ],
      },
      {
        case: "overflow",
        testPath: "tests/tools/glob.test.ts",
        snippets: [
          '"[glob output truncated: showing first 50 files. Narrow the pattern or path to see more.]"',
        ],
      },
    ],
  },
  {
    tool: "grep",
    sourcePath: "src/tools/grep.ts",
    evidence: [
      {
        case: "under",
        testPath: "tests/tools/grep.test.ts",
        snippets: [
          "test.each([49, 50])",
          'expect(result.content).not.toContain("[grep output truncated")',
        ],
      },
      {
        case: "exact",
        testPath: "tests/tools/grep.test.ts",
        snippets: [
          "test.each([49, 50])",
          "expect(lines).toHaveLength(fileCount)",
        ],
      },
      {
        case: "overflow",
        testPath: "tests/tools/grep.test.ts",
        snippets: ['"[grep output truncated: showing first 50 matches]"'],
      },
    ],
  },
  {
    tool: "ls",
    sourcePath: "src/tools/ls.ts",
    evidence: [
      {
        case: "under",
        testPath: "tests/tools/ls.test.ts",
        snippets: [
          "Given a directory has fewer entries than requested",
          'expect(result.content).not.toContain("[ls output truncated")',
        ],
      },
      {
        case: "exact",
        testPath: "tests/tools/ls.test.ts",
        snippets: [
          "Given a directory has exactly as many entries as requested",
          'expect(result.content).not.toContain("[ls output truncated")',
        ],
      },
      {
        case: "overflow",
        testPath: "tests/tools/ls.test.ts",
        snippets: [
          '"[ls output truncated: showing first 3 entries. Narrow the path or increase limit to see more.]"',
        ],
      },
    ],
  },
  {
    tool: "bash",
    sourcePath: "src/tools/bash.ts",
    evidence: [
      {
        case: "under",
        testPath: "tests/tools/bash.test.ts",
        snippets: [
          "Given a workspace command writes to stdout and stderr",
          'expect(result.content).toContain("stdout:\\nout\\n")',
        ],
      },
      {
        case: "exact",
        testPath: "tests/tools/bash.test.ts",
        snippets: [
          "Given a workspace command produces exactly the output budget",
          'expect(result.content).not.toContain("[bash stdout truncated")',
        ],
      },
      {
        case: "overflow",
        testPath: "tests/tools/bash.test.ts",
        snippets: ['"[bash stdout truncated: showing last 20000 bytes]"'],
      },
    ],
  },
  {
    tool: "git_diff",
    sourcePath: "src/tools/git-diff.ts",
    evidence: [
      {
        case: "under",
        testPath: "tests/tools/git-diff.test.ts",
        snippets: [
          "Given staged unstaged and untracked changes",
          'expect(result.content).toContain("+untracked")',
        ],
      },
      {
        case: "exact",
        testPath: "tests/tools/git-diff.test.ts",
        snippets: [
          "Given the untracked file list exactly reaches the display limit",
          'expect(result.content).not.toContain("[git_diff output truncated")',
        ],
      },
      {
        case: "overflow",
        testPath: "tests/tools/git-diff.test.ts",
        snippets: [
          '"[git_diff output truncated: showing first 50 untracked files.',
        ],
      },
    ],
  },
] satisfies readonly LimitedOutputBoundaryMatrixEntry[];

const nonDiscardingTruncationEmitters = new Map([
  [
    "src/tools/read.ts",
    "read stops before appending over-budget content instead of discarding a capped suffix/prefix",
  ],
]);

function sourceFilesUnderTools(): readonly ParsedSource[] {
  return collectTypeScriptFiles("src/tools").map(parseSource);
}

function staticTextFragments(source: ParsedSource): readonly string[] {
  const fragments: string[] = [];

  function visit(node: ts.Node): void {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      fragments.push(node.text);
    }
    if (ts.isTemplateExpression(node)) {
      fragments.push(
        [
          node.head.text,
          ...node.templateSpans.map((span) => span.literal.text),
        ].join("<expression>"),
      );
    }
    ts.forEachChild(node, visit);
  }

  visit(source.sourceFile);
  return fragments;
}

function emitsTruncationMarker(source: ParsedSource): boolean {
  return staticTextFragments(source).some((text) =>
    /\[[^\]\n]*(?:output|stdout|stderr)? truncated/u.test(text),
  );
}

function importsOutputLimit(source: ParsedSource): boolean {
  return importedBindings(source).some(
    (binding) => binding.moduleSpecifier === "./output-limit.ts",
  );
}

function isZeroLiteral(node: ts.Expression | undefined): boolean {
  return node !== undefined && ts.isNumericLiteral(node) && node.text === "0";
}

function isManualCapVariableName(node: ts.BindingName): boolean {
  return (
    ts.isIdentifier(node) &&
    /^(?:visible|limited|capped|shown|display)/iu.test(node.text)
  );
}

function isSliceCall(node: ts.Expression): boolean {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "slice" &&
    isZeroLiteral(node.arguments[0]) &&
    node.arguments[1] !== undefined
  );
}

function manualTruncationDecisions(source: ParsedSource): readonly string[] {
  const decisions: string[] = [];

  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      isManualCapVariableName(node.name) &&
      node.initializer !== undefined &&
      isSliceCall(node.initializer)
    ) {
      decisions.push(
        `${location(source, node)} ${node.name.getText(source.sourceFile)}`,
      );
    }
    ts.forEachChild(node, visit);
  }

  visit(source.sourceFile);
  return decisions;
}

function truncationAccountantViolations(
  sources: readonly ParsedSource[],
): readonly string[] {
  const violations: string[] = [];
  for (const source of sources) {
    if (!emitsTruncationMarker(source)) continue;
    const manualDecisions = manualTruncationDecisions(source);
    for (const decision of manualDecisions) {
      violations.push(
        `${decision} hand-rolls a truncation cap outside output-limit.ts`,
      );
    }
    if (importsOutputLimit(source)) continue;
    if (nonDiscardingTruncationEmitters.has(source.path)) continue;
    violations.push(
      `${source.path} emits a truncation marker without output-limit.ts`,
    );
  }
  return violations;
}

function outputLimitSourcePaths(
  sources: readonly ParsedSource[],
): readonly string[] {
  return sources
    .filter((source) => importsOutputLimit(source))
    .map((source) => source.path)
    .filter((path) => path !== "src/tools/output-limit.ts")
    .sort();
}

function assertEvidenceExists(evidence: BoundaryEvidence): void {
  const text = readFileSync(evidence.testPath, "utf8");
  for (const snippet of evidence.snippets) {
    expect(
      text,
      `${evidence.testPath} missing ${evidence.case} boundary evidence snippet: ${snippet}`,
    ).toContain(snippet);
  }
}

describe("honest limited-output invariants", () => {
  test(`Given a tool emits a string-literal truncation marker without the shared accountant,
    When truncation output syntax is inspected,
    Then the invariant reports the missing accountant`, () => {
    // Given
    const source = parseSourceText(
      "src/tools/example.ts",
      `export function run(): string { return "[example output truncated]"; }`,
    );

    // When / Then
    expect(truncationAccountantViolations([source])).toEqual([
      "src/tools/example.ts emits a truncation marker without output-limit.ts",
    ]);
  });

  test(`Given a tool emits a template-literal truncation marker without the shared accountant,
    When truncation output syntax is inspected,
    Then the invariant reports the missing accountant`, () => {
    // Given
    const source = parseSourceText(
      "src/tools/example.ts",
      "export function run(label: string): string { return `[example $" +
        "{label} truncated]`; }",
    );

    // When / Then
    expect(truncationAccountantViolations([source])).toEqual([
      "src/tools/example.ts emits a truncation marker without output-limit.ts",
    ]);
  });

  test(`Given a tool imports output-limit but still hand-rolls a capped visible list,
    When truncation output syntax is inspected,
    Then the invariant reports the manual cap instead of accepting the import alone`, () => {
    // Given
    const source = parseSourceText(
      "src/tools/example.ts",
      [
        'import { CountOutputLimit } from "./output-limit.ts";',
        "const LIMIT = 50;",
        "export function run(files: readonly string[]): string {",
        "  const visibleFiles = files.slice(0, LIMIT);",
        '  return visibleFiles.length === files.length ? "" : "[example output truncated]";',
        "}",
      ].join("\n"),
    );

    // When / Then
    expect(truncationAccountantViolations([source])).toEqual([
      "src/tools/example.ts:4:9 visibleFiles hand-rolls a truncation cap outside output-limit.ts",
    ]);
  });

  test(`Given tool output can tell the model content was truncated,
    When tool source syntax is inspected,
    Then discard/cap truncation emitters use the shared output accountant`, () => {
    expect(truncationAccountantViolations(sourceFilesUnderTools())).toEqual([]);
  });

  test(`Given discard/cap limited-output tools need boundary coverage,
    When the limited-output registry is inspected,
    Then every shared-accountant tool has under, exact, and overflow evidence`, () => {
    const registeredPaths = limitedOutputBoundaryMatrix
      .map((entry) => entry.sourcePath)
      .sort();

    expect(registeredPaths).toEqual(
      outputLimitSourcePaths(sourceFilesUnderTools()),
    );
    expect(registeredPaths).not.toContain("src/tools/read.ts");

    for (const entry of limitedOutputBoundaryMatrix) {
      expect(entry.evidence.map((evidence) => evidence.case)).toEqual(
        boundaryCases,
      );
      expect(existsSync(entry.sourcePath)).toBe(true);
      for (const evidence of entry.evidence) {
        expect(existsSync(evidence.testPath)).toBe(true);
        assertEvidenceExists(evidence);
      }
    }
  });
});
