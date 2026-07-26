import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  commitFile,
  createGitWorkspace,
  runGit,
} from "../../src/testing/cli-harness.ts";
import { executeGitDiff } from "../../src/tools/git-diff.ts";
import {
  type GitDiffDocument,
  parseGitDiffOutput,
} from "../../src/tools/git-diff-document.ts";

const workspaces: string[] = [];

async function workspace(prefix: string): Promise<string> {
  const created = await createGitWorkspace(prefix);
  workspaces.push(created);
  return created;
}

async function inspectDiff(root: string): Promise<GitDiffDocument> {
  const result = await executeGitDiff(root, { mode: "all" });
  const source = result.artifact ?? {
    content: result.content,
    sourceTruncated: result.sourceTruncated === true,
  };
  return parseGitDiffOutput(source.content, source.sourceTruncated);
}

afterEach(async () => {
  await Promise.all(
    workspaces
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Git diff document", () => {
  test(`Given an untracked filename contains structural-looking lines,
    When Git output becomes a semantic document,
    Then the filename remains one untracked record instead of injecting records`, async () => {
    const root = await workspace("keel-git-diff-document-path-");
    const path = "real\nStaged changes:\ndiff --git fake fake";
    await writeFile(join(root, path), "payload\n");

    const document = await inspectDiff(root);

    expect(document.changedFileCount).toBe(1);
    expect(document.conflictedFileCount).toBe(0);
    expect(document.files).toHaveLength(1);
    expect(document.files[0]).toMatchObject({
      path,
      scope: { kind: "untracked", path },
      status: "added",
    });
  });

  test(`Given a workspace contains a real unresolved merge,
    When Git output becomes a semantic document,
    Then the conflicted file and combined hunk remain explicit`, async () => {
    const root = await workspace("keel-git-diff-document-conflict-");
    await mkdir(join(root, "a"));
    await commitFile(root, "a/conflict.txt", "base\n");
    expect((await runGit(root, ["switch", "-c", "other"])).exitCode).toBe(0);
    await writeFile(join(root, "a/conflict.txt"), "other\n");
    expect(
      (await runGit(root, ["commit", "-am", "other change"])).exitCode,
    ).toBe(0);
    expect((await runGit(root, ["switch", "main"])).exitCode).toBe(0);
    await writeFile(join(root, "a/conflict.txt"), "main\n");
    expect(
      (await runGit(root, ["commit", "-am", "main change"])).exitCode,
    ).toBe(0);
    expect((await runGit(root, ["merge", "other"])).exitCode).toBe(1);

    const document = await inspectDiff(root);

    expect(document.changedFileCount).toBe(1);
    expect(document.conflictedFileCount).toBe(1);
    expect(document.files).toHaveLength(1);
    expect(document.files[0]).toMatchObject({
      path: "a/conflict.txt",
      scope: { kind: "unstaged" },
      status: "conflicted",
    });
    expect(document.files[0]?.lines).toContainEqual({
      kind: "hunk",
      text: expect.stringMatching(/^@@@ /u),
    });
    expect(document.files[0]?.lines).toContainEqual({
      kind: "conflict",
      text: expect.stringContaining("main"),
    });
    expect(document.files[0]?.additions).toBeGreaterThan(0);
    expect(document.files[0]?.hunks[0]?.changedLines.length).toBe(
      (document.files[0]?.additions ?? 0) + (document.files[0]?.deletions ?? 0),
    );
  });

  test(`Given a real modify-delete merge conflict has no combined diff heading,
    When Git output becomes a semantic document,
    Then its unmerged path still becomes an explicit conflicted file`, async () => {
    const root = await workspace("keel-git-diff-document-unmerged-");
    await commitFile(root, "conflict.txt", "base\n");
    expect((await runGit(root, ["switch", "-c", "other"])).exitCode).toBe(0);
    expect((await runGit(root, ["rm", "conflict.txt"])).exitCode).toBe(0);
    expect((await runGit(root, ["commit", "-m", "delete file"])).exitCode).toBe(
      0,
    );
    expect((await runGit(root, ["switch", "main"])).exitCode).toBe(0);
    await writeFile(join(root, "conflict.txt"), "main\n");
    expect(
      (await runGit(root, ["commit", "-am", "modify file"])).exitCode,
    ).toBe(0);
    expect((await runGit(root, ["merge", "other"])).exitCode).toBe(1);

    const document = await inspectDiff(root);

    expect(document.changedFileCount).toBe(1);
    expect(document.conflictedFileCount).toBe(1);
    expect(document.files).toEqual([
      expect.objectContaining({
        path: "conflict.txt",
        scope: { kind: "unstaged" },
        status: "conflicted",
      }),
    ]);
  });

  test(`Given one path has both staged and unstaged edits,
    When Git output becomes a semantic document,
    Then review entries preserve both scopes while the changed-file count stays unique`, async () => {
    const root = await workspace("keel-git-diff-document-scopes-");
    await commitFile(root, "both.txt", "base\n");
    await writeFile(join(root, "both.txt"), "staged\n");
    expect((await runGit(root, ["add", "both.txt"])).exitCode).toBe(0);
    await writeFile(join(root, "both.txt"), "unstaged\n");

    const document = await inspectDiff(root);

    expect(document.changedFileCount).toBe(1);
    expect(document.files).toHaveLength(2);
    expect(document.files.map((file) => file.scope.kind)).toEqual([
      "unstaged",
      "staged",
    ]);
  });

  test(`Given a structural-looking untracked heading contains non-string JSON,
    When Git output becomes a semantic document,
    Then it stays diagnostic prelude instead of becoming a path scope`, () => {
    const document = parseGitDiffOutput(
      [
        "Untracked changes (42):",
        "diff --git a/actual.txt b/actual.txt",
        "@@ -1 +1 @@",
        "-before",
        "+after",
      ].join("\n"),
      false,
    );

    expect(document.preludeLines).toContain("Untracked changes (42):");
    expect(document.files[0]).toMatchObject({
      path: "actual.txt",
      scope: { kind: "unscoped" },
    });
  });

  test(`Given one diff file contains twenty thousand small hunks,
    When Git output becomes a semantic document,
    Then parsing remains linear enough for an interactive review`, () => {
    const hunkCount = 20_000;
    const output = [
      "diff --git a/large.txt b/large.txt",
      "index 1111111..2222222 100644",
      "--- a/large.txt",
      "+++ b/large.txt",
      ...Array.from({ length: hunkCount }, (_, index) => [
        `@@ -${index + 1},1 +${index + 1},1 @@`,
        `-old ${index + 1}`,
        `+new ${index + 1}`,
      ]).flat(),
    ].join("\n");

    const startedAt = performance.now();
    const document = parseGitDiffOutput(output, false);
    const elapsedMs = performance.now() - startedAt;

    expect(document.files[0]?.hunks).toHaveLength(hunkCount);
    expect(document.additions).toBe(hunkCount);
    expect(document.deletions).toBe(hunkCount);
    expect(elapsedMs).toBeLessThan(200);
  });
});
