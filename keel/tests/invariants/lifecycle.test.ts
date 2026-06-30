import ts from "typescript";
import { describe, expect, test } from "vitest";
import {
  type ActiveTestEvidence,
  collectTypeScriptFiles,
  importedBindings,
  type ParsedSource,
  parseSource,
  parseSourceText,
  sourceHasActiveTestEvidence,
  stringLiteralValue,
} from "./_ast.ts";

type ProcessLifecycle = "exit-drain" | "close-settle";
type ProcessLifecycleEvent = "exit" | "close";

interface ProcessLifecycleEntry {
  readonly tool: string;
  readonly sourcePath: string;
  readonly lifecycle: ProcessLifecycle;
}

interface MultiFileMutatorEntry {
  readonly tool: string;
  readonly source: ParsedSource;
  readonly rollbackModule: string;
}

interface BehavioralLifecycleEntry {
  readonly behavior: string;
  readonly evidence: readonly BehavioralEvidence[];
}

interface BehavioralEvidence {
  readonly testPath: string;
  readonly evidence: ActiveTestEvidence;
}

const applyPatchSource = parseSource("src/tools/apply-patch.ts");

const processLifecycleCatalog = [
  {
    tool: "bash",
    sourcePath: "src/tools/bash.ts",
    lifecycle: "exit-drain",
  },
  {
    tool: "git_diff",
    sourcePath: "src/tools/git-diff.ts",
    lifecycle: "close-settle",
  },
  {
    tool: "ripgrep",
    sourcePath: "src/tools/ripgrep-process.ts",
    lifecycle: "close-settle",
  },
] satisfies readonly ProcessLifecycleEntry[];

const multiFileMutatorCatalog = [
  {
    tool: "apply_patch",
    source: applyPatchSource,
    rollbackModule: "./apply-patch/rollback.ts",
  },
] satisfies readonly MultiFileMutatorEntry[];

const statefulBehaviorCatalog = [
  {
    behavior: "active session identity mismatch fails closed",
    evidence: [
      {
        testPath: "tests/cli/main/session-errors.test.ts",
        evidence: {
          bodyStrings: [],
          testEachValues: [],
          expectations: [
            {
              matcher: "toBe",
              argument: {
                kind: "literal",
                value:
                  'Error: session "active" is already active. Stop the other Keel process before using it again.\n',
              },
              negated: false,
            },
          ],
        },
      },
    ],
  },
  {
    behavior: "resume replays admitted queued input truthfully",
    evidence: [
      {
        testPath: "tests/cli/main/session-errors.test.ts",
        evidence: {
          bodyStrings: ["snapshot-question"],
          testEachValues: [],
          expectations: [
            {
              matcher: "toBe",
              argument: {
                kind: "literal",
                value: "Earlier you said: remember alpha\n",
              },
              negated: false,
            },
            {
              matcher: "toContain",
              argument: {
                kind: "literal",
                value: '"consumedInputIds":["snapshot-question"]',
              },
              negated: false,
            },
          ],
        },
      },
    ],
  },
  {
    behavior: "forked sessions do not copy source pending queued input",
    evidence: [
      {
        testPath: "tests/cli/main/session-fork.test.ts",
        evidence: {
          bodyStrings: ["remember alpha"],
          testEachValues: [],
          expectations: [
            {
              matcher: "toContain",
              argument: { kind: "literal", value: "remember beta" },
              negated: true,
            },
          ],
        },
      },
    ],
  },
  {
    behavior: "workflow skill identity persists and resumes truthfully",
    evidence: [
      {
        testPath: "tests/cli/main/skills-command.test.ts",
        evidence: {
          bodyStrings: [],
          testEachValues: [],
          expectations: [
            {
              matcher: "toContain",
              argument: {
                kind: "literal",
                value: "> Original review workflow body.",
              },
              negated: false,
            },
            {
              matcher: "toContain",
              argument: {
                kind: "literal",
                value: "Changed review workflow body.",
              },
              negated: true,
            },
          ],
        },
      },
    ],
  },
] satisfies readonly BehavioralLifecycleEntry[];

