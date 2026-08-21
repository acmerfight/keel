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
    mkdirSync?: (
      path: Parameters<typeof import("node:fs").mkdirSync>[0],
      options?: Parameters<typeof import("node:fs").mkdirSync>[1],
    ) => ReturnType<typeof import("node:fs").mkdirSync>;
    renameSync?: (
      oldPath: Parameters<typeof import("node:fs").renameSync>[0],
      newPath: Parameters<typeof import("node:fs").renameSync>[1],
    ) => void;
    rmSync?: (
      path: Parameters<typeof import("node:fs").rmSync>[0],
      options?: Parameters<typeof import("node:fs").rmSync>[1],
    ) => void;
    statSync?: (
      path: Parameters<typeof import("node:fs").statSync>[0],
    ) => ReturnType<typeof import("node:fs").statSync>;
    writeFileSync?: (
      file: Parameters<typeof import("node:fs").writeFileSync>[0],
      data: Parameters<typeof import("node:fs").writeFileSync>[1],
      options?: Parameters<typeof import("node:fs").writeFileSync>[2],
    ) => void;
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

  test.each(["EEXIST", "ENOTEMPTY"])(
    `Given a stale config lock is replaced by a live generation before a delayed reclaimer receives $code,
    When the user updates a Skill control,
    Then the delayed reclaimer preserves the live lock and reports contention`,
    async (code) => {
      // Given
      const home = await mkdtemp(
        join(tmpdir(), "keel-skill-lock-replace-race-"),
      );
      const lockPath = join(home, "skills.lock");
      const replacementToken = "00000000-0000-4000-8000-000000000001";
      await mkdir(lockPath);
      await writeFile(
        join(lockPath, "owner.json"),
        '{"pid":2147483647,"token":"00000000-0000-4000-8000-000000000000"}\n',
      );
      const actualFs =
        await vi.importActual<typeof import("node:fs")>("node:fs");
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
    },
  );

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

  test(`Given a live process owns the config lock,
    When the user updates a Skill control after the wait deadline,
    Then the writer preserves the live lock and reports bounded contention`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-skill-lock-live-owner-"));
    const lockPath = join(home, "skills.lock");
    const owner = {
      pid: process.pid,
      token: "00000000-0000-4000-8000-000000000005",
    };
    await mkdir(lockPath);
    await writeFile(join(lockPath, "owner.json"), `${JSON.stringify(owner)}\n`);
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(5_001);
    const skillUserConfig = await importSkillUserConfigWithFs({});

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
      ).toEqual(owner);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a recent ownerless config lock is still publishing its owner record,
    When the user updates a Skill control,
    Then the writer preserves the publishing lock and reports bounded contention`, async () => {
    // Given
    const home = await mkdtemp(
      join(tmpdir(), "keel-skill-lock-owner-publish-"),
    );
    const lockPath = join(home, "skills.lock");
    await mkdir(lockPath);
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.spyOn(Atomics, "wait").mockImplementation(() => {
      now = 5_001;
      return "timed-out";
    });
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const skillUserConfig = await importSkillUserConfigWithFs({});

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
      expect(actualFs.statSync(lockPath).isDirectory()).toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given an ownerless config lock disappears during freshness inspection,
    When the user updates a Skill control,
    Then the writer retries and persists the requested control`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-skill-lock-age-vanish-"));
    const lockPath = join(home, "skills.lock");
    await mkdir(lockPath);
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    let lockInspected = false;
    const skillUserConfig = await importSkillUserConfigWithFs({
      statSync: (path) => {
        if (String(path) === lockPath && !lockInspected) {
          lockInspected = true;
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

  test(`Given an ownerless config lock becomes unreadable during freshness inspection,
    When the user updates a Skill control,
    Then the writer fails closed with the inspection error`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-skill-lock-age-denied-"));
    const lockPath = join(home, "skills.lock");
    await mkdir(lockPath);
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const skillUserConfig = await importSkillUserConfigWithFs({
      statSync: (path) => {
        if (String(path) === lockPath) throw nodeError("EACCES");
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
        `Error: cannot inspect workflow skill config lock ${lockPath}: EACCES during workflow Skill control race`,
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given the user home denies config lock creation,
    When the user updates a Skill control,
    Then the writer reports the acquisition failure`, async () => {
    // Given
    const home = await mkdtemp(
      join(tmpdir(), "keel-skill-lock-acquire-denied-"),
    );
    const lockPath = join(home, "skills.lock");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const skillUserConfig = await importSkillUserConfigWithFs({
      mkdirSync: (path, options) => {
        if (String(path) === lockPath) throw nodeError("EACCES");
        return actualFs.mkdirSync(path, options);
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
        `Error: cannot acquire workflow skill config lock ${lockPath}: EACCES during workflow Skill control race`,
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given config lock owner publication fails after exclusive acquisition,
    When the user updates a Skill control,
    Then the writer removes the unpublished lock and reports initialization failure`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-skill-lock-owner-denied-"));
    const lockPath = join(home, "skills.lock");
    const ownerPath = join(lockPath, "owner.json");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const skillUserConfig = await importSkillUserConfigWithFs({
      writeFileSync: (file, data, options) => {
        if (String(file) === ownerPath) throw nodeError("EACCES");
        actualFs.writeFileSync(file, data, options);
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
        `Error: cannot initialize workflow skill config lock ${lockPath}: EACCES during workflow Skill control race`,
      );
      expect(
        actualFs.statSync(lockPath, { throwIfNoEntry: false }),
      ).toBeUndefined();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given another writer replaces the config lock before release,
    When the current writer finishes a Skill control update,
    Then it preserves the replacement lock generation`, async () => {
    // Given
    const home = await mkdtemp(
      join(tmpdir(), "keel-skill-lock-release-replaced-"),
    );
    const lockPath = join(home, "skills.lock");
    const configPath = join(home, "skills.json");
    const replacementToken = "00000000-0000-4000-8000-000000000004";
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const skillUserConfig = await importSkillUserConfigWithFs({
      renameSync: (oldPath, newPath) => {
        actualFs.renameSync(oldPath, newPath);
        if (String(newPath) !== configPath) return;
        actualFs.rmSync(lockPath, { recursive: true, force: true });
        actualFs.mkdirSync(lockPath, { mode: 0o700 });
        actualFs.writeFileSync(
          join(lockPath, "owner.json"),
          `${JSON.stringify({ pid: process.pid, token: replacementToken })}\n`,
          { encoding: "utf8", mode: 0o600 },
        );
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
        JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")),
      ).toEqual({ pid: process.pid, token: replacementToken });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given the filesystem denies release of an owned config lock,
    When the user finishes a Skill control update,
    Then the writer reports the release failure`, async () => {
    // Given
    const home = await mkdtemp(
      join(tmpdir(), "keel-skill-lock-release-denied-"),
    );
    const lockPath = join(home, "skills.lock");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const skillUserConfig = await importSkillUserConfigWithFs({
      rmSync: (path, options) => {
        if (String(path) === lockPath) throw nodeError("EACCES");
        actualFs.rmSync(path, options);
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
        `Error: cannot release workflow skill config lock ${lockPath}: EACCES during workflow Skill control race`,
      );
    } finally {
      actualFs.rmSync(home, { recursive: true, force: true });
    }
  });
});
