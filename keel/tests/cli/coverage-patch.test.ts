import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runGit } from "../../src/testing/cli-harness.ts";

const COVERAGE_PATCH_SCRIPT = join(process.cwd(), "scripts/coverage-patch.ts");

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

type LcovFixture = string | ((workspace: string) => string);

function runCoveragePatch(
  workspace: string,
  args: readonly string[] = [],
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = execFile(
      "node",
      ["--experimental-strip-types", COVERAGE_PATCH_SCRIPT, ...args],
      { cwd: workspace },
      (error, stdout, stderr) => {
        const exitCode =
          typeof error?.code === "number" ? error.code : (child.exitCode ?? 0);
        resolve({ stdout, stderr, exitCode });
      },
    );
  });
}

async function createPatchCoverageWorkspace(
  lcov: LcovFixture,
): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "keel-patch-coverage-"));
  await runGit(workspace, ["init"]);
  await runGit(workspace, ["config", "user.name", "Keel Test"]);
  await runGit(workspace, ["config", "user.email", "keel@example.com"]);
  await mkdir(join(workspace, "src"), { recursive: true });
  await writeFile(
    join(workspace, "src", "feature.ts"),
    "export function choose(flag: boolean) {\n  return flag ? 1 : 2;\n}\n",
    "utf8",
  );
  await runGit(workspace, ["add", "src/feature.ts"]);
  await runGit(workspace, ["commit", "-m", "base"]);
  await runGit(workspace, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  await writeFile(
    join(workspace, "src", "feature.ts"),
    "export function choose(flag: boolean) {\n  if (flag) {\n    return 1;\n  }\n  return 2;\n}\n",
    "utf8",
  );
  await runGit(workspace, ["add", "src/feature.ts"]);
  await runGit(workspace, ["commit", "-m", "change feature"]);
  await mkdir(join(workspace, "coverage"), { recursive: true });
  await writeFile(
    join(workspace, "coverage", "lcov.info"),
    typeof lcov === "string" ? lcov : lcov(workspace),
    "utf8",
  );
  return workspace;
}

async function createOneLinePatchCoverageWorkspace(
  lcov: string,
): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "keel-patch-coverage-"));
  await runGit(workspace, ["init"]);
  await runGit(workspace, ["config", "user.name", "Keel Test"]);
  await runGit(workspace, ["config", "user.email", "keel@example.com"]);
  await mkdir(join(workspace, "src"), { recursive: true });
  await writeFile(
    join(workspace, "src", "feature.ts"),
    "export const value = 1;\n",
    "utf8",
  );
  await runGit(workspace, ["add", "src/feature.ts"]);
  await runGit(workspace, ["commit", "-m", "base"]);
  await runGit(workspace, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  await writeFile(
    join(workspace, "src", "feature.ts"),
    "export const value = 2;\n",
    "utf8",
  );
  await runGit(workspace, ["add", "src/feature.ts"]);
  await runGit(workspace, ["commit", "-m", "change feature"]);
  await mkdir(join(workspace, "coverage"), { recursive: true });
  await writeFile(join(workspace, "coverage", "lcov.info"), lcov, "utf8");
  return workspace;
}

async function createNestedPatchCoverageWorkspace(
  lcov: string,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "keel-patch-coverage-root-"));
  const workspace = join(root, "keel");
  await runGit(root, ["init"]);
  await runGit(root, ["config", "user.name", "Keel Test"]);
  await runGit(root, ["config", "user.email", "keel@example.com"]);
  await mkdir(join(workspace, "src"), { recursive: true });
  await writeFile(
    join(workspace, "src", "feature.ts"),
    "export const value = 1;\n",
    "utf8",
  );
  await runGit(root, ["add", "keel/src/feature.ts"]);
  await runGit(root, ["commit", "-m", "base"]);
  await runGit(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  await writeFile(
    join(workspace, "src", "feature.ts"),
    "export const value = 2;\n",
    "utf8",
  );
  await runGit(root, ["add", "keel/src/feature.ts"]);
  await runGit(root, ["commit", "-m", "change feature"]);
  await mkdir(join(workspace, "coverage"), { recursive: true });
  await writeFile(join(workspace, "coverage", "lcov.info"), lcov, "utf8");
  return workspace;
}

