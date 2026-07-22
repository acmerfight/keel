import type { Dirent, PathLike } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

type FsModule = typeof import("node:fs");

interface FsOverrides {
  readonly fstatSync?: FsModule["fstatSync"];
  readonly lstatSync?: FsModule["lstatSync"];
  readonly openSync?: FsModule["openSync"];
  readonly opendirSync?: FsModule["opendirSync"];
  readonly readFileSync?: FsModule["readFileSync"];
  readonly readSync?: FsModule["readSync"];
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

function fakeDirectory(
  readSync: () => Dirent | null,
): ReturnType<FsModule["opendirSync"]> {
  return {
    readSync,
    closeSync: () => undefined,
  } as unknown as ReturnType<FsModule["opendirSync"]>;
}

describe("Project Skill Package Race Handling", () => {
  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.restoreAllMocks();
    vi.resetModules();
  });

  test(`Given a package resource directory yields a device or socket entry,
    When discovery inventories the bounded package contents,
    Then the non-regular entry blocks the package without advertising a readable path`, async () => {
    // Given
    const fixture = await createSkillFixture("keel-skill-special-entry-");
    const actualFs = await vi.importActual<FsModule>("node:fs");
    let emitted = false;
    const projectSkills = await importProjectSkillsWithFs({
      opendirSync: ((path: PathLike) => {
        if (String(path) !== fixture.referencesPath) {
          return actualFs.opendirSync(path);
        }
        return fakeDirectory(() => {
          if (emitted) return null;
          emitted = true;
          return {
            name: "device",
            isSymbolicLink: () => false,
            isDirectory: () => false,
            isFile: () => false,
          } as Dirent;
        });
      }) as FsModule["opendirSync"],
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
        relativePath: "references/device",
        message:
          "is not a regular file or directory and cannot be audited safely",
      });
    } finally {
      await rm(fixture.workspace, { recursive: true, force: true });
    }
  });

  test(`Given a resource directory becomes unreadable after it is opened,
    When discovery continues its deterministic inventory,
    Then the incomplete scan blocks the package with a content-free diagnostic`, async () => {
    // Given
    const fixture = await createSkillFixture("keel-skill-directory-read-race-");
    const actualFs = await vi.importActual<FsModule>("node:fs");
    const projectSkills = await importProjectSkillsWithFs({
      opendirSync: ((path: PathLike) =>
        String(path) === fixture.referencesPath
          ? fakeDirectory(() => {
              throw new TestNodeError("EIO");
            })
          : actualFs.opendirSync(path)) as FsModule["opendirSync"],
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
      lstatSync: ((
        path: PathLike,
        options?: { readonly throwIfNoEntry?: boolean },
      ) => {
        if (String(path) === fixture.resourcePath) {
          return Object.assign(actualFs.lstatSync(path), {
            isFile: () => false,
          });
        }
        return actualFs.lstatSync(path, options);
      }) as FsModule["lstatSync"],
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
      const fixture = await createSkillFixture("keel-skill-resource-read-race-");
      const actualFs = await vi.importActual<FsModule>("node:fs");
      const racedFds = new Set<number>();
      const targetReadCounts = new Map<number, number>();
      let raceArmed = false;
      let resourceReaudited = false;
      const projectSkills = await importProjectSkillsWithFs({
        openSync: ((path: PathLike, flags: string | number, mode?: number) => {
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
        }) as FsModule["openSync"],
        fstatSync: ((fd: number) => {
          const stat = actualFs.fstatSync(fd);
          return racedFds.has(fd) && replacementSize !== undefined
            ? Object.assign(stat, { size: replacementSize })
            : stat;
        }) as FsModule["fstatSync"],
        readFileSync: ((path: PathLike) => {
          const result = actualFs.readFileSync(path);
          if (String(path) === fixture.resourcePath && raceArmed) {
            resourceReaudited = true;
          }
          return result;
        }) as FsModule["readFileSync"],
        readSync: ((
          fd: number,
          buffer: NodeJS.ArrayBufferView,
          offset: number,
          length: number,
          position: number | null,
        ) => {
          const readCount = (targetReadCounts.get(fd) ?? 0) + 1;
          targetReadCounts.set(fd, readCount);
          if (
            racedFds.has(fd) &&
            readCount === 2 &&
            replacementBytes !== undefined
          ) {
            const target = buffer as Uint8Array;
            target.set(replacementBytes, offset);
            return replacementBytes.length;
          }
          return actualFs.readSync(
            fd,
            buffer as Buffer,
            offset,
            length,
            position,
          );
        }) as FsModule["readSync"],
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

  test(`Given SKILL.md becomes unreadable during deterministic validation,
    When discovery encounters the filesystem errno,
    Then the package is recorded as invalid without leaking the platform failure`, async () => {
    // Given
    const fixture = await createSkillFixture("keel-skill-validation-errno-");
    const actualFs = await vi.importActual<FsModule>("node:fs");
    const skillFilePath = join(fixture.skillPath, "SKILL.md");
    const skillFds = new Set<number>();
    const projectSkills = await importProjectSkillsWithFs({
      openSync: ((path: PathLike, flags: string | number, mode?: number) => {
        const fd = actualFs.openSync(path, flags, mode);
        if (String(path) === skillFilePath) skillFds.add(fd);
        return fd;
      }) as FsModule["openSync"],
      fstatSync: ((fd: number) => {
        if (skillFds.has(fd)) throw new TestNodeError("EIO");
        return actualFs.fstatSync(fd);
      }) as FsModule["fstatSync"],
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

  test(`Given deterministic validation encounters an unexpected implementation fault,
    When project discovery crosses the package boundary,
    Then the original error identity propagates to the runtime boundary`, async () => {
    // Given
    const fixture = await createSkillFixture("keel-skill-validation-fault-");
    const actualFs = await vi.importActual<FsModule>("node:fs");
    const skillFilePath = join(fixture.skillPath, "SKILL.md");
    const skillFds = new Set<number>();
    const fault = new TypeError("unexpected Skill validation fault");
    const projectSkills = await importProjectSkillsWithFs({
      openSync: ((path: PathLike, flags: string | number, mode?: number) => {
        const fd = actualFs.openSync(path, flags, mode);
        if (String(path) === skillFilePath) skillFds.add(fd);
        return fd;
      }) as FsModule["openSync"],
      fstatSync: ((fd: number) => {
        if (skillFds.has(fd)) throw fault;
        return actualFs.fstatSync(fd);
      }) as FsModule["fstatSync"],
    });

    try {
      // When / Then
      let observed: unknown;
      try {
        projectSkills.discoverSkillCatalog({ workspace: fixture.workspace });
      } catch (error) {
        observed = error;
      }
      expect(observed).toBe(fault);
    } finally {
      await rm(fixture.workspace, { recursive: true, force: true });
    }
  });
});
