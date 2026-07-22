import type { Dir, PathLike, Stats } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

type FsModule = typeof import("node:fs");

interface FsOverrides {
  readonly existsSync?: (path: PathLike) => boolean;
  readonly fstatSync?: (fd: number) => Stats;
  readonly lstatSync?: (
    path: PathLike,
    options?: {
      readonly bigint?: false;
      readonly throwIfNoEntry?: false;
    },
  ) => Stats | undefined;
  readonly openSync?: (
    path: PathLike,
    flags: string | number,
    mode?: string | number | null,
  ) => number;
  readonly opendirSync?: (path: PathLike) => Dir;
  readonly readFileSync?: (path: PathLike) => Buffer;
  readonly readSync?: (
    fd: number,
    buffer: NodeJS.ArrayBufferView,
    offset: number,
    length: number,
    position: number | null,
  ) => number;
  readonly statSync?: (path: PathLike) => Stats;
}

class TestNodeError extends Error implements NodeJS.ErrnoException {
  readonly code: string;

  constructor(code: string) {
    super(`${code} during workflow Skill package race`);
    this.code = code;
  }
}

async function importProjectSkillsWithFs(
  overrides: FsOverrides,
): Promise<typeof import("../../src/skills/project.ts")> {
  const actualFs = await vi.importActual<FsModule>("node:fs");
  vi.resetModules();
  vi.doMock("node:fs", () => ({ ...actualFs, ...overrides }));
  return import("../../src/skills/project.ts");
}

async function createSkillFixture(prefix: string): Promise<{
  readonly workspace: string;
  readonly skillPath: string;
  readonly referencesPath: string;
  readonly resourcePath: string;
}> {
  const workspace = await mkdtemp(join(tmpdir(), prefix));
  const skillPath = join(workspace, ".agents", "skills", "review");
  const referencesPath = join(skillPath, "references");
  const resourcePath = join(referencesPath, "guide.md");
  await mkdir(referencesPath, { recursive: true });
  await writeFile(
    join(skillPath, "SKILL.md"),
    "---\nname: review\ndescription: Review changes.\n---\nRead the guide.\n",
  );
  await writeFile(resourcePath, "ok");
  return { workspace, skillPath, referencesPath, resourcePath };
}