function importsSpawn(source: ParsedSource): boolean {
  return importedBindings(source).some(
    (binding) =>
      binding.name === "spawn" &&
      /^(?:node:)?child_process$/u.test(binding.moduleSpecifier),
  );
}

function callsIdentifier(source: ParsedSource, name: string): boolean {
  let found = false;

  function visit(node: ts.Node): void {
    if (
      !found &&
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(source.sourceFile);
  return found;
}

function sourceMap(
  sources: readonly ParsedSource[],
): ReadonlyMap<string, ParsedSource> {
  return new Map(sources.map((source) => [source.path, source]));
}

function sourceForPath(
  path: string,
  sources: ReadonlyMap<string, ParsedSource>,
): ParsedSource {
  return sources.get(path) ?? parseSource(path);
}

function toolSpawnSourcePaths(
  sources: readonly ParsedSource[] = collectTypeScriptFiles("src/tools").map(
    parseSource,
  ),
): readonly string[] {
  return sources
    .filter(
      (source) => importsSpawn(source) && callsIdentifier(source, "spawn"),
    )
    .map((source) => source.path)
    .sort();
}

function childProcessLifecycleEvents(
  source: ParsedSource,
): ReadonlySet<ProcessLifecycleEvent> {
  const events: ProcessLifecycleEvent[] = [];

  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      (node.expression.name.text === "on" ||
        node.expression.name.text === "once") &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "child"
    ) {
      const eventName = node.arguments[0];
      const event =
        eventName === undefined ? null : stringLiteralValue(eventName);
      if (event === "exit" || event === "close") {
        events.push(event);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(source.sourceFile);
  return new Set(events);
}

function lifecycleEventViolations(
  entry: ProcessLifecycleEntry,
  source: ParsedSource,
): readonly string[] {
  const events = childProcessLifecycleEvents(source);
  const violations: string[] = [];

  if (entry.lifecycle === "exit-drain") {
    if (!events.has("exit")) {
      violations.push(
        `${entry.sourcePath} ${entry.tool} must listen for child process exit`,
      );
    }
    if (events.has("close")) {
      violations.push(
        `${entry.sourcePath} ${entry.tool} must not settle from child process close`,
      );
    }
    return violations;
  }

  if (!events.has("close")) {
    violations.push(
      `${entry.sourcePath} ${entry.tool} must listen for child process close`,
    );
  }
  if (events.has("exit")) {
    violations.push(
      `${entry.sourcePath} ${entry.tool} must not use child process exit lifecycle`,
    );
  }
  return violations;
}

function processLifecycleViolations(
  entries: readonly ProcessLifecycleEntry[] = processLifecycleCatalog,
  sources: readonly ParsedSource[] = collectTypeScriptFiles("src/tools").map(
    parseSource,
  ),
): readonly string[] {
  const violations: string[] = [];
  const catalogPaths = new Set(entries.map((entry) => entry.sourcePath));
  const sourcesByPath = sourceMap(sources);

  for (const sourcePath of toolSpawnSourcePaths(sources)) {
    if (!catalogPaths.has(sourcePath)) {
      violations.push(`${sourcePath} spawn site must be in lifecycle catalog`);
    }
  }

  for (const entry of entries) {
    violations.push(
      ...lifecycleEventViolations(
        entry,
        sourceForPath(entry.sourcePath, sourcesByPath),
      ),
    );
  }
  return violations;
}

function importsRollbackSurface(entry: MultiFileMutatorEntry): boolean {
  return importedBindings(entry.source).some(
    (binding) =>
      binding.moduleSpecifier === entry.rollbackModule &&
      binding.name === "applyWithRollback",
  );
}

function importsBatchCheckpointRecorder(source: ParsedSource): boolean {
  return importedBindings(source).some(
    (binding) =>
      binding.moduleSpecifier === "../core/git.ts" &&
      binding.name === "recordLastBatchCheckpoint",
  );
}

function batchCheckpointMutatorSourcePaths(
  sources: readonly ParsedSource[] = collectTypeScriptFiles("src/tools").map(
    parseSource,
  ),
): readonly string[] {
  return sources
    .filter((source) => importsBatchCheckpointRecorder(source))
    .map((source) => source.path)
    .sort();
}

function multiFileMutatorViolations(
  entries: readonly MultiFileMutatorEntry[] = multiFileMutatorCatalog,
  sources: readonly ParsedSource[] = collectTypeScriptFiles("src/tools").map(
    parseSource,
  ),
): readonly string[] {
  const violations: string[] = [];
  const catalogPaths = new Set(entries.map((entry) => entry.source.path));

  for (const sourcePath of batchCheckpointMutatorSourcePaths(sources)) {
    if (!catalogPaths.has(sourcePath)) {
      violations.push(
        `${sourcePath} batch checkpoint mutator must be in multi-file mutator catalog`,
      );
    }
  }

  for (const entry of entries) {
    if (!importsRollbackSurface(entry)) {
      violations.push(
        `${entry.source.path} ${entry.tool} must import applyWithRollback from ${entry.rollbackModule}`,
      );
    }
    if (!callsIdentifier(entry.source, "applyWithRollback")) {
      violations.push(
        `${entry.source.path} ${entry.tool} must call applyWithRollback`,
      );
    }
  }
  return violations;
}

function behavioralLifecycleViolations(
  entries: readonly BehavioralLifecycleEntry[] = statefulBehaviorCatalog,
  sourceOverrides: ReadonlyMap<string, ParsedSource> = new Map(),
): readonly string[] {
  const violations: string[] = [];
  const parsedSources = new Map(sourceOverrides);
  for (const entry of entries) {
    for (const evidence of entry.evidence) {
      let source = parsedSources.get(evidence.testPath);
      if (source === undefined) {
        source = parseSource(evidence.testPath);
        parsedSources.set(evidence.testPath, source);
      }
      if (!sourceHasActiveTestEvidence(source, evidence.evidence)) {
        violations.push(
          `${entry.behavior} evidence missing from ${evidence.testPath}`,
        );
      }
    }
  }
  return violations;
}

describe("lifecycle invariants", () => {
  test(`Given a tool spawn site is not in the lifecycle catalog,
    When lifecycle invariants inspect tool sources,
    Then they report the missing catalog entry`, () => {
    const sources = [
      parseSourceText(
        "src/tools/custom-process.ts",
        [
          'import { spawn } from "node:child_process";',
          "export function run(): void {",
          '  spawn("custom", []);',
          "}",
        ].join("\n"),
      ),
    ];

    expect(processLifecycleViolations([], sources)).toEqual([
      "src/tools/custom-process.ts spawn site must be in lifecycle catalog",
    ]);
  });

  test(`Given a close-settled tool is classified with an exit listener,
    When lifecycle invariants inspect process event ownership,
    Then they report the lifecycle mismatch`, () => {
    const source = parseSourceText(
      "src/tools/custom-process.ts",
      [
        'import { spawn } from "node:child_process";',
        "export function run(): void {",
        '  const child = spawn("custom", []);',
        '  child.once("exit", () => {});',
        "}",
      ].join("\n"),
    );

    expect(
      processLifecycleViolations(
        [
          {
            tool: "custom",
            sourcePath: "src/tools/custom-process.ts",
            lifecycle: "close-settle",
          },
        ],
        [source],
      ),
    ).toEqual([
      "src/tools/custom-process.ts custom must listen for child process close",
      "src/tools/custom-process.ts custom must not use child process exit lifecycle",
    ]);
  });

  test(`Given process-owning tools have different child process lifecycles,
    When lifecycle invariants inspect known tool spawn sites,
    Then bash is exit-drained and leaf process wrappers remain close-settled`, () => {
    expect(processLifecycleViolations()).toEqual([]);
  });

  test(`Given a multi-file mutator bypasses the shared rollback surface,
    When lifecycle invariants inspect mutator sources,
    Then they report the mutator as unenrolled`, () => {
    const source = parseSourceText(
      "src/tools/apply-patch.ts",
      [
        'import { rollbackAppliedOperations } from "./apply-patch/rollback.ts";',
        "export function executeApplyPatch(): void {",
        "  const applied: string[] = [];",
        "  try {",
        '    applied.push("created.txt");',
        "  } catch (error) {",
        "    rollbackAppliedOperations(applied);",
        "    throw error;",
        "  }",
        "}",
      ].join("\n"),
    );

    expect(
      multiFileMutatorViolations(
        [
          {
            tool: "apply_patch",
            source,
            rollbackModule: "./apply-patch/rollback.ts",
          },
        ],
        [],
      ),
    ).toEqual([
      "src/tools/apply-patch.ts apply_patch must import applyWithRollback from ./apply-patch/rollback.ts",
      "src/tools/apply-patch.ts apply_patch must call applyWithRollback",
    ]);
  });

  test(`Given a batch checkpoint mutator is not in the multi-file catalog,
    When lifecycle invariants inspect mutator sources,
    Then they report the missing rollback enrollment`, () => {
    const source = parseSourceText(
      "src/tools/custom-mutator.ts",
      [
        'import { recordLastBatchCheckpoint } from "../core/git.ts";',
        "export function executeCustom(): void {",
        '  recordLastBatchCheckpoint({ workspace: "/tmp/ws", operations: [] });',
        "}",
      ].join("\n"),
    );

    expect(multiFileMutatorViolations([], [source])).toEqual([
      "src/tools/custom-mutator.ts batch checkpoint mutator must be in multi-file mutator catalog",
    ]);
  });

  test(`Given multi-file mutators can partially apply before failing,
    When lifecycle invariants inspect mutator sources,
    Then each mutator uses the shared rollback surface`, () => {
    expect(multiFileMutatorViolations()).toEqual([]);
  });

  test(`Given behavioral evidence appears only outside active assertions,
    When lifecycle invariants inspect behavioral evidence,
    Then they report the missing executable evidence`, () => {
    const source = parseSourceText(
      "tests/cli/main/session-errors.test.ts",
      [
        'import { expect, test } from "vitest";',
        'test.skip("skipped evidence", () => {',
        '  expect("Earlier you said: remember alpha\\n").toBe("Earlier you said: remember alpha\\n");',
        "});",
        'test("active test without the assertion", () => {',
        '  const marker = "snapshot-question";',
        "  // Earlier you said: remember alpha",
        "});",
      ].join("\n"),
    );

    expect(
      behavioralLifecycleViolations(
        [
          {
            behavior: "resume replays admitted queued input truthfully",
            evidence: [
              {
                testPath: "tests/cli/main/session-errors.test.ts",
                evidence: {
                  bodyStrings: ["snapshot-question"],
                  testEachValues: [],
                  expectations: [
                    {
                      matcher: "toBe",
                      argument: {
                        kind: "literal",
                        value: "Earlier you said: remember alpha\n",
                      },
                      negated: false,
                    },
                  ],
                },
              },
            ],
          },
        ],
        new Map([[source.path, source]]),
      ),
    ).toEqual([
      "resume replays admitted queued input truthfully evidence missing from tests/cli/main/session-errors.test.ts",
    ]);
  });

  test(`Given stateful session behavior is lifecycle-sensitive,
    When lifecycle invariants inspect behavioral evidence,
    Then identity fail-closed and resume truthfulness stay documented by tests`, () => {
    expect(behavioralLifecycleViolations()).toEqual([]);
  });
});
