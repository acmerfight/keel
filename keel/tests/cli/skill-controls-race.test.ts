import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { SkillCatalog } from "../../src/skills/model.ts";

class TestNodeError extends Error implements NodeJS.ErrnoException {
  readonly code: string;

  constructor(code: string) {
    super(`${code} during workflow Skill control race`);
    this.code = code;
  }
}

function nodeError(code: string): NodeJS.ErrnoException {
  return new TestNodeError(code);
}

function runtime(home: string): {
  readonly env: (key: string) => string | undefined;
} {
  return { env: (key) => (key === "KEEL_HOME" ? home : undefined) };
}

async function importSkillUserConfigWithFs(
  overrides: Readonly<{
    renameSync: (
      oldPath: Parameters<typeof import("node:fs").renameSync>[0],
      newPath: Parameters<typeof import("node:fs").renameSync>[1],
    ) => void;
    statSync: (
      path: Parameters<typeof import("node:fs").statSync>[0],
    ) => ReturnType<typeof import("node:fs").statSync>;
  }>,
) {
  const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
  vi.resetModules();
  vi.doMock("node:fs", () => ({ ...actualFs, ...overrides }));
  return import("../../src/cli/skill-user-config.ts");
}

describe("Workflow Skill Control Races", () => {
  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.restoreAllMocks();
    vi.resetModules();
  });

  test.each([
    "EEXIST",
    "ENOTEMPTY",
  ])(`Given a stale config lock is replaced by a live generation before a delayed reclaimer receives $code,
    When the user updates a Skill control,
    Then the delayed reclaimer preserves the live lock and reports contention`, async (code) => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-skill-lock-replace-race-"));
    const lockPath = join(home, "skills.lock");
    const replacementToken = "00000000-0000-4000-8000-000000000001";
    await mkdir(lockPath);
    await writeFile(
      join(lockPath, "owner.json"),
      '{"pid":2147483647,"token":"00000000-0000-4000-8000-000000000000"}\n',
    );
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    let replacementCreated = false;
    vi.spyOn(Date, "now").mockImplementation(() =>
      replacementCreated ? 5_001 : 0,
    );
    const skillUserConfig = await importSkillUserConfigWithFs({
      renameSync: (oldPath, newPath) => {
        if (String(oldPath) === lockPath) {
          actualFs.renameSync(oldPath, newPath);
          actualFs.mkdirSync(lockPath, { mode: 0o700 });
          actualFs.writeFileSync(
            join(lockPath, "owner.json"),
            `${JSON.stringify({ pid: process.pid, token: replacementToken })}\n`,
            { encoding: "utf8", mode: 0o600 },
          );
          replacementCreated = true;
          throw nodeError(code);
        }
        actualFs.renameSync(oldPath, newPath);
      },
      statSync: (path) => actualFs.statSync(path),
    });

    try {
      // When / Then
      expect(() =>
        skillUserConfig.setWorkflowSkillEnabled(
          runtime(home),
          "repo:root:review",
          false,
        ),
      ).toThrow(
        `Error: workflow skill config ${join(home, "skills.json")} is busy; retry after the other Keel process finishes.`,
      );
      expect(
        JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")),
      ).toEqual({ pid: process.pid, token: replacementToken });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given another reclaimer moves a stale config lock before this writer completes its rename,
    When the writer observes the vanished source and updates a Skill control,
    Then it retries against the current lock generation`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-skill-lock-rename-race-"));
    const lockPath = join(home, "skills.lock");
    await mkdir(lockPath);
    await writeFile(
      join(lockPath, "owner.json"),
      '{"pid":2147483647,"token":"00000000-0000-4000-8000-000000000002"}\n',
    );
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    let staleRenameIntercepted = false;
    const skillUserConfig = await importSkillUserConfigWithFs({
      renameSync: (oldPath, newPath) => {
        if (String(oldPath) === lockPath && !staleRenameIntercepted) {
          actualFs.renameSync(oldPath, newPath);
          staleRenameIntercepted = true;
          throw nodeError("ENOENT");
        }
        actualFs.renameSync(oldPath, newPath);
      },
      statSync: (path) => actualFs.statSync(path),
    });

    try {
      // When
      const result = skillUserConfig.setWorkflowSkillEnabled(
        runtime(home),
        "repo:root:review",
        false,
      );

      // Then
      expect(result.changed).toBe(true);
      expect(
        JSON.parse(await readFile(join(home, "skills.json"), "utf8")),
      ).toMatchObject({ disabledPackageIds: ["repo:root:review"] });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given stale lock reclamation is denied by the filesystem,
    When the user updates a Skill control,
    Then the writer fails closed instead of treating the denial as contention`, async () => {
    // Given
    const home = await mkdtemp(
      join(tmpdir(), "keel-skill-lock-rename-denied-"),
    );
    const lockPath = join(home, "skills.lock");
    await mkdir(lockPath);
    await writeFile(
      join(lockPath, "owner.json"),
      '{"pid":2147483647,"token":"00000000-0000-4000-8000-000000000003"}\n',
    );
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const skillUserConfig = await importSkillUserConfigWithFs({
      renameSync: (oldPath, newPath) => {
        if (String(oldPath) === lockPath) throw nodeError("EACCES");
        actualFs.renameSync(oldPath, newPath);
      },
      statSync: (path) => actualFs.statSync(path),
    });

    try {
      // When / Then
      expect(() =>
        skillUserConfig.setWorkflowSkillEnabled(
          runtime(home),
          "repo:root:review",
          false,
        ),
      ).toThrow(
        `Error: cannot reclaim stale workflow skill config lock ${lockPath}: EACCES during workflow Skill control race`,
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given an ownerless stale lock disappears between inspection and generation identification,
    When the user updates a Skill control,
    Then the writer retries without treating the vanished lock as an error`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-skill-lock-vanish-race-"));
    const lockPath = join(home, "skills.lock");
    await mkdir(lockPath);
    const oldTime = new Date(Date.now() - 60_000);
    await utimes(lockPath, oldTime, oldTime);
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    let lockStats = 0;
    const skillUserConfig = await importSkillUserConfigWithFs({
      renameSync: (oldPath, newPath) => actualFs.renameSync(oldPath, newPath),
      statSync: (path) => {
        if (String(path) === lockPath && ++lockStats === 2) {
          actualFs.rmSync(lockPath, { recursive: true, force: true });
          throw nodeError("ENOENT");
        }
        return actualFs.statSync(path);
      },
    });

    try {
      // When
      const result = skillUserConfig.setWorkflowSkillEnabled(
        runtime(home),
        "repo:root:review",
        false,
      );

      // Then
      expect(result.changed).toBe(true);
      expect(
        JSON.parse(await readFile(join(home, "skills.json"), "utf8")),
      ).toMatchObject({ disabledPackageIds: ["repo:root:review"] });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given an ownerless stale lock becomes unreadable during generation identification,
    When the user updates a Skill control,
    Then the writer fails closed with the filesystem error`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-skill-lock-stat-race-"));
    const lockPath = join(home, "skills.lock");
    await mkdir(lockPath);
    const oldTime = new Date(Date.now() - 60_000);
    await utimes(lockPath, oldTime, oldTime);
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    let lockStats = 0;
    const skillUserConfig = await importSkillUserConfigWithFs({
      renameSync: (oldPath, newPath) => actualFs.renameSync(oldPath, newPath),
      statSync: (path) => {
        if (String(path) === lockPath && ++lockStats === 2) {
          throw nodeError("EACCES");
        }
        return actualFs.statSync(path);
      },
    });

    try {
      // When / Then
      expect(() =>
        skillUserConfig.setWorkflowSkillEnabled(
          runtime(home),
          "repo:root:review",
          false,
        ),
      ).toThrow(
        `Error: cannot identify workflow skill config lock ${lockPath}: EACCES during workflow Skill control race`,
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a disabled repository Skill disappears after catalog discovery,
    When Keel resolves the package visibility boundary,
    Then it fails closed instead of omitting the canonical path check`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-disabled-skill-canonical-race-"),
    );
    const packagePath = join(workspace, ".agents", "skills", "review");
    await mkdir(packagePath, { recursive: true });
    const catalog = {
      skills: [
        {
          id: "repo:root:review:digest",
          packageId: "repo:root:review",
          rootKey: "root",
          rootPriority: 0,
          qualifiedName: "repo:review",
          scope: "repo",
          activationPolicy: "implicit",
          name: "review",
          description: "Review changes",
          relativePath: ".agents/skills/review/SKILL.md",
          digest: "digest",
        },
      ],
      implicitSkills: [],
      warnings: [],
      audits: [],
      load: () => {
        throw new Error("not used");
      },
      loadImplicit: () => {
        throw new Error("not used");
      },
      loadPackage: () => undefined,
      search: () => [],
      readResource: () => "",
      readPackageResource: () => "",
    } satisfies SkillCatalog;
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const resolvedPackagePath = join(
      actualFs.realpathSync(workspace),
      ".agents",
      "skills",
      "review",
    );
    vi.resetModules();
    vi.doMock("node:fs", () => ({
      ...actualFs,
      realpathSync: (
        path: Parameters<typeof actualFs.realpathSync>[0],
      ): string => {
        if (String(path) === resolvedPackagePath) throw nodeError("ENOENT");
        return actualFs.realpathSync(path);
      },
    }));
    const workflowSkills = await import("../../src/cli/workflow-skills.ts");

    try {
      // When / Then
      expect(() =>
        workflowSkills.disabledWorkflowSkillWorkspacePaths(workspace, catalog, [
          "repo:root:review",
        ]),
      ).toThrow(
        'Error: cannot enforce the disabled workflow skill boundary for "repo:review" because its canonical package path is unavailable.',
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
