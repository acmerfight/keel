import { readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:net";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  commitFile,
  createGitWorkspace as createHarnessGitWorkspace,
  runCli,
  runGit,
} from "../../src/testing/cli-harness.ts";

function createGitWorkspace(): Promise<string> {
  return createHarnessGitWorkspace("keel-cli-undo-");
}

function getPort(server: Server): number {
  const addr = server.address();
  if (addr === null || typeof addr === "string") {
    throw new Error("Server not listening on a TCP port");
  }
  return addr.port;
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function sseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function sseToolCall(
  id: string,
  tool: string,
  args: Record<string, unknown>,
): string {
  return sseData({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id,
              type: "function",
              function: {
                name: tool,
                arguments: JSON.stringify(args),
              },
            },
          ],
        },
        finish_reason: null,
      },
    ],
    usage: null,
  });
}

function usageFixture(): {
  readonly prompt_tokens: number;
  readonly prompt_cache_hit_tokens: number;
  readonly prompt_cache_miss_tokens: number;
  readonly completion_tokens: number;
} {
  return {
    prompt_tokens: 0,
    prompt_cache_hit_tokens: 0,
    prompt_cache_miss_tokens: 0,
    completion_tokens: 0,
  };
}

function sseToolFinish(): string {
  return sseData({
    choices: [{ delta: {}, finish_reason: "tool_calls" }],
    usage: usageFixture(),
  });
}

function sseTextReply(text: string): string {
  return sseData({
    choices: [{ delta: { content: text }, finish_reason: null }],
    usage: null,
  });
}

function sseStopFinish(): string {
  return sseData({
    choices: [{ delta: {}, finish_reason: "stop" }],
    usage: usageFixture(),
  });
}

