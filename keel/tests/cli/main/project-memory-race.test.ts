import { mkdtempSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createGitWorkspace } from "../../../src/testing/cli-harness.ts";

type FsModule = typeof import("node:fs");

interface FsOverrides {
  readonly linkSync?: FsModule["linkSync"];
  readonly renameSync?: FsModule["renameSync"];
  readonly rmSync?: FsModule["rmSync"];
  readonly writeSync?: (
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
  ) => number;
}

function errno(code: string): Error & { readonly code: string } {
  return Object.assign(new Error(code), { code });
}

async function importProjectMemoryWithFs(
  overrides: FsOverrides,
): Promise<typeof import("../../../src/cli/project-memory.ts")> {
  vi.resetModules();
  const actualFs = await vi.importActual<FsModule>("node:fs");
  vi.doMock("node:fs", () => ({ ...actualFs, ...overrides }));
  return import("../../../src/cli/project-memory.ts");
}

describe("CLI Project Memory Race Handling", () => {
  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.resetModules();
  });

  test(`Given two local processes discover a Git project before its identity marker is written,
    When they publish competing markers,
    Then both resolve the same complete project identity`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-memory-marker-race-");
    const keelHome = mkdtempSync(join(tmpdir(), "keel-memory-race-home-"));
    const runtime = {
      env: (key: string) => (key === "KEEL_HOME" ? keelHome : undefined),
      now: () => 0,
    };
    const actualFs = await vi.importActual<FsModule>("node:fs");
    let raced = false;
    let contenderScope: string | undefined;
    let runContender: (() => string) | undefined;
    const projectMemory = await importProjectMemoryWithFs({
      writeSync: (fd, buffer, offset, length) => {
        if (!raced) {
          raced = true;
          if (runContender === undefined) {
            throw new Error("marker contender was not installed");
          }
          contenderScope = runContender();
        }
        return actualFs.writeSync(fd, buffer, offset, length);
      },
    });
    runContender = () =>
      projectMemory.loadRenderedProjectMemory(runtime, workspace).scope.id;

    try {
      // When
      const firstScope = projectMemory.loadRenderedProjectMemory(
        runtime,
        workspace,
      ).scope.id;

      // Then
      expect(raced).toBe(true);
      expect(contenderScope).toBe(firstScope);
      const markerDirectory = join(workspace, ".git", "keel");
      expect(await readdir(markerDirectory)).toEqual(["project-id"]);
      expect(
        (await readFile(join(markerDirectory, "project-id"), "utf8")).trim(),
      ).toBe(firstScope);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(keelHome, { recursive: true, force: true });
    }
  });

  test(`Given a competing process publishes an invalid identity marker,
    When Keel loses the atomic publication race,
    Then it rejects the incomplete identity without hiding the corruption`, async () => {
    // Given
    const workspace = await createGitWorkspace(
      "keel-memory-invalid-marker-race-",
    );
    const keelHome = mkdtempSync(join(tmpdir(), "keel-memory-race-home-"));
    const runtime = {
      env: (key: string) => (key === "KEEL_HOME" ? keelHome : undefined),
      now: () => 0,
    };
    const actualFs = await vi.importActual<FsModule>("node:fs");
    const projectMemory = await importProjectMemoryWithFs({
      linkSync: (_candidatePath, markerPath) => {
        actualFs.writeFileSync(markerPath, "not-a-uuid\n", "utf8");
        throw errno("EEXIST");
      },
    });

    try {
      // When / Then
      expect(() =>
        projectMemory.loadRenderedProjectMemory(runtime, workspace),
      ).toThrow("invalid project memory identity marker");
      expect(await readdir(join(workspace, ".git", "keel"))).toEqual([
        "project-id",
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(keelHome, { recursive: true, force: true });
    }
  });

  test(`Given the filesystem cannot publish a complete identity marker,
    When first-time project discovery reaches the atomic publish step,
    Then Keel reports the failure and removes the private candidate`, async () => {
    // Given
    const workspace = await createGitWorkspace(
      "keel-memory-marker-publish-failure-",
    );
    const keelHome = mkdtempSync(join(tmpdir(), "keel-memory-race-home-"));
    const runtime = {
      env: (key: string) => (key === "KEEL_HOME" ? keelHome : undefined),
      now: () => 0,
    };
    const projectMemory = await importProjectMemoryWithFs({
      linkSync: () => {
        throw errno("EIO");
      },
    });

    try {
      // When / Then
      expect(() =>
        projectMemory.loadRenderedProjectMemory(runtime, workspace),
      ).toThrow("cannot create project memory identity marker");
      expect(await readdir(join(workspace, ".git", "keel"))).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(keelHome, { recursive: true, force: true });
    }
  });

  test(`Given the filesystem fails while writing a private identity candidate,
    When first-time project discovery still owns the open descriptor,
    Then Keel closes it and removes the incomplete candidate`, async () => {
    // Given
    const workspace = await createGitWorkspace(
      "keel-memory-marker-write-failure-",
    );
    const keelHome = mkdtempSync(join(tmpdir(), "keel-memory-race-home-"));
    const runtime = {
      env: (key: string) => (key === "KEEL_HOME" ? keelHome : undefined),
      now: () => 0,
    };
    const projectMemory = await importProjectMemoryWithFs({
      writeSync: () => {
        throw errno("EIO");
      },
    });

    try {
      // When / Then
      expect(() =>
        projectMemory.loadRenderedProjectMemory(runtime, workspace),
      ).toThrow("cannot create project memory identity marker");
      expect(await readdir(join(workspace, ".git", "keel"))).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(keelHome, { recursive: true, force: true });
    }
  });

  test(`Given a complete project-memory generation exists,
    When atomic purge replacement fails before publication,
    Then Keel reports failure and preserves only the old complete generation`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-memory-purge-failure-");
    const keelHome = mkdtempSync(join(tmpdir(), "keel-memory-race-home-"));
    const runtime = {
      env: (key: string) => (key === "KEEL_HOME" ? keelHome : undefined),
      now: () => 0,
    };
    const projectMemory = await importProjectMemoryWithFs({
      renameSync: () => {
        throw errno("EIO");
      },
    });
    const saved = projectMemory.addProjectMemory(
      runtime,
      workspace,
      "Atomic purge target.",
      {
        type: "user_explicit",
        channel: "cli",
        evidence: "memory add Atomic purge target.",
      },
      { reviewAfter: null, expiresAt: null },
    );
    const projectDirectory = join(
      keelHome,
      "memory",
      "projects",
      saved.scope.id,
    );
    const eventsPath = join(projectDirectory, "events.jsonl");
    const before = await readFile(eventsPath, "utf8");

    try {
      // When / Then
      expect(() =>
        projectMemory.purgeProjectMemory(runtime, workspace, saved.entry.id, {
          type: "user_explicit",
          channel: "cli",
          evidence: `memory purge ${saved.entry.id}`,
        }),
      ).toThrow("cannot atomically purge project memory");
      expect(await readFile(eventsPath, "utf8")).toBe(before);
      expect(await readdir(projectDirectory)).toEqual(["events.jsonl"]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(keelHome, { recursive: true, force: true });
    }
  });

  test(`Given atomic purge fails while its private generation is still open,
    When Keel cleans up the failed replacement,
    Then it closes the descriptor and preserves only the old complete generation`, async () => {
    // Given
    const workspace = await createGitWorkspace(
      "keel-memory-purge-write-failure-",
    );
    const keelHome = mkdtempSync(join(tmpdir(), "keel-memory-race-home-"));
    const runtime = {
      env: (key: string) => (key === "KEEL_HOME" ? keelHome : undefined),
      now: () => 0,
    };
    const actualFs = await vi.importActual<FsModule>("node:fs");
    let failAtomicWrite = false;
    const projectMemory = await importProjectMemoryWithFs({
      writeSync: (fd, buffer, offset, length) => {
        if (failAtomicWrite) throw errno("EIO");
        return actualFs.writeSync(fd, buffer, offset, length);
      },
    });
    const saved = projectMemory.addProjectMemory(
      runtime,
      workspace,
      "Atomic purge write target.",
      {
        type: "user_explicit",
        channel: "cli",
        evidence: "memory add Atomic purge write target.",
      },
      { reviewAfter: null, expiresAt: null },
    );
    projectMemory.addProjectMemory(
      runtime,
      workspace,
      "Atomic purge write survivor.",
      {
        type: "user_explicit",
        channel: "cli",
        evidence: "memory add Atomic purge write survivor.",
      },
      { reviewAfter: null, expiresAt: null },
    );
    const projectDirectory = join(
      keelHome,
      "memory",
      "projects",
      saved.scope.id,
    );
    const eventsPath = join(projectDirectory, "events.jsonl");
    const before = await readFile(eventsPath, "utf8");
    failAtomicWrite = true;

    try {
      // When / Then
      expect(() =>
        projectMemory.purgeProjectMemory(runtime, workspace, saved.entry.id, {
          type: "user_explicit",
          channel: "cli",
          evidence: `memory purge ${saved.entry.id}`,
        }),
      ).toThrow("cannot atomically purge project memory");
      expect(await readFile(eventsPath, "utf8")).toBe(before);
      expect(await readdir(projectDirectory)).toEqual(["events.jsonl"]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(keelHome, { recursive: true, force: true });
    }
  });

  test(`Given the filesystem refuses to remove a complete memory store,
    When Keel purges all project memory,
    Then it reports the failure and preserves the complete store`, async () => {
    // Given
    const workspace = await createGitWorkspace(
      "keel-memory-purge-all-failure-",
    );
    const keelHome = mkdtempSync(join(tmpdir(), "keel-memory-race-home-"));
    const runtime = {
      env: (key: string) => (key === "KEEL_HOME" ? keelHome : undefined),
      now: () => 0,
    };
    const actualFs = await vi.importActual<FsModule>("node:fs");
    let failStoreRemoval = false;
    const projectMemory = await importProjectMemoryWithFs({
      rmSync: (path, options) => {
        if (failStoreRemoval && String(path).endsWith("events.jsonl")) {
          throw errno("EIO");
        }
        actualFs.rmSync(path, options);
      },
    });
    const saved = projectMemory.addProjectMemory(
      runtime,
      workspace,
      "Purge-all survivor.",
      {
        type: "user_explicit",
        channel: "cli",
        evidence: "memory add Purge-all survivor.",
      },
      { reviewAfter: null, expiresAt: null },
    );
    const eventsPath = join(
      keelHome,
      "memory",
      "projects",
      saved.scope.id,
      "events.jsonl",
    );
    const before = await readFile(eventsPath, "utf8");
    failStoreRemoval = true;

    try {
      // When / Then
      expect(() =>
        projectMemory.purgeAllProjectMemory(runtime, workspace),
      ).toThrow("cannot atomically purge all project memory");
      expect(await readFile(eventsPath, "utf8")).toBe(before);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(keelHome, { recursive: true, force: true });
    }
  });
});
