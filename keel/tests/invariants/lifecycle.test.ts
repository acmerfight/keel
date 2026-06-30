import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, test } from "vitest";
import {
  collectTypeScriptFiles,
  importedBindings,
  type ParsedSource,
  parseSource,
  parseSourceText,
} from "./_ast.ts";

type ProcessLifecycle = "exit-drain" | "close-settle";

interface ProcessLifecycleEntry {
  readonly tool: string;
  readonly sourcePath: string;
  readonly lifecycle: ProcessLifecycle;
  readonly evidence: readonly string[];
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
  readonly snippets: readonly string[];
}

const applyPatchSource = parseSource("src/tools/apply-patch.ts");

const processLifecycleCatalog = [
  {
    tool: "bash",
    sourcePath: "src/tools/bash.ts",
    lifecycle: "exit-drain",
    evidence: [
      'child.once("exit"',
      "scheduleExitDrain",
      "EXIT_STDIO_QUIET_DRAIN_MS",
      "EXIT_STDIO_MAX_DRAIN_MS",
    ],
  },
  {
    tool: "git_diff",
    sourcePath: "src/tools/git-diff.ts",
    lifecycle: "close-settle",
    evidence: ['child.once("close"', 'finish({ type: "resolve"'],
  },
  {
    tool: "ripgrep",
    sourcePath: "src/tools/ripgrep-process.ts",
    lifecycle: "close-settle",
    evidence: ['child.on("close"', "resolveResult({ code, stderr })"],
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
        snippets: [
          "Given a named session is already active",
          "When another interactive process resumes the same session",
          'Error: session "active" is already active.',
        ],
      },
    ],
  },
  {
    behavior: "resume replays admitted queued input truthfully",
    evidence: [
      {
        testPath: "tests/cli/main/session-errors.test.ts",
        snippets: [
          "Given the user resumes an oversized session with a bounded snapshot",
          "When queued input is restored from that snapshot",
          "Earlier you said: remember alpha",
        ],
      },
    ],
  },
  {
    behavior: "forked sessions do not copy source pending queued input",
    evidence: [
      {
        testPath: "tests/cli/main/session-fork.test.ts",
        snippets: [
          'Forked session "source" to "target"',
          'expect(JSON.stringify(forkedHistory)).not.toContain("remember beta")',
        ],
      },
    ],
  },
  {
    behavior: "workflow skill identity persists and resumes truthfully",
    evidence: [
      {
        testPath: "tests/cli/main/skills-command.test.ts",
        snippets: [
          "Given a named interactive session already has a workflow skill",
          "When the user resumes it with the same workflow skill name",
          "Then the CLI continues the session without reloading a new workflow skill",
        ],
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

function processLifecycleViolations(
  entries: readonly ProcessLifecycleEntry[] = processLifecycleCatalog,
  sources: readonly ParsedSource[] = collectTypeScriptFiles("src/tools").map(
    parseSource,
  ),
): readonly string[] {
  const violations: string[] = [];
  const catalogPaths = new Set(entries.map((entry) => entry.sourcePath));

  for (const sourcePath of toolSpawnSourcePaths(sources)) {
    if (!catalogPaths.has(sourcePath)) {
      violations.push(`${sourcePath} spawn site must be in lifecycle catalog`);
    }
  }

  for (const entry of entries) {
    const text = readFileSync(entry.sourcePath, "utf8");
    for (const snippet of entry.evidence) {
      if (!text.includes(snippet)) {
        violations.push(
          `${entry.sourcePath} ${entry.tool} ${entry.lifecycle} evidence missing: ${snippet}`,
        );
      }
    }
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
): readonly string[] {
  const violations: string[] = [];
  for (const entry of entries) {
    for (const evidence of entry.evidence) {
      const text = readFileSync(evidence.testPath, "utf8");
      for (const snippet of evidence.snippets) {
        if (!text.includes(snippet)) {
          violations.push(
            `${entry.behavior} evidence missing from ${evidence.testPath}: ${snippet}`,
          );
        }
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

  test(`Given stateful session behavior is lifecycle-sensitive,
    When lifecycle invariants inspect behavioral evidence,
    Then identity fail-closed and resume truthfulness stay documented by tests`, () => {
    expect(behavioralLifecycleViolations()).toEqual([]);
  });
});
