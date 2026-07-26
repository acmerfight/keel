import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  commitFile,
  createGitWorkspace,
  runGit,
} from "../../../src/testing/cli-harness.ts";
import { runCliPty } from "../../../src/testing/cli-pty-harness.ts";

describe("Interactive TUI diff review", () => {
  test(`Given a workspace has staged, unstaged, renamed, deleted, untracked, long, and CJK changes,
    When the user opens /diff and navigates the review,
    Then Keel shows a focused change audit and returns to the ready composer`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-tui-diff-review-");
    const home = await mkdtemp(join(tmpdir(), "keel-tui-diff-home-"));
    await commitFile(
      workspace,
      "long.txt",
      `${Array.from({ length: 48 }, (_, index) => `before ${index + 1}`).join(
        "\n",
      )}\n`,
    );
    await writeFile(join(workspace, "rename-before.txt"), "rename me\n");
    await writeFile(join(workspace, "delete-me.txt"), "delete me\n");
    await writeFile(join(workspace, "data.bin"), Uint8Array.from([0, 1, 2, 3]));
    await runGit(workspace, [
      "add",
      "rename-before.txt",
      "delete-me.txt",
      "data.bin",
    ]);
    await runGit(workspace, ["commit", "-m", "add review fixtures"]);
    await writeFile(
      join(workspace, "long.txt"),
      `${Array.from({ length: 48 }, (_, index) => `after ${index + 1}`).join(
        "\n",
      )}\n`,
    );
    await writeFile(join(workspace, "staged.txt"), "staged addition\n");
    await writeFile(join(workspace, "data.bin"), Uint8Array.from([0, 1, 2, 4]));
    await runGit(workspace, ["add", "staged.txt"]);
    await runGit(workspace, ["mv", "rename-before.txt", "rename-after.txt"]);
    await unlink(join(workspace, "delete-me.txt"));
    await runGit(workspace, ["add", "delete-me.txt"]);
    await writeFile(join(workspace, "未跟踪.txt"), "新增内容\n");
    const pty = runCliPty(["--ephemeral"], {
      cwd: workspace,
      columns: 100,
      rows: 24,
      env: {
        KEEL_HOME: home,
        KEEL_PROVIDER: "fake",
        NO_COLOR: "1",
      },
    });

    try {
      await pty.waitForScreen(
        (screen) => screen.includes("keel>"),
        "composer did not start",
      );

      // When
      pty.write("/diff\r");

      // Then
      const firstPage = await pty.waitForScreen(
        (screen) =>
          screen.includes("Workspace changes") &&
          screen.includes("6 files") &&
          screen.includes("Unstaged") &&
          screen.includes("long.txt"),
        "focused diff review did not open",
      );
      expect(firstPage).toContain("↑↓");
      expect(firstPage).toContain("PgUp/PgDn");
      expect(firstPage).toContain("Esc/q");
      expect(firstPage).toContain("+48");
      expect(firstPage).toContain("-49");
      expect(firstPage).toContain("BINARY data.bin");

      pty.write("\x1b[B");
      await pty.waitForScreen(
        (screen) => screen.includes("2-20/"),
        "Down did not advance one line",
      );
      pty.write("\x1b[A");
      await pty.waitForScreen(
        (screen) => screen.includes("1-19/"),
        "Up did not return one line",
      );

      pty.write("\x1b[6~");
      await pty.waitForScreen(
        (screen) => screen.includes("20-38/"),
        "PageDown did not advance the review",
      );
      pty.write("\x1b[5~");
      await pty.waitForScreen(
        (screen) => screen.includes("1-19/"),
        "PageUp did not return one page",
      );

      pty.write("\x1b[F");
      const lastPage = await pty.waitForScreen(
        (screen) =>
          screen.includes("Untracked") &&
          screen.includes("未跟踪.txt") &&
          screen.includes("+新增内容"),
        "End did not reach the final change",
      );
      expect(lastPage).toContain("/");

      pty.write("\x1b[5~");
      await pty.waitForScreen(
        (screen) =>
          screen.includes("Staged") &&
          screen.includes("D delete-me.txt") &&
          screen.includes("R rename-after.txt"),
        "staged rename and deletion were not reviewable",
      );
      pty.write("\x1b[H");
      await pty.waitForScreen(
        (screen) => screen.includes("1-19/") && screen.includes("Unstaged"),
        "Home did not return to the first change",
      );
      pty.write("\x1b[F");
      await pty.waitForScreen(
        (screen) =>
          screen.includes("Untracked") && screen.includes("未跟踪.txt"),
        "End did not restore the final change",
      );

      pty.resize(42, 18);
      const narrow = await pty.waitForScreen(
        (screen) =>
          screen.includes("Workspace changes") &&
          screen.includes("未跟踪.txt") &&
          screen.includes("Esc/q"),
        "diff review did not survive narrow resize",
      );
      expect(narrow).toContain("6 files");
      expect(narrow).toContain("PgUp/PgDn");
      expect(narrow).toContain("Home/End");
      expect(narrow).toMatch(/\d+-\d+\/\d+/u);

      pty.write("\x1b");
      await pty.waitForScreen(
        (screen) =>
          screen.includes("keel>") && !screen.includes("Workspace changes"),
        "diff review did not return focus to the composer",
      );
      pty.write("/status\r");
      const resumed = await pty.waitForScreen(
        (screen) =>
          screen.includes("session: (ephemeral") && screen.includes("keel>"),
        "composer did not accept input after diff review",
      );
      expect(resumed).not.toContain("diff --git");
      expect(resumed).not.toContain("@@");

      const ansiEscape = String.fromCharCode(27);
      for (const code of ["1", "2", "31", "32", "33", "36", "1;36"]) {
        expect(pty.rawOutput()).not.toContain(`${ansiEscape}[${code}m`);
      }
    } finally {
      pty.kill();
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given Git review is clean, unavailable, or fails,
    When the user opens /diff,
    Then each state is explicit and can be closed without starting a model turn`, async () => {
    const cleanWorkspace = await createGitWorkspace("keel-tui-diff-clean-");
    const nonGitWorkspace = await mkdtemp(
      join(tmpdir(), "keel-tui-diff-non-git-"),
    );
    const failedWorkspace = await createGitWorkspace("keel-tui-diff-failed-");
    const emptyPath = await mkdtemp(join(tmpdir(), "keel-tui-empty-path-"));
    const { PATH: executablePath = "" } = process.env;
    const scenarios = [
      {
        kind: "clean",
        workspace: cleanWorkspace,
        expected: "Working tree is clean",
        path: executablePath,
      },
      {
        kind: "non-git",
        workspace: nonGitWorkspace,
        expected: "Not a Git repository",
        path: executablePath,
      },
      {
        kind: "failed",
        workspace: failedWorkspace,
        expected: "Could not load changes",
        path: emptyPath,
      },
    ] as const;

    try {
      for (const scenario of scenarios) {
        const home = await mkdtemp(
          join(tmpdir(), `keel-tui-diff-${scenario.kind}-home-`),
        );
        const pty = runCliPty(["--ephemeral"], {
          cwd: scenario.workspace,
          columns: 72,
          rows: 18,
          env: {
            KEEL_HOME: home,
            KEEL_PROVIDER: "fake",
            NO_COLOR: "1",
            PATH: scenario.path,
          },
        });
        try {
          await pty.waitForScreen(
            (screen) => screen.includes("keel>"),
            `${scenario.kind} composer did not start`,
          );

          pty.write("/diff\r");

          const review = await pty.waitForScreen(
            (screen) =>
              screen.includes("Workspace changes") &&
              screen.includes(scenario.expected) &&
              screen.includes("Esc/q"),
            `${scenario.kind} review state was not explicit`,
          );
          expect(review).toContain("Esc/q");
          pty.write("q");
          await pty.waitForScreen(
            (screen) =>
              screen.includes("keel>") && !screen.includes("Workspace changes"),
            `${scenario.kind} review did not close`,
          );
        } finally {
          pty.kill();
          await rm(home, { recursive: true, force: true });
        }
      }
    } finally {
      await rm(cleanWorkspace, { recursive: true, force: true });
      await rm(nonGitWorkspace, { recursive: true, force: true });
      await rm(failedWorkspace, { recursive: true, force: true });
      await rm(emptyPath, { recursive: true, force: true });
    }
  });

  test(`Given more untracked files exist than Git review can safely capture,
    When the user opens /diff and jumps to the end,
    Then Keel marks the review as incomplete instead of implying full coverage`, async () => {
    const workspace = await createGitWorkspace("keel-tui-diff-truncated-");
    const home = await mkdtemp(join(tmpdir(), "keel-tui-diff-truncated-home-"));
    for (let index = 1; index <= 51; index++) {
      await writeFile(
        join(workspace, `untracked-${String(index).padStart(2, "0")}.txt`),
        `change ${index}\n`,
      );
    }
    const pty = runCliPty(["--ephemeral"], {
      cwd: workspace,
      columns: 88,
      rows: 20,
      env: {
        KEEL_HOME: home,
        KEEL_PROVIDER: "fake",
        NO_COLOR: "1",
      },
    });

    try {
      await pty.waitForScreen(
        (screen) => screen.includes("keel>"),
        "truncated composer did not start",
      );

      pty.write("/diff\r");
      await pty.waitForScreen(
        (screen) =>
          screen.includes("Workspace changes") &&
          screen.includes("50 files") &&
          screen.includes("incomplete output"),
        "truncated review summary was not explicit",
      );
      pty.write("\x1b[F");

      const finalPage = await pty.waitForScreen(
        (screen) =>
          screen.includes("Diff output is truncated") &&
          screen.includes("showing first 50 untracked files"),
        "truncation details were not reviewable",
      );
      expect(finalPage).toContain("Esc/q");
    } finally {
      pty.kill();
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a legal control-containing filename or an unresolved merge exists,
    When the user opens /diff and exits with a Kitty-protocol q,
    Then review structure stays honest and the advertised exit works`, async () => {
    const maliciousWorkspace = await createGitWorkspace(
      "keel-tui-diff-malicious-path-",
    );
    const maliciousPath = "real\nStaged changes:\ndiff --git fake fake";
    await writeFile(join(maliciousWorkspace, maliciousPath), "payload\n");

    const conflictWorkspace = await createGitWorkspace(
      "keel-tui-diff-conflict-",
    );
    await mkdir(join(conflictWorkspace, "a"));
    await commitFile(conflictWorkspace, "a/conflict.txt", "base\n");
    await runGit(conflictWorkspace, ["switch", "-c", "other"]);
    await writeFile(join(conflictWorkspace, "a/conflict.txt"), "other\n");
    await runGit(conflictWorkspace, ["commit", "-am", "other change"]);
    await runGit(conflictWorkspace, ["switch", "main"]);
    await writeFile(join(conflictWorkspace, "a/conflict.txt"), "main\n");
    await runGit(conflictWorkspace, ["commit", "-am", "main change"]);
    expect((await runGit(conflictWorkspace, ["merge", "other"])).exitCode).toBe(
      1,
    );

    const unmergedWorkspace = await createGitWorkspace(
      "keel-tui-diff-unmerged-",
    );
    await commitFile(unmergedWorkspace, "conflict.txt", "base\n");
    await runGit(unmergedWorkspace, ["switch", "-c", "other"]);
    await runGit(unmergedWorkspace, ["rm", "conflict.txt"]);
    await runGit(unmergedWorkspace, ["commit", "-m", "delete file"]);
    await runGit(unmergedWorkspace, ["switch", "main"]);
    await writeFile(join(unmergedWorkspace, "conflict.txt"), "main\n");
    await runGit(unmergedWorkspace, ["commit", "-am", "modify file"]);
    expect((await runGit(unmergedWorkspace, ["merge", "other"])).exitCode).toBe(
      1,
    );

    const scenarios = [
      {
        kind: "control-containing filename",
        workspace: maliciousWorkspace,
        expected: (screen: string) =>
          screen.includes("1 file") &&
          screen.includes("Untracked") &&
          screen.includes("A real\\nStaged changes:\\ndiff --git fake fake"),
      },
      {
        kind: "merge conflict",
        workspace: conflictWorkspace,
        expected: (screen: string) =>
          screen.includes("1 file") &&
          screen.includes("1 conflict") &&
          screen.includes("CONFLICT a/conflict.txt") &&
          screen.includes("@@@ "),
      },
      {
        kind: "modify-delete conflict",
        workspace: unmergedWorkspace,
        expected: (screen: string) =>
          screen.includes("1 file") &&
          screen.includes("1 conflict") &&
          screen.includes("CONFLICT conflict.txt"),
      },
    ] as const;

    try {
      for (const scenario of scenarios) {
        const home = await mkdtemp(
          join(tmpdir(), `keel-tui-diff-${scenario.kind}-home-`),
        );
        const pty = runCliPty(["--ephemeral"], {
          cwd: scenario.workspace,
          columns: 100,
          rows: 24,
          env: {
            KEEL_HOME: home,
            KEEL_PROVIDER: "fake",
            NO_COLOR: "1",
          },
        });
        try {
          await pty.waitForScreen(
            (screen) => screen.includes("keel>"),
            `${scenario.kind} composer did not start`,
          );
          pty.write("/diff\r");
          await pty.waitForScreen(
            scenario.expected,
            `${scenario.kind} review was misleading`,
          );

          pty.write("\x1b[113u");
          await pty.waitForScreen(
            (screen) =>
              screen.includes("keel>") && !screen.includes("Workspace changes"),
            `${scenario.kind} review ignored Kitty q`,
          );
        } finally {
          pty.kill();
          await rm(home, { recursive: true, force: true });
        }
      }
    } finally {
      await rm(maliciousWorkspace, { recursive: true, force: true });
      await rm(conflictWorkspace, { recursive: true, force: true });
      await rm(unmergedWorkspace, { recursive: true, force: true });
    }
  });
});