describe("Patch Coverage CLI", () => {
  test(`Given changed coverable code has an uncovered line,
    When patch coverage is checked,
    Then the command reports the line and fails`, async () => {
    // Given
    const workspace = await createPatchCoverageWorkspace(`TN:
SF:src/feature.ts
DA:1,1
DA:2,1
DA:3,0
DA:5,1
end_of_record
`);

    try {
      // When
      const result = await runCoveragePatch(workspace);

      // Then
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("Patch coverage failed");
      expect(result.stdout).toContain("src/feature.ts:3 uncovered line");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given changed coverable code has an untaken branch,
    When patch coverage is checked,
    Then the command reports the partial branch and fails`, async () => {
    // Given
    const workspace = await createPatchCoverageWorkspace(`TN:
SF:src/feature.ts
DA:1,1
DA:3,1
DA:4,1
DA:5,1
BRDA:2,0,0,1
BRDA:2,0,1,-
end_of_record
`);

    try {
      // When
      const result = await runCoveragePatch(workspace);

      // Then
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("Patch coverage failed");
      expect(result.stdout).toContain(
        "src/feature.ts:2 partial branch (1/2 branches covered)",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given every changed coverable line and branch is covered,
    When patch coverage is checked,
    Then the command succeeds`, async () => {
    // Given
    const workspace = await createPatchCoverageWorkspace(`TN:
SF:src/feature.ts
DA:1,1
DA:2,1
DA:3,0
DA:3,1
DA:4,1
DA:5,1
BRDA:2,0,0,1
BRDA:2,0,1,1
end_of_record
`);

    try {
      // When
      const result = await runCoveragePatch(workspace);

      // Then
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Patch coverage passed");
      expect(result.stdout).toContain("100.00%");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given changed lines are absent from coverage data,
    When patch coverage is checked,
    Then the command reports them as not coverable without failing`, async () => {
    // Given
    const workspace = await createPatchCoverageWorkspace(`TN:
SF:src/feature.ts
DA:1,1
end_of_record
`);

    try {
      // When
      const result = await runCoveragePatch(workspace);

      // Then
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Patch coverage passed");
      expect(result.stdout).toContain(
        "4 changed lines were not present in coverage data",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a one-line patch is fully covered,
    When patch coverage is checked,
    Then the command accepts the single-line diff hunk`, async () => {
    // Given
    const workspace = await createOneLinePatchCoverageWorkspace(`TN:
SF:src/feature.ts
DA:1,1
end_of_record
`);

    try {
      // When
      const result = await runCoveragePatch(workspace);

      // Then
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Patch coverage passed");
      expect(result.stdout).toContain("1/1 changed coverable lines covered");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a changed line only has fully covered branch data,
    When patch coverage is checked,
    Then the command does not treat the missing line-hit record as uncovered`, async () => {
    // Given
    const workspace = await createOneLinePatchCoverageWorkspace(`TN:
SF:src/feature.ts
BRDA:1,0,0,1
BRDA:1,0,1,1
end_of_record
`);

    try {
      // When
      const result = await runCoveragePatch(workspace);

      // Then
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("1/1 changed coverable lines covered");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given keel is nested inside the git repository,
    When patch coverage is checked from the keel directory,
    Then changed paths are matched against keel-relative LCOV paths`, async () => {
    // Given
    const workspace = await createNestedPatchCoverageWorkspace(`TN:
SF:src/feature.ts
DA:1,0
end_of_record
`);

    try {
      // When
      const result = await runCoveragePatch(workspace);

      // Then
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("src/feature.ts:1 uncovered line");
      expect(result.stdout).not.toContain("not present in coverage data");
    } finally {
      await rm(join(workspace, ".."), { recursive: true, force: true });
    }
  });

  test(`Given coverage data has malformed records before valid hits,
    When patch coverage is checked,
    Then malformed records are skipped and valid coverage still passes`, async () => {
    // Given
    const workspace = await createPatchCoverageWorkspace(`TN:
DA:99,1
BRDA:99,0,0,1
SF:src/feature.ts
DA:2
DA:not-a-line,1
DA:3,not-hits
BRDA:2,0,0
BRDA:not-a-line,0,0,1
BRDA:2,0,0,not-hits
BRDA:4,0,0,1
DA:1,1
DA:2,1
DA:3,1
DA:4,1
DA:5,1
BRDA:2,0,0,1
BRDA:2,0,1,1
end_of_record
`);

    try {
      // When
      const result = await runCoveragePatch(workspace);

      // Then
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Patch coverage passed");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the patch coverage script is run without arguments,
    When coverage data exists at the default path,
    Then it checks the default compare branch and succeeds`, async () => {
    // Given
    const workspace = await createPatchCoverageWorkspace(
      (workspace) => `TN:
SF:${join(workspace, "src", "feature.ts")}
DA:1,1
DA:2,1
DA:3,1
DA:4,1
DA:5,1
BRDA:2,0,0,1
BRDA:2,0,1,1
end_of_record
`,
    );

    try {
      // When
      const result = await runCoveragePatch(workspace);

      // Then
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Patch coverage passed");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
