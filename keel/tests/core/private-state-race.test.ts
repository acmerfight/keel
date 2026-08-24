import type { PathLike, Stats } from "node:fs";
import {
  chmodSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

type FsModule = typeof import("node:fs");

interface FsOverrides {
  readonly fstatSync?: (fd: number) => Stats;
  readonly ftruncateSync?: (fd: number, len?: number) => void;
  readonly lstatSync?: (
    path: PathLike,
    options: { readonly throwIfNoEntry: false },
  ) => Stats | undefined;
  readonly mkdirSync?: (
    path: PathLike,
    options?: {
      readonly mode?: number | string;
      readonly recursive?: boolean;
    },
  ) => string | undefined;
  readonly openSync?: (
    path: PathLike,
    flags: string | number,
    mode?: string | number | null,
  ) => number;
}

async function importPrivateStateWithFs(
  overrides: FsOverrides,
): Promise<typeof import("../../src/core/private-state.ts")> {
  vi.resetModules();
  const actualFs = await vi.importActual<FsModule>("node:fs");
  vi.doMock("node:fs", () => ({ ...actualFs, ...overrides }));
  return import("../../src/core/private-state.ts");
}

function runtimeFor(home: string): { readonly env: (key: string) => string } {
  return { env: () => home };
}

function filesystemError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

describe("Private State Race Handling", () => {
  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.restoreAllMocks();
    vi.resetModules();
  });

  test(`Given the state owner cannot inspect KEEL_HOME,
    When a private directory is resolved,
    Then it surfaces the filesystem failure instead of treating the root as missing`, async () => {
    // Given
    const home = join(tmpdir(), `keel-private-uninspectable-${Date.now()}`);
    const actualFs = await vi.importActual<FsModule>("node:fs");
    const privateState = await importPrivateStateWithFs({
      lstatSync: (path, options) => {
        if (String(path) === home) throw filesystemError("EACCES", "denied");
        return actualFs.lstatSync(path, options);
      },
    });

    // When / Then
    expect(() =>
      privateState.privateStateDirectoryPath(runtimeFor(home), [], "KEEL_HOME"),
    ).toThrow(/cannot inspect KEEL_HOME.*denied/u);
  });

  test(`Given another process creates KEEL_HOME after it is observed missing,
    When Keel ensures the private root,
    Then an EEXIST creation race is accepted only after the directory is inspected`, async () => {
    // Given
    const parent = mkdtempSync(join(tmpdir(), "keel-private-mkdir-race-"));
    const home = join(parent, "home");
    const actualFs = await vi.importActual<FsModule>("node:fs");
    let raced = false;
    const privateState = await importPrivateStateWithFs({
      mkdirSync: (path, options) => {
        const result = actualFs.mkdirSync(path, options);
        if (!raced && String(path) === home) {
          raced = true;
          throw filesystemError("EEXIST", "created concurrently");
        }
        return result;
      },
    });

    try {
      // When / Then
      expect(
        privateState.ensurePrivateStateDirectory(
          runtimeFor(home),
          [],
          "KEEL_HOME",
        ),
      ).toBe(home);
      expect(raced).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test(`Given KEEL_HOME creation fails for a reason other than a concurrent create,
    When Keel ensures the private root,
    Then it rejects the filesystem failure`, async () => {
    // Given
    const home = join(tmpdir(), `keel-private-mkdir-denied-${Date.now()}`);
    const privateState = await importPrivateStateWithFs({
      mkdirSync: () => {
        throw filesystemError("EACCES", "denied");
      },
    });

    // When / Then
    expect(() =>
      privateState.ensurePrivateStateDirectory(
        runtimeFor(home),
        [],
        "KEEL_HOME",
      ),
    ).toThrow(/cannot create KEEL_HOME.*denied/u);
  });

  test(`Given a required private directory and private filename are absent,
    When callers require the directory or omit the filename,
    Then the state owner rejects both invalid boundaries`, async () => {
    // Given
    const home = mkdtempSync(join(tmpdir(), "keel-private-invalid-path-"));
    const privateState = await importPrivateStateWithFs({});

    try {
      // When / Then
      expect(() =>
        privateState.requirePrivateDirectory(
          join(home, "missing"),
          "required root",
        ),
      ).toThrow(/does not exist/u);
      expect(() =>
        privateState.readPrivateStateFile({
          runtime: runtimeFor(home),
          segments: [],
          label: "provider auth",
        }),
      ).toThrow(/must name a file/u);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test(`Given a secret file cannot be inspected,
    When Keel reads it,
    Then it reports the inspection failure without attempting an open`, async () => {
    // Given
    const home = mkdtempSync(join(tmpdir(), "keel-private-file-inspect-"));
    const authPath = join(home, "auth.json");
    const actualFs = await vi.importActual<FsModule>("node:fs");
    const privateState = await importPrivateStateWithFs({
      lstatSync: (path, options) => {
        if (String(path) === authPath) {
          throw filesystemError("EACCES", "denied");
        }
        return actualFs.lstatSync(path, options);
      },
    });

    try {
      // When / Then
      expect(() =>
        privateState.readPrivateStateFile({
          runtime: runtimeFor(home),
          segments: ["auth.json"],
          label: "provider auth",
        }),
      ).toThrow(/cannot inspect provider auth.*denied/u);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test(`Given an opened secret descriptor cannot be inspected,
    When Keel validates the descriptor before reading,
    Then it fails closed`, async () => {
    // Given
    const home = mkdtempSync(join(tmpdir(), "keel-private-fstat-error-"));
    writeFileSync(join(home, "auth.json"), "secret\n", "utf8");
    const privateState = await importPrivateStateWithFs({
      fstatSync: () => {
        throw filesystemError("EIO", "broken descriptor");
      },
    });

    try {
      // When / Then
      expect(() =>
        privateState.readPrivateStateFile({
          runtime: runtimeFor(home),
          segments: ["auth.json"],
          label: "provider auth",
        }),
      ).toThrow(/cannot inspect opened provider auth.*broken descriptor/u);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test.each([
    ["non-file descriptor", false, 1, /must be a regular file/u],
    ["shared descriptor inode", true, 2, /exactly one hard link/u],
  ])(
    `Given an opened secret resolves to a %s,
    When Keel validates the descriptor,
    Then it rejects the descriptor before reading bytes`,
    async (_case, isFile, nlink, expected) => {
      // Given
      const home = mkdtempSync(join(tmpdir(), "keel-private-fstat-shape-"));
      writeFileSync(join(home, "auth.json"), "secret\n", "utf8");
      const actualFs = await vi.importActual<FsModule>("node:fs");
      const privateState = await importPrivateStateWithFs({
        fstatSync: (fd) => {
          const stats = actualFs.fstatSync(fd);
          return new Proxy(stats, {
            get: (target, property, receiver) => {
              if (property === "isFile") return () => isFile;
              if (property === "nlink") return nlink;
              return Reflect.get(target, property, receiver);
            },
          });
        },
      });

      try {
        // When / Then
        expect(() =>
          privateState.readPrivateStateFile({
            runtime: runtimeFor(home),
            segments: ["auth.json"],
            label: "provider auth",
          }),
        ).toThrow(expected);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  );

  test(`Given KEEL_HOME is replaced after validation but before a secret file is opened,
    When Keel reads provider authentication,
    Then it rejects the changed parent identity before reading redirected bytes`, async () => {
    // Given
    const parent = mkdtempSync(join(tmpdir(), "keel-private-parent-race-"));
    const home = join(parent, "home");
    const parkedHome = join(parent, "parked-home");
    const outside = join(parent, "outside");
    const authPath = join(home, "auth.json");
    mkdirSync(home);
    mkdirSync(outside);
    writeFileSync(authPath, "trusted\n", "utf8");
    writeFileSync(join(outside, "auth.json"), "redirected-secret\n", "utf8");
    const actualFs = await vi.importActual<FsModule>("node:fs");
    let swapped = false;
    const privateState = await importPrivateStateWithFs({
      openSync: (path, flags, mode) => {
        if (!swapped && String(path) === authPath) {
          swapped = true;
          renameSync(home, parkedHome);
          symlinkSync(outside, home, "dir");
        }
        return actualFs.openSync(path, flags, mode);
      },
    });

    try {
      // When / Then
      expect(() =>
        privateState.readPrivateStateFile({
          runtime: runtimeFor(home),
          segments: ["auth.json"],
          label: "provider auth",
        }),
      ).toThrow(/changed during access/u);
      expect(swapped).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test(`Given an existing secret file is replaced after lstat but before open,
    When Keel reads provider authentication,
    Then it rejects the opened replacement identity`, async () => {
    // Given
    const home = mkdtempSync(join(tmpdir(), "keel-private-file-race-"));
    const authPath = join(home, "auth.json");
    const parkedPath = join(home, "parked-auth.json");
    writeFileSync(authPath, "trusted\n", "utf8");
    const actualFs = await vi.importActual<FsModule>("node:fs");
    let swapped = false;
    const privateState = await importPrivateStateWithFs({
      openSync: (path, flags, mode) => {
        if (!swapped && String(path) === authPath) {
          swapped = true;
          renameSync(authPath, parkedPath);
          writeFileSync(authPath, "replacement-secret\n", "utf8");
        }
        return actualFs.openSync(path, flags, mode);
      },
    });

    try {
      // When / Then
      expect(() =>
        privateState.readPrivateStateFile({
          runtime: runtimeFor(home),
          segments: ["auth.json"],
          label: "provider auth",
        }),
      ).toThrow(/changed during access/u);
      expect(swapped).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test(`Given KEEL_HOME is replaced only after the secret descriptor is opened,
    When Keel verifies the validated directory identity,
    Then it rejects the changed parent before reading`, async () => {
    // Given
    const parent = mkdtempSync(join(tmpdir(), "keel-private-parent-fstat-"));
    const home = join(parent, "home");
    const parkedHome = join(parent, "parked-home");
    const authPath = join(home, "auth.json");
    mkdirSync(home);
    writeFileSync(authPath, "trusted\n", "utf8");
    const actualFs = await vi.importActual<FsModule>("node:fs");
    let swapped = false;
    const privateState = await importPrivateStateWithFs({
      fstatSync: (fd) => {
        const stats = actualFs.fstatSync(fd);
        if (!swapped) {
          swapped = true;
          renameSync(home, parkedHome);
          mkdirSync(home);
        }
        return stats;
      },
    });

    try {
      // When / Then
      expect(() =>
        privateState.readPrivateStateFile({
          runtime: runtimeFor(home),
          segments: ["auth.json"],
          label: "provider auth",
        }),
      ).toThrow(/parent .*changed during access/u);
      expect(swapped).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test(`Given the secret path is replaced after its descriptor is inspected,
    When Keel verifies the current directory entry,
    Then it rejects the replacement before reading`, async () => {
    // Given
    const home = mkdtempSync(join(tmpdir(), "keel-private-path-fstat-"));
    const authPath = join(home, "auth.json");
    const parkedPath = join(home, "parked-auth.json");
    writeFileSync(authPath, "trusted\n", "utf8");
    const actualFs = await vi.importActual<FsModule>("node:fs");
    let swapped = false;
    const privateState = await importPrivateStateWithFs({
      fstatSync: (fd) => {
        const stats = actualFs.fstatSync(fd);
        if (!swapped) {
          swapped = true;
          renameSync(authPath, parkedPath);
          writeFileSync(authPath, "replacement\n", "utf8");
        }
        return stats;
      },
    });

    try {
      // When / Then
      expect(() =>
        privateState.readPrivateStateFile({
          runtime: runtimeFor(home),
          segments: ["auth.json"],
          label: "provider auth",
        }),
      ).toThrow(/provider auth .*changed during access/u);
      expect(swapped).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test(`Given a secret becomes a symlink after lstat but before open,
    When O_NOFOLLOW rejects the changed directory entry,
    Then Keel reports the link and preserves its target`, async () => {
    // Given
    const home = mkdtempSync(join(tmpdir(), "keel-private-open-link-"));
    const authPath = join(home, "auth.json");
    const targetPath = join(home, "target.json");
    writeFileSync(authPath, "trusted\n", "utf8");
    writeFileSync(targetPath, "outside\n", "utf8");
    const actualFs = await vi.importActual<FsModule>("node:fs");
    let swapped = false;
    const privateState = await importPrivateStateWithFs({
      openSync: (path, flags, mode) => {
        if (!swapped && String(path) === authPath) {
          swapped = true;
          rmSync(authPath);
          symlinkSync(targetPath, authPath, "file");
        }
        return actualFs.openSync(path, flags, mode);
      },
    });

    try {
      // When / Then
      expect(() =>
        privateState.readPrivateStateFile({
          runtime: runtimeFor(home),
          segments: ["auth.json"],
          label: "provider auth",
        }),
      ).toThrow(/must not be a symbolic link/u);
      expect(readFileSync(targetPath, "utf8")).toBe("outside\n");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test(`Given a secret disappears after lstat but before open,
    When Keel performs a no-follow read,
    Then it returns the latest missing-file state`, async () => {
    // Given
    const home = mkdtempSync(join(tmpdir(), "keel-private-open-missing-"));
    const authPath = join(home, "auth.json");
    writeFileSync(authPath, "trusted\n", "utf8");
    const actualFs = await vi.importActual<FsModule>("node:fs");
    let removed = false;
    const privateState = await importPrivateStateWithFs({
      openSync: (path, flags, mode) => {
        if (!removed && String(path) === authPath) {
          removed = true;
          rmSync(authPath);
        }
        return actualFs.openSync(path, flags, mode);
      },
    });

    try {
      // When / Then
      expect(
        privateState.readPrivateStateFile({
          runtime: runtimeFor(home),
          segments: ["auth.json"],
          label: "provider auth",
        }),
      ).toBeNull();
      expect(removed).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test(`Given another process creates a secret after Keel observes it missing,
    When Keel attempts first-time publication,
    Then exclusive creation preserves the competing file`, async () => {
    // Given
    const home = mkdtempSync(join(tmpdir(), "keel-private-create-race-"));
    const authPath = join(home, "auth.json");
    const actualFs = await vi.importActual<FsModule>("node:fs");
    let raced = false;
    const privateState = await importPrivateStateWithFs({
      openSync: (path, flags, mode) => {
        if (!raced && String(path) === authPath) {
          raced = true;
          writeFileSync(authPath, "contender\n", "utf8");
        }
        return actualFs.openSync(path, flags, mode);
      },
    });

    try {
      // When / Then
      expect(() =>
        privateState.writePrivateStateFile({
          runtime: runtimeFor(home),
          segments: ["auth.json"],
          label: "provider auth",
          content: "keel-secret\n",
        }),
      ).toThrow(/cannot open provider auth/u);
      expect(readFileSync(authPath, "utf8")).toBe("contender\n");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test(`Given an existing secret file has permissive mode bits,
    When Keel replaces its contents,
    Then it tightens the opened descriptor before truncating or writing bytes`, async () => {
    // Given
    const home = mkdtempSync(join(tmpdir(), "keel-private-mode-order-"));
    const authPath = join(home, "auth.json");
    writeFileSync(authPath, "old\n", "utf8");
    chmodSync(authPath, 0o644);
    const actualFs = await vi.importActual<FsModule>("node:fs");
    let modeAtTruncate: number | undefined;
    const privateState = await importPrivateStateWithFs({
      ftruncateSync: (fd, len) => {
        modeAtTruncate = fstatSync(fd).mode & 0o777;
        actualFs.ftruncateSync(fd, len);
      },
    });

    try {
      // When
      privateState.writePrivateStateFile({
        runtime: runtimeFor(home),
        segments: ["auth.json"],
        label: "provider auth",
        content: "new-secret\n",
      });

      // Then
      expect(modeAtTruncate).toBe(0o600);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