async function runTwoFileEditTask(workspace: string): Promise<void> {
  let requestCount = 0;
  const server = createServer((req, res) => {
    if (req.url !== "/chat/completions") {
      res.writeHead(404);
      res.end();
      return;
    }

    req.on("data", () => {});
    req.on("end", () => {
      requestCount++;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      if (requestCount === 1) {
        res.write(
          sseToolCall("call_read_first", "read", { path: "first.txt" }),
        );
        res.write(sseToolFinish());
      } else if (requestCount === 2) {
        res.write(
          sseToolCall("call_edit_first", "edit", {
            path: "first.txt",
            edits: [{ oldText: "old", newText: "new" }],
          }),
        );
        res.write(sseToolFinish());
      } else if (requestCount === 3) {
        res.write(
          sseToolCall("call_read_second", "read", { path: "second.txt" }),
        );
        res.write(sseToolFinish());
      } else if (requestCount === 4) {
        res.write(
          sseToolCall("call_edit_second", "edit", {
            path: "second.txt",
            edits: [{ oldText: "old", newText: "new" }],
          }),
        );
        res.write(sseToolFinish());
      } else {
        res.write(sseTextReply("Updated both files."));
        res.write(sseStopFinish());
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await listen(server);

  try {
    const edit = await runCli(["update both files"], {
      cwd: workspace,
      env: {
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
      },
    });
    expect(edit.exitCode).toBe(0);
  } finally {
    await close(server);
  }
}

describe("CLI Undo", () => {
  test(`Given one Keel task edits two files in separate tool calls,
    When user runs the undo command,
    Then both files are restored as one task checkpoint`, async () => {
    // Given
    const workspace = await createGitWorkspace();
    await commitFile(workspace, "first.txt", "first old\n");
    await commitFile(workspace, "second.txt", "second old\n");

    try {
      await runTwoFileEditTask(workspace);
      expect(await readFile(join(workspace, "first.txt"), "utf8")).toBe(
        "first new\n",
      );
      expect(await readFile(join(workspace, "second.txt"), "utf8")).toBe(
        "second new\n",
      );

      // When
      const undo = await runCli(["/undo"], { cwd: workspace });

      // Then
      expect(undo.exitCode).toBe(0);
      expect(undo.stdout).toBe("Restored 2 files\n");
      expect(await readFile(join(workspace, "first.txt"), "utf8")).toBe(
        "first old\n",
      );
      expect(await readFile(join(workspace, "second.txt"), "utf8")).toBe(
        "second old\n",
      );
      const list = await runCli(["/undo", "--list"], { cwd: workspace });
      expect(list.exitCode).toBe(0);
      expect(list.stdout).toBe("No undo checkpoints.\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given one Keel task edited two files and the user changed one afterwards,
    When user runs the undo command,
    Then the CLI refuses to partially restore the task`, async () => {
    // Given
    const workspace = await createGitWorkspace();
    await commitFile(workspace, "first.txt", "first old\n");
    await commitFile(workspace, "second.txt", "second old\n");

    try {
      await runTwoFileEditTask(workspace);
      await writeFile(join(workspace, "first.txt"), "user change\n", "utf8");

      // When
      const undo = await runCli(["/undo"], { cwd: workspace });

      // Then
      expect(undo.exitCode).not.toBe(0);
      expect(undo.stdout).toBe("");
      expect(undo.stderr).toContain("Refusing to overwrite user changes");
      expect(await readFile(join(workspace, "first.txt"), "utf8")).toBe(
        "user change\n",
      );
      expect(await readFile(join(workspace, "second.txt"), "utf8")).toBe(
        "second new\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a git workspace file is edited by Keel,
    When user runs the undo command,
    Then the file is restored to its pre-edit content`, async () => {
    // Given
    const workspace = await createGitWorkspace();
    await commitFile(workspace, "note.txt", "hello old world\n");

    try {
      const edit = await runCli(["replace old with new in note.txt"], {
        cwd: workspace,
        env: { KEEL_PROVIDER: "fake" },
      });
      expect(edit.exitCode).toBe(0);
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "hello new world\n",
      );

      // When
      const undo = await runCli(["/undo"], { cwd: workspace });

      // Then
      expect(undo.exitCode).toBe(0);
      expect(undo.stdout).toBe("Restored note.txt\n");
      expect(undo.stderr).toBe("");
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "hello old world\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given Keel edited a file and the user changed that file afterwards,
    When user runs the undo command,
    Then the CLI refuses to overwrite the user's later change`, async () => {
    // Given
    const workspace = await createGitWorkspace();
    const filePath = join(workspace, "note.txt");
    await commitFile(workspace, "note.txt", "hello old world\n");
    const edit = await runCli(["replace old with new in note.txt"], {
      cwd: workspace,
      env: { KEEL_PROVIDER: "fake" },
    });
    expect(edit.exitCode).toBe(0);
    await writeFile(filePath, "user change\n", "utf8");

    try {
      // When
      const undo = await runCli(["/undo"], { cwd: workspace });

      // Then
      expect(undo.exitCode).not.toBe(0);
      expect(undo.stdout).toBe("");
      expect(undo.stderr).toContain("Refusing to overwrite user changes");
      expect(await readFile(filePath, "utf8")).toBe("user change\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given Keel edited an existing untracked file,
    When user runs the undo command,
    Then the untracked file content is restored and remains untracked`, async () => {
    // Given
    const workspace = await createGitWorkspace();
    await commitFile(workspace, "tracked.txt", "tracked\n");
    await writeFile(join(workspace, "note.txt"), "hello old world\n", "utf8");

    try {
      const edit = await runCli(["replace old with new in note.txt"], {
        cwd: workspace,
        env: { KEEL_PROVIDER: "fake" },
      });
      expect(edit.exitCode).toBe(0);

      // When
      const undo = await runCli(["/undo"], { cwd: workspace });

      // Then
      expect(undo.exitCode).toBe(0);
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "hello old world\n",
      );
      expect(
        (await runGit(workspace, ["status", "--porcelain", "--", "note.txt"]))
          .stdout,
      ).toBe("?? note.txt\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given Keel created a new file in a git workspace,
    When user runs the undo command,
    Then the created file is removed`, async () => {
    // Given
    const workspace = await createGitWorkspace();

    try {
      const write = await runCli(["create config.json"], {
        cwd: workspace,
        env: { KEEL_PROVIDER: "fake" },
      });
      expect(write.exitCode).toBe(0);
      expect(await readFile(join(workspace, "config.json"), "utf8")).toBe(
        '{"created":true}\n',
      );

      // When
      const undo = await runCli(["/undo"], { cwd: workspace });

      // Then
      expect(undo.exitCode).toBe(0);
      expect(undo.stdout).toBe("Restored config.json\n");
      await expect(
        readFile(join(workspace, "config.json"), "utf8"),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given Keel applies a multi-file patch in a git workspace,
    When user runs the undo command,
    Then every patched file is restored as one batch`, async () => {
    // Given
    const workspace = await createGitWorkspace();
    await commitFile(workspace, "src.ts", "export const value = 1;\n");

    try {
      const patch = await runCli(["apply patch demo"], {
        cwd: workspace,
        env: { KEEL_PROVIDER: "fake" },
      });
      expect(patch.exitCode).toBe(0);
      expect(await readFile(join(workspace, "src.ts"), "utf8")).toBe(
        "export const value = 2;\n",
      );
      expect(await readFile(join(workspace, "docs", "note.md"), "utf8")).toBe(
        "patched\n",
      );

      // When
      const undo = await runCli(["/undo"], { cwd: workspace });

      // Then
      expect(undo.exitCode).toBe(0);
      expect(undo.stdout).toBe("Restored 2 files\n");
      expect(await readFile(join(workspace, "src.ts"), "utf8")).toBe(
        "export const value = 1;\n",
      );
      await expect(
        readFile(join(workspace, "docs", "note.md"), "utf8"),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given Keel deletes a file through apply_patch in a git workspace,
    When user runs the undo command,
    Then the deleted file is restored`, async () => {
    // Given
    const workspace = await createGitWorkspace();
    await commitFile(workspace, "obsolete.txt", "obsolete\n");

    try {
      const patch = await runCli(["remove obsolete.txt"], {
        cwd: workspace,
        env: { KEEL_PROVIDER: "fake" },
      });
      expect(patch.exitCode).toBe(0);
      await expect(
        readFile(join(workspace, "obsolete.txt"), "utf8"),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });

      // When
      const undo = await runCli(["/undo"], { cwd: workspace });

      // Then
      expect(undo.exitCode).toBe(0);
      expect(undo.stdout).toBe("Restored obsolete.txt\n");
      expect(await readFile(join(workspace, "obsolete.txt"), "utf8")).toBe(
        "obsolete\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given Keel moves a file through apply_patch in a git workspace,
    When user runs the undo command,
    Then the original path is restored and the moved path is removed`, async () => {
    // Given
    const workspace = await createGitWorkspace();
    await commitFile(workspace, "old.txt", "old\n");

    try {
      const patch = await runCli(["move old.txt to new.txt"], {
        cwd: workspace,
        env: { KEEL_PROVIDER: "fake" },
      });
      expect(patch.exitCode).toBe(0);
      await expect(
        readFile(join(workspace, "old.txt"), "utf8"),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await readFile(join(workspace, "new.txt"), "utf8")).toBe("old\n");

      // When
      const undo = await runCli(["/undo"], { cwd: workspace });

      // Then
      expect(undo.exitCode).toBe(0);
      expect(undo.stdout).toBe("Restored 2 files\n");
      expect(await readFile(join(workspace, "old.txt"), "utf8")).toBe("old\n");
      await expect(
        readFile(join(workspace, "new.txt"), "utf8"),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the user's git index has staged changes,
    When Keel edits and undoes a different file,
    Then the staged changes are preserved`, async () => {
    // Given
    const workspace = await createGitWorkspace();
    await commitFile(workspace, "note.txt", "hello old world\n");
    await writeFile(join(workspace, "staged.txt"), "base\n", "utf8");
    await runGit(workspace, ["add", "staged.txt"]);
    await runGit(workspace, ["commit", "-m", "add staged"]);
    await writeFile(join(workspace, "staged.txt"), "staged change\n", "utf8");
    await runGit(workspace, ["add", "staged.txt"]);

    try {
      const edit = await runCli(["replace old with new in note.txt"], {
        cwd: workspace,
        env: { KEEL_PROVIDER: "fake" },
      });
      expect(edit.exitCode).toBe(0);

      // When
      const undo = await runCli(["/undo"], { cwd: workspace });

      // Then
      expect(undo.exitCode).toBe(0);
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "hello old world\n",
      );
      expect(
        (await runGit(workspace, ["diff", "--cached", "--", "staged.txt"]))
          .stdout,
      ).toContain("+staged change");
      expect(
        (await runGit(workspace, ["diff", "--cached", "--", "note.txt"]))
          .stdout,
      ).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given no Keel checkpoint exists,
    When user runs the undo command,
    Then the CLI reports the next actions without requiring a provider`, async () => {
    // Given
    const workspace = await createGitWorkspace();

    try {
      // When
      const undo = await runCli(["/undo"], {
        cwd: workspace,
        env: {
          KEEL_PROVIDER: "deepseek",
          DEEPSEEK_API_KEY: "",
        },
      });

      // Then
      expect(undo.exitCode).not.toBe(0);
      expect(undo.stdout).toBe("");
      expect(undo.stderr).toBe(
        "No earlier checkpoints. Ask me to undo more, or use git to reset.\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an edit request fails before writing a file,
    When user runs the undo command,
    Then no checkpoint is consumed and the original file remains unchanged`, async () => {
    // Given
    const workspace = await createGitWorkspace();
    await commitFile(workspace, "note.txt", "hello old world\n");

    try {
      const edit = await runCli(["replace missing with new in note.txt"], {
        cwd: workspace,
        env: { KEEL_PROVIDER: "fake" },
      });
      expect(edit.exitCode).toBe(0);
      expect(edit.stdout).toContain("Tool failed:");
      expect(edit.stdout).not.toContain("Edited");

      // When
      const undo = await runCli(["/undo"], { cwd: workspace });

      // Then
      expect(undo.exitCode).not.toBe(0);
      expect(undo.stderr).toBe(
        "No earlier checkpoints. Ask me to undo more, or use git to reset.\n",
      );
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "hello old world\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given Keel successfully edits two files in separate runs,
    When user runs the undo command twice,
    Then each task is restored in reverse order`, async () => {
    // Given
    const workspace = await createGitWorkspace();
    await commitFile(workspace, "first.txt", "first old\n");
    await commitFile(workspace, "second.txt", "second old\n");

    try {
      const firstEdit = await runCli(["replace old with new in first.txt"], {
        cwd: workspace,
        env: { KEEL_PROVIDER: "fake" },
      });
      expect(firstEdit.exitCode).toBe(0);
      const secondEdit = await runCli(["replace old with new in second.txt"], {
        cwd: workspace,
        env: { KEEL_PROVIDER: "fake" },
      });
      expect(secondEdit.exitCode).toBe(0);

      // When
      const undo = await runCli(["/undo"], { cwd: workspace });
      const secondUndo = await runCli(["/undo"], { cwd: workspace });
      const thirdUndo = await runCli(["/undo"], { cwd: workspace });

      // Then
      expect(undo.exitCode).toBe(0);
      expect(undo.stdout).toBe("Restored second.txt\n");
      expect(secondUndo.exitCode).toBe(0);
      expect(secondUndo.stdout).toBe("Restored first.txt\n");
      expect(thirdUndo.exitCode).not.toBe(0);
      expect(thirdUndo.stdout).toBe("");
      expect(thirdUndo.stderr).toBe(
        "No earlier checkpoints. Ask me to undo more, or use git to reset.\n",
      );
      expect(await readFile(join(workspace, "first.txt"), "utf8")).toBe(
        "first old\n",
      );
      expect(await readFile(join(workspace, "second.txt"), "utf8")).toBe(
        "second old\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given Keel has multiple undo checkpoints,
    When user lists undo checkpoints,
    Then the CLI shows the remaining tasks newest first without restoring them`, async () => {
    // Given
    const workspace = await createGitWorkspace();
    await commitFile(workspace, "first.txt", "first old\n");
    await commitFile(workspace, "second.txt", "second old\n");

    try {
      const firstEdit = await runCli(["replace old with new in first.txt"], {
        cwd: workspace,
        env: { KEEL_PROVIDER: "fake" },
      });
      expect(firstEdit.exitCode).toBe(0);
      const secondEdit = await runCli(["replace old with new in second.txt"], {
        cwd: workspace,
        env: { KEEL_PROVIDER: "fake" },
      });
      expect(secondEdit.exitCode).toBe(0);

      // When
      const list = await runCli(["/undo", "--list"], { cwd: workspace });

      // Then
      expect(list.exitCode).toBe(0);
      expect(list.stderr).toBe("");
      expect(list.stdout).toBe(
        ["Undo checkpoints:", "1. second.txt", "2. first.txt", ""].join("\n"),
      );
      expect(await readFile(join(workspace, "first.txt"), "utf8")).toBe(
        "first new\n",
      );
      expect(await readFile(join(workspace, "second.txt"), "utf8")).toBe(
        "second new\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
