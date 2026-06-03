import { execFile } from "node:child_process";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { executeRead } from "../../src/tools/read.ts";

async function writeRepeated(
  filePath: string,
  chunk: Buffer,
  count: number,
): Promise<void> {
  const file = await open(filePath, "w");
  try {
    for (let i = 0; i < count; i++) {
      await file.write(chunk);
    }
  } finally {
    await file.close();
  }
}

function runReadToolInSmallHeap(workspace: string): Promise<{
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}> {
  const script = `
    import { executeRead } from "./src/tools/read.ts";
    const result = executeRead(process.argv[1], "long-line.txt", { offset: 2, limit: 1 });
    if (result.content !== "target\\n") {
      console.error(result.content);
      process.exit(2);
    }
  `;

  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [
        "--max-old-space-size=16",
        "--experimental-strip-types",
        "--input-type=module",
        "--eval",
        script,
        workspace,
      ],
      { cwd: process.cwd(), timeout: 10_000 },
      (error, stdout, stderr) => {
        resolve({
          stdout,
          stderr,
          exitCode:
            typeof error?.code === "number" ? error.code : child.exitCode,
          signal: error?.signal ?? child.signalCode,
        });
      },
    );
  });
}

describe("Read Tool", () => {
  test(`Given a PDF file,
    When the read tool runs,
    Then it rejects the file as binary`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-read-"));
    await writeFile(join(workspace, "document.pdf"), "%PDF-1.7\n");

    try {
      // When / Then
      expect(() => executeRead(workspace, "document.pdf")).toThrow(
        "binary file",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an image file,
    When the read tool runs,
    Then it rejects the file as binary`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-read-"));
    await writeFile(
      join(workspace, "image.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );

    try {
      // When / Then
      expect(() => executeRead(workspace, "image.png")).toThrow("binary file");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a text-named PDF,
    When the read tool runs,
    Then it rejects the file by magic bytes`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-read-"));
    await writeFile(join(workspace, "document.txt"), "%PDF-1.7\n");

    try {
      // When / Then
      expect(() => executeRead(workspace, "document.txt")).toThrow(
        "binary file",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a file starts as text and later contains a binary byte,
    When the read tool streams past the sample window,
    Then it rejects the file before returning content`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-read-"));
    await writeFile(
      join(workspace, "mixed.txt"),
      Buffer.concat([
        Buffer.alloc(5000, "a"),
        Buffer.from([0]),
        Buffer.from("b"),
      ]),
    );

    try {
      // When / Then
      expect(() => executeRead(workspace, "mixed.txt")).toThrow("binary file");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given offset skips a very long first line,
    When read runs in a constrained heap,
    Then it returns the requested later line without buffering the skipped line`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-read-"));
    const filePath = join(workspace, "long-line.txt");
    const oneMegabyte = Buffer.alloc(1024 * 1024, "x");

    try {
      await writeRepeated(filePath, oneMegabyte, 24);
      const file = await open(filePath, "a");
      try {
        await file.write(Buffer.from("\ntarget\n"));
      } finally {
        await file.close();
      }

      // When
      const result = await runReadToolInSmallHeap(workspace);

      // Then
      expect(result).toMatchObject({
        stdout: "",
        stderr: "",
        exitCode: 0,
        signal: null,
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
