import { execFile } from "node:child_process";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

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