describe("Project Skill Package Race Handling", () => {
  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.restoreAllMocks();
    vi.resetModules();
  });

  test(`Given a resource directory becomes unreadable after it is opened,
    When discovery continues its deterministic inventory,
    Then the incomplete scan blocks the package with a content-free diagnostic`, async () => {
    // Given
    const fixture = await createSkillFixture("keel-skill-directory-read-race-");
    const actualFs = await vi.importActual<FsModule>("node:fs");
    const projectSkills = await importProjectSkillsWithFs({
      opendirSync: (path) => {
        const directory = actualFs.opendirSync(path);
        if (String(path) === fixture.referencesPath) {
          directory.readSync = () => {
            throw new TestNodeError("EIO");
          };
        }
        return directory;
      },
    });

    try {
      // When
      const catalog = projectSkills.discoverSkillCatalog({
        workspace: fixture.workspace,
      });

      // Then
      expect(catalog.skills).toEqual([]);
      expect(catalog.audits[0]?.findings).toContainEqual({
        severity: "blocker",
        code: "resource_unreadable",
        relativePath: "references",
        message:
          "could not be read completely during deterministic package audit",
      });
    } finally {
      await rm(fixture.workspace, { recursive: true, force: true });
    }
  });

  test(`Given an inventoried resource is replaced by a non-regular entry before audit,
    When the deterministic package audit validates its current identity,
    Then the package fails closed before reading replacement bytes`, async () => {
    // Given
    const fixture = await createSkillFixture("keel-skill-resource-replace-");
    const actualFs = await vi.importActual<FsModule>("node:fs");
    const projectSkills = await importProjectSkillsWithFs({
      lstatSync: (path, options) => {
        if (String(path) === fixture.resourcePath) {
          return Object.assign(actualFs.lstatSync(path), {
            isFile: () => false,
          });
        }
        return actualFs.lstatSync(path, options);
      },
    });

    try {
      // When
      const catalog = projectSkills.discoverSkillCatalog({
        workspace: fixture.workspace,
      });

      // Then
      expect(catalog.skills).toEqual([]);
      expect(catalog.audits[0]?.findings).toContainEqual({
        severity: "blocker",
        code: "resource_unreadable",
        relativePath: "references/guide.md",
        message: "is no longer a regular file and cannot be audited safely",
      });
    } finally {
      await rm(fixture.workspace, { recursive: true, force: true });
    }
  });

  test(`Given SKILL.md is replaced by an out-of-package symlink between validation and open,
    When discovery opens the changed package document,
    Then the opened identity is rejected without loading outside instructions`, async () => {
    // Given
    const fixture = await createSkillFixture(
      "keel-skill-document-symlink-race-",
    );
    const actualFs = await vi.importActual<FsModule>("node:fs");
    const skillFilePath = join(fixture.skillPath, "SKILL.md");
    const outsidePath = join(fixture.workspace, "outside-skill.md");
    const outsideContent = "OUTSIDE-SKILL-CONTENT";
    await writeFile(
      outsidePath,
      `---\nname: review\ndescription: Outside package.\n---\n${outsideContent}\n`,
    );
    let swapped = false;
    const projectSkills = await importProjectSkillsWithFs({
      openSync: (path, flags, mode) => {
        if (String(path) === skillFilePath && !swapped) {
          actualFs.rmSync(skillFilePath);
          actualFs.symlinkSync(outsidePath, skillFilePath);
          swapped = true;
        }
        return actualFs.openSync(path, flags, mode);
      },
    });

    try {
      // When
      const catalog = projectSkills.discoverSkillCatalog({
        workspace: fixture.workspace,
      });

      // Then
      expect(catalog.skills).toEqual([]);
      expect(catalog.audits[0]?.findings).toContainEqual(
        expect.objectContaining({
          severity: "blocker",
          code: "invalid_package",
          message: "SKILL.md resolves outside its declared Skill root",
        }),
      );
      expect(catalog.warnings[0]?.message).not.toContain(outsideContent);
      expect(catalog.warnings[0]?.message).not.toContain(outsidePath);
    } finally {
      await rm(fixture.workspace, { recursive: true, force: true });
    }
  });

  test(`Given the whole Skill package becomes an out-of-root symlink before SKILL.md opens,
    When discovery validates the opened package document,
    Then the fixed package identity rejects outside instructions`, async () => {
    // Given
    const fixture = await createSkillFixture(
      "keel-skill-package-symlink-race-",
    );
    const actualFs = await vi.importActual<FsModule>("node:fs");
    const skillFilePath = join(fixture.skillPath, "SKILL.md");
    const outsideSkillPath = join(fixture.workspace, "outside-review");
    const outsideContent = "OUTSIDE-PACKAGE-INSTRUCTIONS";
    await mkdir(outsideSkillPath, { recursive: true });
    await writeFile(
      join(outsideSkillPath, "SKILL.md"),
      `---\nname: review\ndescription: Outside package.\n---\n${outsideContent}\n`,
    );
    let swapped = false;
    const projectSkills = await importProjectSkillsWithFs({
      openSync: (path, flags, mode) => {
        if (String(path) === skillFilePath && !swapped) {
          actualFs.rmSync(fixture.skillPath, { recursive: true });
          actualFs.symlinkSync(outsideSkillPath, fixture.skillPath);
          swapped = true;
        }
        return actualFs.openSync(path, flags, mode);
      },
    });

    try {
      // When
      const catalog = projectSkills.discoverSkillCatalog({
        workspace: fixture.workspace,
      });

      // Then
      expect(catalog.skills).toEqual([]);
      expect(catalog.audits[0]?.findings).toContainEqual(
        expect.objectContaining({
          severity: "blocker",
          code: "invalid_package",
          message: "SKILL.md resolves outside its declared Skill root",
        }),
      );
      expect(catalog.warnings[0]?.message).not.toContain(outsideContent);
      expect(catalog.warnings[0]?.message).not.toContain(outsideSkillPath);
    } finally {
      await rm(fixture.workspace, { recursive: true, force: true });
    }
  });

  test(`Given the validated Skill root is replaced before its package identity is captured,
    When discovery starts reading the previously enumerated package,
    Then the fixed root identity rejects the replacement`, async () => {
    // Given
    const fixture = await createSkillFixture("keel-skill-root-race-");
    const actualFs = await vi.importActual<FsModule>("node:fs");
    const rootPath = join(fixture.workspace, ".agents", "skills");
    const skillFilePath = join(fixture.skillPath, "SKILL.md");
    const outsideRootPath = join(fixture.workspace, "outside-root");
    const outsideSkillPath = join(outsideRootPath, "review");
    await mkdir(outsideSkillPath, { recursive: true });
    await writeFile(
      join(outsideSkillPath, "SKILL.md"),
      "---\nname: review\ndescription: Outside root.\n---\nOutside.\n",
    );
    let swapped = false;
    const projectSkills = await importProjectSkillsWithFs({
      existsSync: (path) => {
        const exists = actualFs.existsSync(path);
        if (String(path) === skillFilePath && !swapped) {
          actualFs.rmSync(rootPath, { recursive: true });
          actualFs.symlinkSync(outsideRootPath, rootPath);
          swapped = true;
        }
        return exists;
      },
    });

    try {
      // When
      const catalog = projectSkills.discoverSkillCatalog({
        workspace: fixture.workspace,
      });

      // Then
      expect(catalog.skills).toEqual([]);
      expect(catalog.audits[0]?.findings).toContainEqual(
        expect.objectContaining({
          severity: "blocker",
          code: "invalid_package",
          message: "SKILL.md resolves outside its declared Skill root",
        }),
      );
    } finally {
      await rm(fixture.workspace, { recursive: true, force: true });
    }
  });

  test(`Given a Skill package changes immediately after its identity is captured,
    When discovery crosses the first package read boundary,
    Then the fixed package identity rejects the replacement`, async () => {
    // Given
    const fixture = await createSkillFixture(
      "keel-skill-package-capture-race-",
    );
    const actualFs = await vi.importActual<FsModule>("node:fs");
    const outsideSkillPath = join(fixture.workspace, "outside-review");
    await mkdir(outsideSkillPath, { recursive: true });
    await writeFile(
      join(outsideSkillPath, "SKILL.md"),
      "---\nname: review\ndescription: Outside package.\n---\nOutside.\n",
    );
    let swapped = false;
    const projectSkills = await importProjectSkillsWithFs({
      statSync: (path) => {
        const stat = actualFs.statSync(path);
        if (String(path) === fixture.skillPath && !swapped) {
          actualFs.rmSync(fixture.skillPath, { recursive: true });
          actualFs.symlinkSync(outsideSkillPath, fixture.skillPath);
          swapped = true;
        }
        return stat;
      },
    });

    try {
      // When
      const catalog = projectSkills.discoverSkillCatalog({
        workspace: fixture.workspace,
      });

      // Then
      expect(catalog.skills).toEqual([]);
      expect(catalog.audits[0]?.findings).toContainEqual(
        expect.objectContaining({
          severity: "blocker",
          code: "invalid_package",
          message: "SKILL.md resolves outside its declared Skill root",
        }),
      );
    } finally {
      await rm(fixture.workspace, { recursive: true, force: true });
    }
  });

  test(`Given a Skill package changes while its audited resource bytes are inspected,
    When discovery completes deterministic package validation,
    Then the post-audit identity check rejects the changed package`, async () => {
    // Given
    const fixture = await createSkillFixture(
      "keel-skill-package-audit-race-",
    );
    const actualFs = await vi.importActual<FsModule>("node:fs");
    const outsideSkillPath = join(fixture.workspace, "outside-review");
    await mkdir(outsideSkillPath, { recursive: true });
    await writeFile(
      join(outsideSkillPath, "SKILL.md"),
      "---\nname: review\ndescription: Outside package.\n---\nOutside.\n",
    );
    let swapped = false;
    const projectSkills = await importProjectSkillsWithFs({
      readFileSync: (path) => {
        const bytes = actualFs.readFileSync(path);
        if (String(path) === fixture.resourcePath && !swapped) {
          actualFs.rmSync(fixture.skillPath, { recursive: true });
          actualFs.symlinkSync(outsideSkillPath, fixture.skillPath);
          swapped = true;
        }
        return bytes;
      },
    });

    try {
      // When
      const catalog = projectSkills.discoverSkillCatalog({
        workspace: fixture.workspace,
      });

      // Then
      expect(catalog.skills).toEqual([]);
      expect(catalog.audits[0]?.findings).toContainEqual(
        expect.objectContaining({
          severity: "blocker",
          code: "invalid_package",
          message: "SKILL.md resolves outside its declared Skill root",
        }),
      );
    } finally {
      await rm(fixture.workspace, { recursive: true, force: true });
    }
  });

  test.each([
    {
      race: "grows beyond the text limit",
      replacementBytes: undefined,
      replacementSize: 50 * 1_024 + 1,
      diagnostic: "is too large to read as text",
    },
    {
      race: "gains binary control bytes beyond the accepted sample",
      replacementBytes: new Uint8Array([0, 0x61]),
      replacementSize: undefined,
      diagnostic: "is a binary resource",
    },
    {
      race: "gains invalid UTF-8 beyond the accepted sample",
      replacementBytes: new Uint8Array([0xc3, 0x28]),
      replacementSize: undefined,
      diagnostic: "is a binary resource",
    },
  ])(
    `Given an audited text resource $race before its authorized read,
      When skill_resource opens and decodes the current file,
      Then the read fails closed with the stable resource diagnostic`,
    async ({ replacementBytes, replacementSize, diagnostic }) => {
      // Given
      const fixture = await createSkillFixture(
        "keel-skill-resource-read-race-",
      );
      const actualFs = await vi.importActual<FsModule>("node:fs");
      const racedFds = new Set<number>();
      const targetReadCounts = new Map<number, number>();
      let raceArmed = false;
      let resourceReaudited = false;
      const projectSkills = await importProjectSkillsWithFs({
        openSync: (path, flags, mode) => {
          const fd = actualFs.openSync(path, flags, mode);
          if (
            String(path) === fixture.resourcePath &&
            raceArmed &&
            resourceReaudited
          ) {
            racedFds.add(fd);
            targetReadCounts.set(fd, 0);
          }
          return fd;
        },
        fstatSync: (fd) => {
          const stat = actualFs.fstatSync(fd);
          return racedFds.has(fd) && replacementSize !== undefined
            ? Object.assign(stat, { size: replacementSize })
            : stat;
        },
        readFileSync: (path) => {
          const result = actualFs.readFileSync(path);
          if (String(path) === fixture.resourcePath && raceArmed) {
            resourceReaudited = true;
          }
          return result;
        },
        readSync: (fd, buffer, offset, length, position) => {
          const readCount = (targetReadCounts.get(fd) ?? 0) + 1;
          targetReadCounts.set(fd, readCount);
          if (
            racedFds.has(fd) &&
            readCount === 2 &&
            replacementBytes !== undefined
          ) {
            if (!Buffer.isBuffer(buffer)) {
              throw new Error("expected the Skill resource read buffer");
            }
            buffer.set(replacementBytes, offset);
            return replacementBytes.length;
          }
          if (!Buffer.isBuffer(buffer)) {
            throw new Error("expected the Skill resource read buffer");
          }
          return actualFs.readSync(fd, buffer, offset, length, position);
        },
      });

      try {
        const catalog = projectSkills.discoverSkillCatalog({
          workspace: fixture.workspace,
        });
        raceArmed = true;

        // When / Then
        expect(() =>
          catalog.readResource("repo:review", "references/guide.md"),
        ).toThrow(diagnostic);
      } finally {
        await rm(fixture.workspace, { recursive: true, force: true });
      }
    },
  );

  test(`Given an audited resource is replaced by an out-of-package symlink before open,
    When skill_resource validates the opened identity,
    Then outside content is rejected with a stable content-free diagnostic`, async () => {
    // Given
    const fixture = await createSkillFixture(
      "keel-skill-resource-symlink-race-",
    );
    const outsidePath = join(fixture.workspace, "outside-secret.txt");
    const outsideContent = "OUTSIDE-RESOURCE-CONTENT";
    await writeFile(outsidePath, outsideContent);
    const actualFs = await vi.importActual<FsModule>("node:fs");
    let raceArmed = false;
    let resourceReaudited = false;
    let swapped = false;
    const projectSkills = await importProjectSkillsWithFs({
      openSync: (path, flags, mode) => {
        if (
          String(path) === fixture.resourcePath &&
          raceArmed &&
          resourceReaudited &&
          !swapped
        ) {
          actualFs.rmSync(fixture.resourcePath);
          actualFs.symlinkSync(outsidePath, fixture.resourcePath);
          swapped = true;
        }
        return actualFs.openSync(path, flags, mode);
      },
      readFileSync: (path) => {
        const result = actualFs.readFileSync(path);
        if (String(path) === fixture.resourcePath && raceArmed) {
          resourceReaudited = true;
        }
        return result;
      },
    });

    try {
      const catalog = projectSkills.discoverSkillCatalog({
        workspace: fixture.workspace,
      });
      raceArmed = true;

      // When
      let message = "";
      try {
        catalog.readResource("repo:review", "references/guide.md");
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      // Then
      expect(message).toContain(
        'workflow skill resource "references/guide.md" changed or became unreadable after package validation',
      );
      expect(message).not.toContain(outsideContent);
      expect(message).not.toContain(outsidePath);
    } finally {
      await rm(fixture.workspace, { recursive: true, force: true });
    }
  });

  test(`Given the whole audited Skill package becomes an outside symlink before resource open,
    When skill_resource validates the opened package identity,
    Then outside resource content is rejected with a stable content-free diagnostic`, async () => {
    // Given
    const fixture = await createSkillFixture(
      "keel-skill-resource-package-race-",
    );
    const outsideSkillPath = join(fixture.workspace, "outside-review");
    const outsideReferencesPath = join(outsideSkillPath, "references");
    const outsideContent = "OUTSIDE-PACKAGE-RESOURCE";
    await mkdir(outsideReferencesPath, { recursive: true });
    await writeFile(
      join(outsideSkillPath, "SKILL.md"),
      "---\nname: review\ndescription: Outside package.\n---\nRead the guide.\n",
    );
    await writeFile(join(outsideReferencesPath, "guide.md"), outsideContent);
    const actualFs = await vi.importActual<FsModule>("node:fs");
    let raceArmed = false;
    let resourceReaudited = false;
    let swapped = false;
    const projectSkills = await importProjectSkillsWithFs({
      openSync: (path, flags, mode) => {
        if (
          String(path) === fixture.resourcePath &&
          raceArmed &&
          resourceReaudited &&
          !swapped
        ) {
          actualFs.rmSync(fixture.skillPath, { recursive: true });
          actualFs.symlinkSync(outsideSkillPath, fixture.skillPath);
          swapped = true;
        }
        return actualFs.openSync(path, flags, mode);
      },
      readFileSync: (path) => {
        const result = actualFs.readFileSync(path);
        if (String(path) === fixture.resourcePath && raceArmed) {
          resourceReaudited = true;
        }
        return result;
      },
    });

    try {
      const catalog = projectSkills.discoverSkillCatalog({
        workspace: fixture.workspace,
      });
      raceArmed = true;

      // When
      let message = "";
      try {
        catalog.readResource("repo:review", "references/guide.md");
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      // Then
      expect(message).toContain(
        'workflow skill resource "references/guide.md" changed or became unreadable after package validation',
      );
      expect(message).not.toContain(outsideContent);
      expect(message).not.toContain(outsideSkillPath);
    } finally {
      await rm(fixture.workspace, { recursive: true, force: true });
    }
  });

  test.each([
    { replacement: "a directory", mode: "directory" },
    { replacement: "a different regular file", mode: "regular" },
  ])(
    `Given an audited resource becomes $replacement at the final open boundary,
      When skill_resource validates the opened type and identity,
      Then the changed target is rejected before any replacement content is returned`,
    async ({ mode }) => {
      // Given
      const fixture = await createSkillFixture(
        "keel-skill-resource-identity-race-",
      );
      const actualFs = await vi.importActual<FsModule>("node:fs");
      let raceArmed = false;
      let resourceReaudited = false;
      let swapped = false;
      const projectSkills = await importProjectSkillsWithFs({
        openSync: (path, flags, openMode) => {
          if (
            String(path) === fixture.resourcePath &&
            raceArmed &&
            resourceReaudited &&
            !swapped
          ) {
            swapped = true;
            if (mode === "directory") {
              actualFs.rmSync(fixture.resourcePath);
              actualFs.mkdirSync(fixture.resourcePath);
              return actualFs.openSync(path, flags, openMode);
            }
            const fd = actualFs.openSync(path, flags, openMode);
            actualFs.rmSync(fixture.resourcePath);
            actualFs.writeFileSync(fixture.resourcePath, "replacement");
            return fd;
          }
          return actualFs.openSync(path, flags, openMode);
        },
        readFileSync: (path) => {
          const result = actualFs.readFileSync(path);
          if (String(path) === fixture.resourcePath && raceArmed) {
            resourceReaudited = true;
          }
          return result;
        },
      });

      try {
        const catalog = projectSkills.discoverSkillCatalog({
          workspace: fixture.workspace,
        });
        raceArmed = true;

        // When / Then
        expect(() =>
          catalog.readResource("repo:review", "references/guide.md"),
        ).toThrow("changed or became unreadable after package validation");
      } finally {
        await rm(fixture.workspace, { recursive: true, force: true });
      }
    },
  );

  test.each([
    { stage: "open", code: "ENOENT" },
    { stage: "metadata read", code: "EIO" },
    { stage: "content read", code: "EIO" },
  ])(
    `Given an audited resource hits a late $stage filesystem failure,
      When skill_resource crosses the final read boundary,
      Then it returns a stable diagnostic without exposing an absolute path`,
    async ({ stage, code }) => {
      // Given
      const fixture = await createSkillFixture(
        "keel-skill-resource-errno-race-",
      );
      const actualFs = await vi.importActual<FsModule>("node:fs");
      const racedFds = new Set<number>();
      let raceArmed = false;
      let resourceReaudited = false;
      const projectSkills = await importProjectSkillsWithFs({
        openSync: (path, flags, mode) => {
          if (
            String(path) === fixture.resourcePath &&
            raceArmed &&
            resourceReaudited
          ) {
            if (stage === "open") throw new TestNodeError(code);
            const fd = actualFs.openSync(path, flags, mode);
            racedFds.add(fd);
            return fd;
          }
          return actualFs.openSync(path, flags, mode);
        },
        fstatSync: (fd) => {
          if (racedFds.has(fd) && stage === "metadata read") {
            throw new TestNodeError(code);
          }
          return actualFs.fstatSync(fd);
        },
        readFileSync: (path) => {
          const result = actualFs.readFileSync(path);
          if (String(path) === fixture.resourcePath && raceArmed) {
            resourceReaudited = true;
          }
          return result;
        },
        readSync: (fd, buffer, offset, length, position) => {
          if (racedFds.has(fd) && stage === "content read") {
            throw new TestNodeError(code);
          }
          if (!Buffer.isBuffer(buffer)) {
            throw new Error("expected the Skill resource read buffer");
          }
          return actualFs.readSync(fd, buffer, offset, length, position);
        },
      });

      try {
        const catalog = projectSkills.discoverSkillCatalog({
          workspace: fixture.workspace,
        });
        raceArmed = true;

        // When
        let message = "";
        try {
          catalog.readResource("repo:review", "references/guide.md");
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }

        // Then
        expect(message).toContain(
          'workflow skill resource "references/guide.md" changed or became unreadable after package validation',
        );
        expect(message).not.toContain(fixture.resourcePath);
      } finally {
        await rm(fixture.workspace, { recursive: true, force: true });
      }
    },
  );

  test(`Given SKILL.md becomes unreadable during deterministic validation,
    When discovery encounters the filesystem errno,
    Then the package is recorded as invalid without leaking the platform failure`, async () => {
    // Given
    const fixture = await createSkillFixture("keel-skill-validation-errno-");
    const actualFs = await vi.importActual<FsModule>("node:fs");
    const skillFilePath = join(fixture.skillPath, "SKILL.md");
    const skillFds = new Set<number>();
    const projectSkills = await importProjectSkillsWithFs({
      openSync: (path, flags, mode) => {
        const fd = actualFs.openSync(path, flags, mode);
        if (String(path) === skillFilePath) skillFds.add(fd);
        return fd;
      },
      fstatSync: (fd) => {
        if (skillFds.has(fd)) throw new TestNodeError("EIO");
        return actualFs.fstatSync(fd);
      },
    });

    try {
      // When
      const catalog = projectSkills.discoverSkillCatalog({
        workspace: fixture.workspace,
      });

      // Then
      expect(catalog.skills).toEqual([]);
      expect(catalog.audits[0]?.findings).toContainEqual(
        expect.objectContaining({
          severity: "blocker",
          code: "invalid_package",
          message:
            "Skill package files could not be read during deterministic validation",
        }),
      );
    } finally {
      await rm(fixture.workspace, { recursive: true, force: true });
    }
  });
});
