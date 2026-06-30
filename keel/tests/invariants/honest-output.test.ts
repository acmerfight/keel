import { existsSync } from "node:fs";
import ts from "typescript";
import { describe, expect, test } from "vitest";
import {
  type ActiveTestEvidence,
  collectTypeScriptFiles,
  importedBindings,
  location,
  type ParsedSource,
  parseSource,
  parseSourceText,
  sourceHasActiveTestEvidence,
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
  readonly evidence: ActiveTestEvidence;
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
        evidence: {
          bodyStrings: [],
          testEachValues: [49],
          expectations: [
            {
              matcher: "toHaveLength",
              argument: { kind: "identifier", name: "fileCount" },
              negated: false,
            },
            {
              matcher: "toContain",
              argument: { kind: "literal", value: "[glob output truncated" },
              negated: true,
            },
          ],
        },
      },
      {
        case: "exact",
        testPath: "tests/tools/glob.test.ts",
        evidence: {
          bodyStrings: [],
          testEachValues: [50],
          expectations: [
            {
              matcher: "toHaveLength",
              argument: { kind: "identifier", name: "fileCount" },
              negated: false,
            },
            {
              matcher: "toContain",
              argument: { kind: "literal", value: "[glob output truncated" },
              negated: true,
            },
          ],
        },
      },
      {
        case: "overflow",
        testPath: "tests/tools/glob.test.ts",
        evidence: {
          bodyStrings: [],
          testEachValues: [],
          expectations: [
            {
              matcher: "toBe",
              argument: {
                kind: "literal",
                value:
                  "[glob output truncated: showing first 50 files. Narrow the pattern or path to see more.]",
              },
              negated: false,
            },
          ],
        },
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
        evidence: {
          bodyStrings: [],
          testEachValues: [49],
          expectations: [
            {
              matcher: "toHaveLength",
              argument: { kind: "identifier", name: "fileCount" },
              negated: false,
            },
            {
              matcher: "toContain",
              argument: { kind: "literal", value: "[grep output truncated" },
              negated: true,
            },
          ],
        },
      },
      {
        case: "exact",
        testPath: "tests/tools/grep.test.ts",
        evidence: {
          bodyStrings: [],
          testEachValues: [50],
          expectations: [
            {
              matcher: "toHaveLength",
              argument: { kind: "identifier", name: "fileCount" },
              negated: false,
            },
            {
              matcher: "toContain",
              argument: { kind: "literal", value: "[grep output truncated" },
              negated: true,
            },
          ],
        },
      },
      {
        case: "overflow",
        testPath: "tests/tools/grep.test.ts",
        evidence: {
          bodyStrings: [],
          testEachValues: [],
          expectations: [
            {
              matcher: "toBe",
              argument: {
                kind: "literal",
                value: "[grep output truncated: showing first 50 matches]",
              },
              negated: false,
            },
          ],
        },
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
        evidence: {
          bodyStrings: [],
          testEachValues: [],
          expectations: [
            {
              matcher: "toBe",
              argument: { kind: "containsString", value: "case-1.ts" },
              negated: false,
            },
            {
              matcher: "toContain",
              argument: { kind: "literal", value: "[ls output truncated" },
              negated: true,
            },
          ],
        },
      },
      {
        case: "exact",
        testPath: "tests/tools/ls.test.ts",
        evidence: {
          bodyStrings: [],
          testEachValues: [],
          expectations: [
            {
              matcher: "toBe",
              argument: { kind: "containsString", value: "case-2.ts" },
              negated: false,
            },
            {
              matcher: "toContain",
              argument: { kind: "literal", value: "[ls output truncated" },
              negated: true,
            },
          ],
        },
      },
      {
        case: "overflow",
        testPath: "tests/tools/ls.test.ts",
        evidence: {
          bodyStrings: [],
          testEachValues: [],
          expectations: [
            {
              matcher: "toBe",
              argument: {
                kind: "containsString",
                value:
                  "[ls output truncated: showing first 3 entries. Narrow the path or increase limit to see more.]",
              },
              negated: false,
            },
          ],
        },
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
        evidence: {
          bodyStrings: [],
          testEachValues: [],
          expectations: [
            {
              matcher: "toContain",
              argument: { kind: "literal", value: "stdout:\nout\n" },
              negated: false,
            },
          ],
        },
      },
      {
        case: "exact",
        testPath: "tests/tools/bash.test.ts",
        evidence: {
          bodyStrings: ["Exit code: 0\n\nstdout:\n"],
          testEachValues: [],
          expectations: [
            {
              matcher: "toContain",
              argument: { kind: "literal", value: "[bash stdout truncated" },
              negated: true,
            },
          ],
        },
      },
      {
        case: "overflow",
        testPath: "tests/tools/bash.test.ts",
        evidence: {
          bodyStrings: [],
          testEachValues: [],
          expectations: [
            {
              matcher: "toContain",
              argument: {
                kind: "literal",
                value: "[bash stdout truncated: showing last 20000 bytes]",
              },
              negated: false,
            },
          ],
        },
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
        evidence: {
          bodyStrings: [],
          testEachValues: [],
          expectations: [
            {
              matcher: "toContain",
              argument: { kind: "literal", value: "+untracked" },
              negated: false,
            },
          ],
        },
      },
      {
        case: "exact",
        testPath: "tests/tools/git-diff.test.ts",
        evidence: {
          bodyStrings: [],
          testEachValues: [],
          expectations: [
            {
              matcher: "toContain",
              argument: { kind: "literal", value: "untracked-49.txt" },
              negated: false,
            },
            {
              matcher: "toContain",
              argument: {
                kind: "literal",
                value: "[git_diff output truncated",
              },
              negated: true,
            },
          ],
        },
      },
      {
        case: "overflow",
        testPath: "tests/tools/git-diff.test.ts",
        evidence: {
          bodyStrings: [],
          testEachValues: [],
          expectations: [
            {
              matcher: "toContain",
              argument: {
                kind: "literal",
                value:
                  "[git_diff output truncated: showing first 50 untracked files.",
              },
              negated: false,
            },
          ],
        },
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

// This catches reviewable output-cap slices assigned to display-named variables;
// broader slice misuse belongs in behavior tests or focused source ownership rules.
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
        `${decision} hand-rolls a named display cap outside output-limit.ts`,
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

function assertEvidenceExists(
  evidence: BoundaryEvidence,
  parsedSources: Map<string, ParsedSource>,
): void {
  let source = parsedSources.get(evidence.testPath);
  if (source === undefined) {
    source = parseSource(evidence.testPath);
    parsedSources.set(evidence.testPath, source);
  }
  expect(
    sourceHasActiveTestEvidence(source, evidence.evidence),
    `${evidence.testPath} missing active ${evidence.case} boundary evidence`,
  ).toBe(true);
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

  test(`Given a tool imports output-limit but still hand-rolls a named capped visible list,
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
      "src/tools/example.ts:4:9 visibleFiles hand-rolls a named display cap outside output-limit.ts",
    ]);
  });

  test(`Given limited-output evidence appears only in skipped tests and comments,
    When the boundary matrix inspects executable evidence,
    Then inactive evidence does not satisfy the matrix`, () => {
    const source = parseSourceText(
      "tests/tools/glob.test.ts",
      [
        'import { expect, test } from "vitest";',
        "test.skip('inactive evidence', () => {",
        "  const fileCount = 50;",
        "  const lines = [];",
        "  expect(lines).toHaveLength(fileCount);",
        "});",
        "test('active without evidence', () => {",
        "  // expect(lines).toHaveLength(fileCount)",
        '  expect("other").toBe("other");',
        "});",
      ].join("\n"),
    );
    const evidence = {
      bodyStrings: [],
      testEachValues: [],
      expectations: [
        {
          matcher: "toHaveLength",
          argument: { kind: "identifier", name: "fileCount" },
          negated: false,
        },
      ],
    } satisfies ActiveTestEvidence;

    expect(sourceHasActiveTestEvidence(source, evidence)).toBe(false);
  });

  test(`Given executable evidence uses supported active test shapes,
    When the boundary matrix inspects test bodies,
    Then direct tests and parameterized tests are matched by their assertions`, () => {
    const source = parseSourceText(
      "tests/tools/example.test.ts",
      [
        'import { expect, test } from "vitest";',
        "test('missing callback');",
        "test.each([1])('missing parameterized callback');",
        "test('function expression body', function () {",
        '  expect("alpha").toBe("alpha");',
        "});",
        "test.each()('empty parameter table', () => {",
        '  expect("beta").toBe("beta");',
        "});",
      ].join("\n"),
    );

    expect(
      sourceHasActiveTestEvidence(source, {
        bodyStrings: [],
        testEachValues: [],
        expectations: [
          {
            matcher: "toBe",
            argument: { kind: "literal", value: "alpha" },
            negated: false,
          },
        ],
      }),
    ).toBe(true);
    expect(
      sourceHasActiveTestEvidence(source, {
        bodyStrings: [],
        testEachValues: [],
        expectations: [
          {
            matcher: "toBe",
            argument: { kind: "literal", value: "beta" },
            negated: false,
          },
        ],
      }),
    ).toBe(true);
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

    const parsedSources = new Map<string, ParsedSource>();
    for (const entry of limitedOutputBoundaryMatrix) {
      expect(entry.evidence.map((evidence) => evidence.case)).toEqual(
        boundaryCases,
      );
      expect(existsSync(entry.sourcePath)).toBe(true);
      for (const evidence of entry.evidence) {
        expect(existsSync(evidence.testPath)).toBe(true);
        assertEvidenceExists(evidence, parsedSources);
      }
    }
  });
});
