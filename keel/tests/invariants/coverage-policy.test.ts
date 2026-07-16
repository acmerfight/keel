import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { collectTypeScriptFiles } from "./_ast.ts";

const COVERAGE_IGNORE_PATTERN =
  /\b(?:(?:node:)?coverage|v8|c8|istanbul)\s+ignore\b/giu;
const PROJECT_TYPESCRIPT_DIRECTORIES = [
  "evals",
  "scripts",
  "src",
  "tests",
] as const;
const PROJECT_TYPESCRIPT_FILES = ["vitest.config.ts"] as const;

function coverageSuppressions(): readonly string[] {
  const suppressions: string[] = [];

  for (const directory of PROJECT_TYPESCRIPT_DIRECTORIES) {
    for (const path of collectTypeScriptFiles(directory)) {
      const source = readFileSync(path, "utf8");
      for (const match of source.matchAll(COVERAGE_IGNORE_PATTERN)) {
        if (match.index === undefined) continue;
        const line = source.slice(0, match.index).split("\n").length;
        suppressions.push(`${path}:${line}`);
      }
    }
  }

  for (const path of PROJECT_TYPESCRIPT_FILES) {
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(COVERAGE_IGNORE_PATTERN)) {
      if (match.index === undefined) continue;
      const line = source.slice(0, match.index).split("\n").length;
      suppressions.push(`${path}:${line}`);
    }
  }

  return suppressions;
}

describe("Coverage Policy", () => {
  test.each([
    "v8",
    "c8",
    "istanbul",
    "coverage",
    "node:coverage",
  ])(`Given a %s suppression marker,
    When coverage policy inspects its directive,
    Then the marker is rejected`, (marker) => {
    const directive = [marker, "ignore next"].join(" ");
    expect([...directive.matchAll(COVERAGE_IGNORE_PATTERN)]).toHaveLength(1);
  });

  test(`Given project-owned TypeScript,
    When coverage policy is checked,
    Then inline coverage suppression is absent`, () => {
    expect(coverageSuppressions()).toEqual([]);
  });
});
