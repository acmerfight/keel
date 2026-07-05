import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runCliMain } from "../../../src/cli/index.ts";
import { recordLastEditCheckpoint } from "../../../src/core/git.ts";
import { runGit } from "../../../src/testing/cli-harness.ts";
import { createRuntime } from "../../../src/testing/cli-runtime-fixtures.ts";

describe("CLI Main - Undo Command", () => {
  test(`Given there is no edit checkpoint,
    When the CLI main dispatches undo,
    Then it returns the user-visible undo failure`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-main-undo-"));
    const fixture = createRuntime(["/undo"], { cwd: workspace });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(fixture.stdout()).toBe("");
      expect(fixture.stderr()).not.toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the latest undo checkpoint can be restored,
    When the CLI main dispatches undo,
    Then it restores the file and reports the path`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-main-undo-ok-"));
    await runGit(workspace, ["init"]);
    await writeFile(join(workspace, "note.txt"), "after\n", "utf8");
    recordLastEditCheckpoint({
      workspace,
      filePath: join(workspace, "note.txt"),
      beforeContent: "before\n",
      afterContent: "after\n",
    });
    const fixture = createRuntime(["/undo"], { cwd: workspace });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "before\n",
      );
      expect(fixture.stdout()).toContain("Restored note.txt\n");
      expect(fixture.stderr()).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given undo checkpoints exist,
    When the CLI main dispatches undo list,
    Then it reports the checkpoints without restoring files`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-main-undo-list-"));
    await runGit(workspace, ["init"]);
    await writeFile(join(workspace, "first.txt"), "after first\n", "utf8");
    recordLastEditCheckpoint({
      workspace,
      filePath: join(workspace, "first.txt"),
      beforeContent: "before first\n",
      afterContent: "after first\n",
    });
    await writeFile(join(workspace, "second.txt"), "after second\n", "utf8");
    recordLastEditCheckpoint({
      workspace,
      filePath: join(workspace, "second.txt"),
      beforeContent: "before second\n",
      afterContent: "after second\n",
    });
    const fixture = createRuntime(["/undo", "--list"], { cwd: workspace });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toBe(
        ["Undo checkpoints:", "1. second.txt", "2. first.txt", ""].join("\n"),
      );
      expect(fixture.stderr()).toBe("");
      expect(await readFile(join(workspace, "first.txt"), "utf8")).toBe(
        "after first\n",
      );
      expect(await readFile(join(workspace, "second.txt"), "utf8")).toBe(
        "after second\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given undo checkpoints exist,
    When the CLI main dispatches undo through a listed checkpoint,
    Then it restores every newer checkpoint and reports the count`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-main-undo-to-"));
    await runGit(workspace, ["init"]);
    await writeFile(join(workspace, "first.txt"), "after first\n", "utf8");
    recordLastEditCheckpoint({
      workspace,
      filePath: join(workspace, "first.txt"),
      beforeContent: "before first\n",
      afterContent: "after first\n",
    });
    await writeFile(join(workspace, "second.txt"), "after second\n", "utf8");
    recordLastEditCheckpoint({
      workspace,
      filePath: join(workspace, "second.txt"),
      beforeContent: "before second\n",
      afterContent: "after second\n",
    });
    const fixture = createRuntime(["/undo", "--to", "2"], { cwd: workspace });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toBe("Restored 2 checkpoints\n");
      expect(fixture.stderr()).toBe("");
      expect(await readFile(join(workspace, "first.txt"), "utf8")).toBe(
        "before first\n",
      );
      expect(await readFile(join(workspace, "second.txt"), "utf8")).toBe(
        "before second\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the latest undo checkpoint no longer matches the file,
    When the CLI main dispatches undo,
    Then it refuses to overwrite the user's newer changes`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-main-undo-blocked-"),
    );
    await runGit(workspace, ["init"]);
    await writeFile(join(workspace, "note.txt"), "after\n", "utf8");
    recordLastEditCheckpoint({
      workspace,
      filePath: join(workspace, "note.txt"),
      beforeContent: "before\n",
      afterContent: "after\n",
    });
    await writeFile(join(workspace, "note.txt"), "newer change\n", "utf8");
    const fixture = createRuntime(["/undo"], { cwd: workspace });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe(
        "newer change\n",
      );
      expect(fixture.stdout()).toBe("");
      expect(fixture.stderr()).not.toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
