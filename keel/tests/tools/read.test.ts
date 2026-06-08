import { execFile } from "node:child_process";
import { mkdir, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { KeelErrorCode } from "../../src/core/error.ts";
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

function expectReadError(
  action: () => unknown,
  code: KeelErrorCode,
  message: string,
): void {
  try {
    action();
    throw new Error("Expected read tool to throw");
  } catch (error) {
    expect(error).toMatchObject({
      name: "KeelError",
      code,
      message: expect.stringContaining(message),
    });
  }
}

describe("Read Tool", () => {
  test(`Given a read request with an invalid offset,
    When the read tool validates the request,
    Then it rejects the request before reading the file`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-read-"));
    await writeFile(join(workspace, "note.txt"), "hello\n");

    try {
      // When / Then
      expectReadError(
        () => executeRead(workspace, "note.txt", { offset: 0 }),
        "tool_invalid_read_options",
        "offset must be a positive integer",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a read request with an invalid limit,
    When the read tool validates the request,
    Then it rejects the request before reading the file`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-read-"));
    await writeFile(join(workspace, "note.txt"), "hello\n");

    try {
      // When / Then
      expectReadError(
        () => executeRead(workspace, "note.txt", { limit: 0 }),
        "tool_invalid_read_options",
        "limit must be a positive integer",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a read request starts beyond the end of a file,
    When the read tool reaches EOF before that offset,
    Then it rejects the request as out of range`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-read-"));
    await writeFile(join(workspace, "note.txt"), "one\ntwo\n");

    try {
      // When / Then
      expectReadError(
        () => executeRead(workspace, "note.txt", { offset: 3 }),
        "tool_read_offset_out_of_range",
        "offset 3 is beyond end of file",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a read request uses an absolute path outside the workspace,
    When the read tool resolves the target,
    Then it rejects the path before reading the file`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-read-"));
    const outside = await mkdtemp(join(tmpdir(), "keel-read-outside-"));
    const outsidePath = join(outside, "secret.txt");
    await writeFile(outsidePath, "do not read\n");

    try {
      // When / Then
      expectReadError(
        () => executeRead(workspace, outsidePath),
        "tool_path_outside_workspace",
        "outside the workspace",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test(`Given a read request uses a missing absolute path outside the workspace,
    When the read tool validates the path,
    Then it rejects the workspace escape without revealing path existence`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-read-"));
    const outside = await mkdtemp(join(tmpdir(), "keel-read-outside-"));
    const outsidePath = join(outside, "missing.txt");

    try {
      // When / Then
      expectReadError(
        () => executeRead(workspace, outsidePath),
        "tool_path_outside_workspace",
        "outside the workspace",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test(`Given a symlink inside the workspace points outside,
    When the read tool resolves the target,
    Then it rejects the escaped path before reading the file`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-read-"));
    const outside = await mkdtemp(join(tmpdir(), "keel-read-outside-"));
    const outsidePath = join(outside, "secret.txt");
    await writeFile(outsidePath, "do not read\n");
    await symlink(outsidePath, join(workspace, "link.txt"));

    try {
      // When / Then
      expectReadError(
        () => executeRead(workspace, "link.txt"),
        "tool_path_outside_workspace",
        "outside the workspace",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test(`Given a project gitignore excludes a file,
    When the read tool is called for that file,
    Then it rejects the request before returning content`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-read-"));
    await writeFile(join(workspace, ".gitignore"), "secret.txt\n", "utf8");
    await writeFile(join(workspace, "secret.txt"), "do-not-print\n", "utf8");

    try {
      // When / Then
      expectReadError(
        () => executeRead(workspace, "secret.txt"),
        "tool_path_ignored",
        "ignored path",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a project gitignore excludes a missing file,
    When the read tool is called for that file,
    Then it rejects the ignored path without revealing path existence`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-read-"));
    await writeFile(join(workspace, ".gitignore"), "secret.txt\n", "utf8");

    try {
      // When / Then
      expectReadError(
        () => executeRead(workspace, "secret.txt"),
        "tool_path_ignored",
        "ignored path",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a project gitignore excludes a symlink to a visible file,
    When the read tool is called through that ignored symlink,
    Then it rejects the request path before returning target content`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-read-"));
    await writeFile(
      join(workspace, ".gitignore"),
      "ignored-link.txt\n",
      "utf8",
    );
    await writeFile(join(workspace, "visible.txt"), "do-not-print\n", "utf8");
    await symlink("visible.txt", join(workspace, "ignored-link.txt"));

    try {
      // When / Then
      expectReadError(
        () => executeRead(workspace, "ignored-link.txt"),
        "tool_path_ignored",
        "ignored path",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a project gitignore excludes a visible symlink target,
    When the read tool is called through the symlink,
    Then it rejects the resolved target before returning content`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-read-"));
    await writeFile(join(workspace, ".gitignore"), "secret.txt\n", "utf8");
    await writeFile(join(workspace, "secret.txt"), "do-not-print\n", "utf8");
    await symlink("secret.txt", join(workspace, "visible-link.txt"));

    try {
      // When / Then
      expectReadError(
        () => executeRead(workspace, "visible-link.txt"),
        "tool_path_ignored",
        "ignored path",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a project gitignore excludes a missing directory namespace,
    When the read tool is called for a missing file inside that namespace,
    Then it rejects the ignored path without revealing path existence`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-read-"));
    await writeFile(join(workspace, ".gitignore"), "secret-dir/\n", "utf8");

    try {
      // When / Then
      expectReadError(
        () => executeRead(workspace, "secret-dir/missing.txt"),
        "tool_path_ignored",
        "ignored path",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a nested gitignore excludes a file,
    When the read tool is called for that nested file,
    Then it rejects the request before returning content`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-read-"));
    await mkdir(join(workspace, "src"));
    await writeFile(join(workspace, "src", ".gitignore"), "secret.txt\n");
    await writeFile(join(workspace, "src", "secret.txt"), "do-not-print\n");

    try {
      // When / Then
      expectReadError(
        () => executeRead(workspace, "src/secret.txt"),
        "tool_path_ignored",
        "ignored path",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a project gitignore excludes a directory,
    When the read tool is called for a file inside that directory,
    Then it rejects the request before returning content`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-read-"));
    await mkdir(join(workspace, "secret-dir"));
    await writeFile(join(workspace, ".gitignore"), "secret-dir/\n", "utf8");
    await writeFile(
      join(workspace, "secret-dir", "secret.txt"),
      "do-not-print\n",
      "utf8",
    );

    try {
      // When / Then
      expectReadError(
        () => executeRead(workspace, "secret-dir/secret.txt"),
        "tool_path_ignored",
        "ignored path",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a gitignore rule re-includes a file,
    When the read tool is called for that re-included file,
    Then it reads the file content`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-read-"));
    await writeFile(join(workspace, ".gitignore"), "*.txt\n!keep.txt\n");
    await writeFile(join(workspace, "keep.txt"), "visible\n");

    try {
      // When
      const result = executeRead(workspace, "keep.txt");

      // Then
      expect(result.content).toBe("visible\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a read request uses an absolute path inside the workspace,
    When the read tool resolves the target,
    Then it reads the file content`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-read-"));
    const filePath = join(workspace, "note.txt");
    await writeFile(filePath, "hello\n");

    try {
      // When
      const result = executeRead(workspace, filePath);

      // Then
      expect(result.content).toBe("hello\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an empty file,
    When the read tool runs,
    Then it returns empty content`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-read-"));
    await writeFile(join(workspace, "empty.txt"), "");

    try {
      // When
      const result = executeRead(workspace, "empty.txt");

      // Then
      expect(result.content).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a text file has no trailing newline,
    When the read tool reaches EOF,
    Then it returns the final line content`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-read-"));
    await writeFile(join(workspace, "note.txt"), "hello");

    try {
      // When
      const result = executeRead(workspace, "note.txt");

      // Then
      expect(result.content).toBe("hello");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a PDF file,
    When the read tool runs,
    Then it rejects the file as binary`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-read-"));
    await writeFile(join(workspace, "document.pdf"), "%PDF-1.7\n");

    try {
      // When / Then
      expectReadError(
        () => executeRead(workspace, "document.pdf"),
        "tool_binary_file",
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
      expectReadError(
        () => executeRead(workspace, "image.png"),
        "tool_binary_file",
        "binary file",
      );
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
      expectReadError(
        () => executeRead(workspace, "document.txt"),
        "tool_binary_file",
        "binary file",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a text-named file contains too many control bytes,
    When the read tool sniffs the content,
    Then it rejects the file as binary`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-read-"));
    await writeFile(join(workspace, "control.txt"), Buffer.from([1, 2, 3, 65]));

    try {
      // When / Then
      expectReadError(
        () => executeRead(workspace, "control.txt"),
        "tool_binary_file",
        "binary file",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a file starts as text and later contains invalid UTF-8,
    When the read tool streams past the sample window,
    Then it rejects the file as binary before returning content`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-read-"));
    await writeFile(
      join(workspace, "invalid-utf8.txt"),
      Buffer.concat([Buffer.alloc(5000, "a"), Buffer.from([0xff])]),
    );

    try {
      // When / Then
      expectReadError(
        () => executeRead(workspace, "invalid-utf8.txt"),
        "tool_binary_file",
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
      expectReadError(
        () => executeRead(workspace, "mixed.txt"),
        "tool_binary_file",
        "binary file",
      );
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

  test(`Given the first requested line exceeds the read byte budget,
    When the read tool tries to return that line,
    Then it returns a targeted truncation notice instead of partial content`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-read-"));
    await writeFile(join(workspace, "long-line.txt"), "x".repeat(51 * 1024));

    try {
      // When
      const result = executeRead(workspace, "long-line.txt");

      // Then
      expect(result.content).toBe(
        "[Read output truncated: line 1 exceeds 50KB. Use grep to find a smaller target before reading this file.]",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
