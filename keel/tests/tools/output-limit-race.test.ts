import { existsSync, type PathLike } from "node:fs";
import { afterEach, describe, expect, test, vi } from "vitest";

type FsModule = typeof import("node:fs");

interface FsOverrides {
  readonly openSync?: (
    path: PathLike,
    flags: string | number,
    mode?: string | number | null,
  ) => number;
  readonly readFileSync?: (path: PathLike, encoding: BufferEncoding) => string;
  readonly writeSync?: (
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
  ) => number;
}

async function importOutputLimitWithFs(
  overrides: FsOverrides,
): Promise<typeof import("../../src/tools/output-limit.ts")> {
  vi.resetModules();
  const actualFs = await vi.importActual<FsModule>("node:fs");
  vi.doMock("node:fs", () => ({ ...actualFs, ...overrides }));
  return import("../../src/tools/output-limit.ts");
}

function expectDirectoryRemoved(directory: string | undefined): void {
  expect(directory).toBeDefined();
  if (directory === undefined) {
    throw new Error("Expected a temporary capture directory");
  }
  expect(existsSync(directory)).toBe(false);
}

describe("Temporary Output Capture Race Handling", () => {
  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.resetModules();
  });

  test(`Given temporary storage cannot be opened,
    When buffered output needs to spill from memory,
    Then capture reports the filesystem failure and removes its directory`, async () => {
    let captureDirectory: string | undefined;
    const { TempFileByteOutputCapture } = await importOutputLimitWithFs({
      openSync: (path) => {
        captureDirectory = String(path).replace(/[/\\]output\.bin$/u, "");
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      },
    });
    const output = new TempFileByteOutputCapture(
      "keel-output-open-race-",
      10,
      1,
    );

    expect(() => output.append(Buffer.from("blocked"))).toThrowError("EACCES");
    expectDirectoryRemoved(captureDirectory);
  });

  test(`Given a temporary output write makes no progress,
    When capture backfills buffered output,
    Then it rejects the stalled write and removes its directory`, async () => {
    const actualFs = await vi.importActual<FsModule>("node:fs");
    let captureDirectory: string | undefined;
    const { TempFileByteOutputCapture } = await importOutputLimitWithFs({
      openSync: (path, flags, mode) => {
        captureDirectory = String(path).replace(/[/\\]output\.bin$/u, "");
        return actualFs.openSync(path, flags, mode);
      },
      writeSync: () => 0,
    });
    const output = new TempFileByteOutputCapture(
      "keel-output-write-race-",
      10,
      1,
    );
    output.append(Buffer.from("a"));

    expect(() => output.append(Buffer.from("b"))).toThrowError(
      "temporary output capture write made no progress",
    );
    expectDirectoryRemoved(captureDirectory);
  });

  test(`Given a spilled capture file becomes unreadable,
    When capture finalizes the artifact,
    Then it reports the read failure and still removes temporary storage`, async () => {
    const actualFs = await vi.importActual<FsModule>("node:fs");
    let captureDirectory: string | undefined;
    const { TempFileByteOutputCapture } = await importOutputLimitWithFs({
      openSync: (path, flags, mode) => {
        captureDirectory = String(path).replace(/[/\\]output\.bin$/u, "");
        return actualFs.openSync(path, flags, mode);
      },
      readFileSync: (path, encoding) => {
        if (String(path).endsWith("output.bin")) {
          throw Object.assign(new Error("EIO"), { code: "EIO" });
        }
        return actualFs.readFileSync(path, encoding);
      },
    });
    const output = new TempFileByteOutputCapture(
      "keel-output-read-race-",
      10,
      1,
    );
    output.append(Buffer.from("ab"));

    expect(() => output.capture()).toThrowError("EIO");
    expectDirectoryRemoved(captureDirectory);
  });
});
