import { symlinkSync, unlinkSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { executeToolCall } from "../../src/tools/execution.ts";
import {
  createProjectInstructionVisibilityState,
  type ProjectInstructionVisibilityState,
} from "../../src/tools/scoped-project-instructions.ts";

async function createWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "keel-scoped-project-instructions-"));
}

function freshSignal(): AbortSignal {
  return new AbortController().signal;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath);
    return true;
  } catch {
    return false;
  }
}

function swapSymlinkAfterFirstMutationCheck(
  projectInstructions: ProjectInstructionVisibilityState,
  action: () => void,
): ProjectInstructionVisibilityState {
  let mutationChecks = 0;
  return {
    formatReadOutput: projectInstructions.formatReadOutput,
    formatInspectionOutput: projectInstructions.formatInspectionOutput,
    formatRestoreOutput: projectInstructions.formatRestoreOutput,
    visibleInstructionsMostRecentFirst:
      projectInstructions.visibleInstructionsMostRecentFirst,
    snapshot: projectInstructions.snapshot,
    restoreSnapshot: projectInstructions.restoreSnapshot,
    markInstructionPathsVisible:
      projectInstructions.markInstructionPathsVisible,
    applyMutationTargetPaths: projectInstructions.applyMutationTargetPaths,
    clear: projectInstructions.clear,
    assertMutationAllowed: (targetPaths) => {
      projectInstructions.assertMutationAllowed(targetPaths);
      mutationChecks += 1;
      if (mutationChecks === 1) {
        action();
      }
    },
  };
}

describe("Scoped Project Instructions", () => {
  test(`Given no project-instruction visibility state is supplied,
    When read and write run through tool execution,
    Then they preserve the legacy tool behavior`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "note.txt"), "hello\n", "utf8");

    try {
      // When
      const readResult = await executeToolCall({
        workspace,
        toolCall: { id: "read_note", tool: "read", path: "note.txt" },
        signal: freshSignal(),
        bash: { kind: "disabled" },
      });
      const writeResult = await executeToolCall({
        workspace,
        toolCall: {
          id: "write_note",
          tool: "write",
          path: "created.txt",
          content: "created\n",
        },
        signal: freshSignal(),
        bash: { kind: "disabled" },
      });
      const grepResult = await executeToolCall({
        workspace,
        toolCall: {
          id: "grep_note",
          tool: "grep",
          pattern: "hello",
          path: "note.txt",
        },
        signal: freshSignal(),
        bash: { kind: "disabled" },
      });

      // Then
      expect(readResult).toMatchObject({
        ok: true,
        content: "hello\n",
      });
      expect(readResult.visibleProjectInstructionPaths).toBeUndefined();
      expect(writeResult).toMatchObject({
        ok: true,
        content: "Wrote created.txt",
      });
      expect(await readFile(join(workspace, "created.txt"), "utf8")).toBe(
        "created\n",
      );
      expect(grepResult).toMatchObject({
        ok: true,
        content: "note.txt:1:hello",
      });
      expect(grepResult.visibleProjectInstructionPaths).toBeUndefined();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given scoped AGENTS.md is empty,
    When a read checks that scope,
    Then the file content is returned without injecting instructions`, async () => {
    // Given
    const workspace = await createWorkspace();
    await mkdir(join(workspace, "packages", "api", "src"), {
      recursive: true,
    });
    await writeFile(
      join(workspace, "packages", "api", "AGENTS.md"),
      "",
      "utf8",
    );
    await writeFile(
      join(workspace, "packages", "api", "src", "server.ts"),
      "export const route = 'api';\n",
      "utf8",
    );
    const projectInstructions =
      createProjectInstructionVisibilityState(workspace);

    try {
      // When
      const result = await executeToolCall({
        workspace,
        toolCall: {
          id: "read_api_server",
          tool: "read",
          path: "packages/api/src/server.ts",
        },
        signal: freshSignal(),
        bash: { kind: "disabled" },
        projectInstructions,
      });

      // Then
      expect(result).toMatchObject({
        ok: true,
        content: "export const route = 'api';\n",
      });
      expect(result.visibleProjectInstructionPaths).toBeUndefined();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given grep returns snippets from a scoped package,
    When scoped instructions are checked,
    Then project instructions are visible before the matching file snippets`, async () => {
    // Given
    const workspace = await createWorkspace();
    await mkdir(join(workspace, "packages", "api", "src"), {
      recursive: true,
    });
    await writeFile(
      join(workspace, "packages", "api", "AGENTS.md"),
      "API rule: grep snippets must be interpreted with this context.\n",
      "utf8",
    );
    await writeFile(
      join(workspace, "packages", "api", "src", "server.ts"),
      "export const route = 'api-search-target';\n",
      "utf8",
    );
    const projectInstructions =
      createProjectInstructionVisibilityState(workspace);

    try {
      // When
      const result = await executeToolCall({
        workspace,
        toolCall: {
          id: "grep_api_server",
          tool: "grep",
          pattern: "api-search-target",
          path: "packages/api",
        },
        signal: freshSignal(),
        bash: { kind: "disabled" },
        projectInstructions,
      });

      // Then
      expect(result.ok).toBe(true);
      expect(result.content).toContain(
        "Project instructions from packages/api/AGENTS.md",
      );
      expect(result.content).toContain(
        "API rule: grep snippets must be interpreted with this context.",
      );
      expect(result.content.indexOf("Project instructions from")).toBeLessThan(
        result.content.indexOf("packages/api/src/server.ts:1:"),
      );
      expect(result.visibleProjectInstructionPaths).toHaveLength(1);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given grep searches a scoped package with no matches,
    When scoped instructions are checked,
    Then project instructions are visible before the no-match result`, async () => {
    // Given
    const workspace = await createWorkspace();
    await mkdir(join(workspace, "packages", "api", "src"), {
      recursive: true,
    });
    await writeFile(
      join(workspace, "packages", "api", "AGENTS.md"),
      "API rule: no-match inspections still need this context.\n",
      "utf8",
    );
    await writeFile(
      join(workspace, "packages", "api", "src", "server.ts"),
      "export const route = 'api-search-target';\n",
      "utf8",
    );
    const projectInstructions =
      createProjectInstructionVisibilityState(workspace);

    try {
      // When
      const result = await executeToolCall({
        workspace,
        toolCall: {
          id: "grep_missing_api_server",
          tool: "grep",
          pattern: "missing-search-target",
          path: "packages/api",
        },
        signal: freshSignal(),
        bash: { kind: "disabled" },
        projectInstructions,
      });

      // Then
      expect(result.ok).toBe(true);
      expect(result.content).toContain(
        "Project instructions from packages/api/AGENTS.md",
      );
      expect(result.content).toContain(
        "API rule: no-match inspections still need this context.",
      );
      expect(result.content.indexOf("Project instructions from")).toBeLessThan(
        result.content.indexOf('No matches found for "missing-search-target"'),
      );
      expect(result.visibleProjectInstructionPaths).toHaveLength(1);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given scoped AGENTS.md is too large,
    When a write checks that scope,
    Then the tool fails before creating the file`, async () => {
    // Given
    const workspace = await createWorkspace();
    await mkdir(join(workspace, "packages", "api"), { recursive: true });
    await writeFile(
      join(workspace, "packages", "api", "AGENTS.md"),
      "a".repeat(50 * 1024 + 1),
      "utf8",
    );
    const projectInstructions =
      createProjectInstructionVisibilityState(workspace);
    const targetPath = join(workspace, "packages", "api", "src", "new.ts");

    try {
      // When
      const result = await executeToolCall({
        workspace,
        toolCall: {
          id: "write_api_file",
          tool: "write",
          path: "packages/api/src/new.ts",
          content: "export const value = 1;\n",
        },
        signal: freshSignal(),
        bash: { kind: "disabled" },
        projectInstructions,
      });

      // Then
      expect(result.ok).toBe(false);
      expect(result.content).toContain("Tool failed:");
      expect(result.content).toContain("packages/api/AGENTS.md is too large");
      expect(result.content).toContain("Recovery:");
      expect(await fileExists(targetPath)).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given scoped AGENTS.md contains invalid UTF-8,
    When a read checks that scope,
    Then the tool reports an instructions encoding failure instead of file content`, async () => {
    // Given
    const workspace = await createWorkspace();
    await mkdir(join(workspace, "packages", "api", "src"), {
      recursive: true,
    });
    await writeFile(
      join(workspace, "packages", "api", "AGENTS.md"),
      Buffer.from([0xc3, 0x28]),
    );
    await writeFile(
      join(workspace, "packages", "api", "src", "server.ts"),
      "export const secret = 'do-not-return';\n",
      "utf8",
    );
    const projectInstructions =
      createProjectInstructionVisibilityState(workspace);

    try {
      // When
      const result = await executeToolCall({
        workspace,
        toolCall: {
          id: "read_api_server",
          tool: "read",
          path: "packages/api/src/server.ts",
        },
        signal: freshSignal(),
        bash: { kind: "disabled" },
        projectInstructions,
      });

      // Then
      expect(result.ok).toBe(false);
      expect(result.content).toContain("binary or invalid UTF-8");
      expect(result.content).not.toContain("do-not-return");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given scoped AGENTS.md has binary control bytes after the first sample,
    When a write checks that scope,
    Then the tool reports a binary instructions failure before mutating files`, async () => {
    // Given
    const workspace = await createWorkspace();
    await mkdir(join(workspace, "packages", "api"), { recursive: true });
    await writeFile(
      join(workspace, "packages", "api", "AGENTS.md"),
      Buffer.concat([Buffer.from("a".repeat(4096)), Buffer.from([0])]),
    );
    const projectInstructions =
      createProjectInstructionVisibilityState(workspace);
    const targetPath = join(workspace, "packages", "api", "src", "new.ts");

    try {
      // When
      const result = await executeToolCall({
        workspace,
        toolCall: {
          id: "write_api_file",
          tool: "write",
          path: "packages/api/src/new.ts",
          content: "export const value = 1;\n",
        },
        signal: freshSignal(),
        bash: { kind: "disabled" },
        projectInstructions,
      });

      // Then
      expect(result.ok).toBe(false);
      expect(result.content).toContain("binary or invalid UTF-8");
      expect(await fileExists(targetPath)).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")(
    `Given a write path creates through a symlinked parent into a scoped package,
    When scoped instructions are checked,
    Then the real package AGENTS.md blocks the create before any file is written`,
    async () => {
      // Given
      const workspace = await createWorkspace();
      await mkdir(join(workspace, "packages", "api", "src"), {
        recursive: true,
      });
      await writeFile(
        join(workspace, "packages", "api", "AGENTS.md"),
        "API rule: symlinked creates still need this review.\n",
        "utf8",
      );
      await symlink(
        join(workspace, "packages", "api", "src"),
        join(workspace, "api-link"),
      );
      const projectInstructions =
        createProjectInstructionVisibilityState(workspace);
      const targetPath = join(workspace, "packages", "api", "src", "new.ts");

      try {
        // When
        const result = await executeToolCall({
          workspace,
          toolCall: {
            id: "write_symlinked_api_file",
            tool: "write",
            path: "api-link/new.ts",
            content: "export const value = 1;\n",
          },
          signal: freshSignal(),
          bash: { kind: "disabled" },
          projectInstructions,
        });

        // Then
        expect(result.ok).toBe(false);
        expect(result.content).toContain(
          "Project instructions from packages/api/AGENTS.md",
        );
        expect(result.content).toContain(
          "API rule: symlinked creates still need this review.",
        );
        expect(await fileExists(targetPath)).toBe(false);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    `Given a write path's symlinked parent changes scopes after precheck,
    When the file is created,
    Then access-time scoped instructions block the write before publish`,
    async () => {
      // Given
      const workspace = await createWorkspace();
      await mkdir(join(workspace, "safe"), { recursive: true });
      await mkdir(join(workspace, "packages", "api", "src"), {
        recursive: true,
      });
      await writeFile(
        join(workspace, "packages", "api", "AGENTS.md"),
        "API rule: raced symlink writes must still stop here.\n",
        "utf8",
      );
      const linkPath = join(workspace, "scope-link");
      await symlink(join(workspace, "safe"), linkPath);
      const realProjectInstructions =
        createProjectInstructionVisibilityState(workspace);
      const projectInstructions = swapSymlinkAfterFirstMutationCheck(
        realProjectInstructions,
        () => {
          unlinkSync(linkPath);
          symlinkSync(join(workspace, "packages", "api", "src"), linkPath);
        },
      );
      const safeTargetPath = join(workspace, "safe", "nested", "new.ts");
      const apiParentPath = join(workspace, "packages", "api", "src", "nested");
      const apiTargetPath = join(apiParentPath, "new.ts");

      try {
        // When
        const result = await executeToolCall({
          workspace,
          toolCall: {
            id: "write_raced_symlinked_file",
            tool: "write",
            path: "scope-link/nested/new.ts",
            content: "export const value = 1;\n",
          },
          signal: freshSignal(),
          bash: { kind: "disabled" },
          projectInstructions,
        });

        // Then
        expect(result.ok).toBe(false);
        expect(result.content).toContain(
          "Project instructions from packages/api/AGENTS.md",
        );
        expect(result.content).toContain(
          "API rule: raced symlink writes must still stop here.",
        );
        expect(await fileExists(safeTargetPath)).toBe(false);
        expect(await fileExists(apiTargetPath)).toBe(false);
        await expect(readFile(apiParentPath, "utf8")).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

  test(`Given scoped AGENTS.md is a directory,
    When a write checks that scope,
    Then the tool reports that project instructions are not a regular file`, async () => {
    // Given
    const workspace = await createWorkspace();
    await mkdir(join(workspace, "packages", "api", "AGENTS.md"), {
      recursive: true,
    });
    const projectInstructions =
      createProjectInstructionVisibilityState(workspace);
    const targetPath = join(workspace, "packages", "api", "src", "new.ts");

    try {
      // When
      const result = await executeToolCall({
        workspace,
        toolCall: {
          id: "write_api_file",
          tool: "write",
          path: "packages/api/src/new.ts",
          content: "export const value = 1;\n",
        },
        signal: freshSignal(),
        bash: { kind: "disabled" },
        projectInstructions,
      });

      // Then
      expect(result.ok).toBe(false);
      expect(result.content).toContain("not a regular file");
      expect(await fileExists(targetPath)).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")(
    `Given apply_patch adds a file through a symlinked parent into a scoped package,
    When scoped instructions are checked,
    Then the real package AGENTS.md blocks the patch before any file is written`,
    async () => {
      // Given
      const workspace = await createWorkspace();
      await mkdir(join(workspace, "packages", "api", "src"), {
        recursive: true,
      });
      await writeFile(
        join(workspace, "packages", "api", "AGENTS.md"),
        "API rule: symlinked patches still need this review.\n",
        "utf8",
      );
      await symlink(
        join(workspace, "packages", "api", "src"),
        join(workspace, "api-link"),
      );
      const projectInstructions =
        createProjectInstructionVisibilityState(workspace);
      const targetPath = join(workspace, "packages", "api", "src", "new.ts");

      try {
        // When
        const result = await executeToolCall({
          workspace,
          toolCall: {
            id: "patch_symlinked_api_file",
            tool: "apply_patch",
            patch: [
              "*** Begin Patch",
              "*** Add File: api-link/new.ts",
              "+export const value = 1;",
              "*** End Patch",
            ].join("\n"),
          },
          signal: freshSignal(),
          bash: { kind: "disabled" },
          projectInstructions,
        });

        // Then
        expect(result.ok).toBe(false);
        expect(result.content).toContain(
          "Project instructions from packages/api/AGENTS.md",
        );
        expect(result.content).toContain(
          "API rule: symlinked patches still need this review.",
        );
        expect(await fileExists(targetPath)).toBe(false);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    `Given an apply_patch add path's symlinked parent changes scopes after precheck,
    When the patch is applied,
    Then access-time scoped instructions block the add before publish`,
    async () => {
      // Given
      const workspace = await createWorkspace();
      await mkdir(join(workspace, "safe"), { recursive: true });
      await mkdir(join(workspace, "packages", "api", "src"), {
        recursive: true,
      });
      await writeFile(
        join(workspace, "packages", "api", "AGENTS.md"),
        "API rule: raced symlink patches must still stop here.\n",
        "utf8",
      );
      const linkPath = join(workspace, "scope-link");
      await symlink(join(workspace, "safe"), linkPath);
      const realProjectInstructions =
        createProjectInstructionVisibilityState(workspace);
      const projectInstructions = swapSymlinkAfterFirstMutationCheck(
        realProjectInstructions,
        () => {
          unlinkSync(linkPath);
          symlinkSync(join(workspace, "packages", "api", "src"), linkPath);
        },
      );
      const safeTargetPath = join(workspace, "safe", "new.ts");
      const apiTargetPath = join(workspace, "packages", "api", "src", "new.ts");

      try {
        // When
        const result = await executeToolCall({
          workspace,
          toolCall: {
            id: "patch_raced_symlinked_file",
            tool: "apply_patch",
            patch: [
              "*** Begin Patch",
              "*** Add File: scope-link/new.ts",
              "+export const value = 1;",
              "*** End Patch",
            ].join("\n"),
          },
          signal: freshSignal(),
          bash: { kind: "disabled" },
          projectInstructions,
        });

        // Then
        expect(result.ok).toBe(false);
        expect(result.content).toContain(
          "Project instructions from packages/api/AGENTS.md",
        );
        expect(result.content).toContain(
          "API rule: raced symlink patches must still stop here.",
        );
        expect(await fileExists(safeTargetPath)).toBe(false);
        expect(await fileExists(apiTargetPath)).toBe(false);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    `Given scoped AGENTS.md resolves to an ignored target,
    When a write checks that scope,
    Then the tool refuses to use instructions from the ignored file`,
    async () => {
      // Given
      const workspace = await createWorkspace();
      await mkdir(join(workspace, "packages", "api"), { recursive: true });
      await mkdir(join(workspace, "secret"), { recursive: true });
      await writeFile(join(workspace, ".gitignore"), "secret/\n", "utf8");
      await writeFile(
        join(workspace, "secret", "AGENTS.md"),
        "Secret rule must not leak through a symlink.\n",
        "utf8",
      );
      await symlink(
        join(workspace, "secret", "AGENTS.md"),
        join(workspace, "packages", "api", "AGENTS.md"),
      );
      const projectInstructions =
        createProjectInstructionVisibilityState(workspace);
      const targetPath = join(workspace, "packages", "api", "src", "new.ts");

      try {
        // When
        const result = await executeToolCall({
          workspace,
          toolCall: {
            id: "write_api_file",
            tool: "write",
            path: "packages/api/src/new.ts",
            content: "export const value = 1;\n",
          },
          signal: freshSignal(),
          bash: { kind: "disabled" },
          projectInstructions,
        });

        // Then
        expect(result.ok).toBe(false);
        expect(result.content).toContain(
          "ignored path: packages/api/AGENTS.md",
        );
        expect(result.content).not.toContain("Secret rule");
        expect(await fileExists(targetPath)).toBe(false);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

  test(`Given one scoped AGENTS.md applies to multiple patch targets,
    When apply_patch checks those targets before the instructions are visible,
    Then the tool reports that instruction block only once`, async () => {
    // Given
    const workspace = await createWorkspace();
    await mkdir(join(workspace, "packages", "api"), { recursive: true });
    await writeFile(
      join(workspace, "packages", "api", "AGENTS.md"),
      "API rule: generated files need headers.\n",
      "utf8",
    );
    const projectInstructions =
      createProjectInstructionVisibilityState(workspace);

    try {
      // When
      const result = await executeToolCall({
        workspace,
        toolCall: {
          id: "patch_api_files",
          tool: "apply_patch",
          patch: [
            "*** Begin Patch",
            "*** Add File: packages/api/src/a.ts",
            "+export const a = true;",
            "*** Add File: packages/api/src/b.ts",
            "+export const b = true;",
            "*** End Patch",
          ].join("\n"),
        },
        signal: freshSignal(),
        bash: { kind: "disabled" },
        projectInstructions,
      });

      // Then
      expect(result.ok).toBe(false);
      expect(
        result.content.match(
          /Project instructions from packages\/api\/AGENTS\.md/g,
        ),
      ).toHaveLength(1);
      expect(
        await fileExists(join(workspace, "packages", "api", "src", "a.ts")),
      ).toBe(false);
      expect(
        await fileExists(join(workspace, "packages", "api", "src", "b.ts")),
      ).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given scoped AGENTS.md applies to an apply_patch delete target,
    When the instructions are not visible,
    Then the delete is blocked before the file is removed`, async () => {
    // Given
    const workspace = await createWorkspace();
    await mkdir(join(workspace, "packages", "api", "src"), {
      recursive: true,
    });
    await writeFile(
      join(workspace, "packages", "api", "AGENTS.md"),
      "API rule: deletions need scoped review.\n",
      "utf8",
    );
    await writeFile(
      join(workspace, "packages", "api", "src", "obsolete.ts"),
      "export const obsolete = true;\n",
      "utf8",
    );
    const projectInstructions =
      createProjectInstructionVisibilityState(workspace);

    try {
      // When
      const result = await executeToolCall({
        workspace,
        toolCall: {
          id: "patch_delete_api_file",
          tool: "apply_patch",
          patch: [
            "*** Begin Patch",
            "*** Delete File: packages/api/src/obsolete.ts",
            "*** End Patch",
          ].join("\n"),
        },
        signal: freshSignal(),
        bash: { kind: "disabled" },
        projectInstructions,
      });

      // Then
      expect(result.ok).toBe(false);
      expect(result.content).toContain(
        "Project instructions from packages/api/AGENTS.md",
      );
      expect(result.content).toContain(
        "API rule: deletions need scoped review.",
      );
      expect(
        await fileExists(
          join(workspace, "packages", "api", "src", "obsolete.ts"),
        ),
      ).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given scoped AGENTS.md applies to an apply_patch move destination,
    When the instructions are not visible,
    Then the move is blocked before either path is changed`, async () => {
    // Given
    const workspace = await createWorkspace();
    await mkdir(join(workspace, "packages", "api", "src"), {
      recursive: true,
    });
    await writeFile(
      join(workspace, "packages", "api", "AGENTS.md"),
      "API rule: moved files need scoped review.\n",
      "utf8",
    );
    await writeFile(
      join(workspace, "old.ts"),
      "export const moved = false;\n",
      "utf8",
    );
    const projectInstructions =
      createProjectInstructionVisibilityState(workspace);

    try {
      // When
      const result = await executeToolCall({
        workspace,
        toolCall: {
          id: "patch_move_api_file",
          tool: "apply_patch",
          patch: [
            "*** Begin Patch",
            "*** Update File: old.ts",
            "*** Move to: packages/api/src/moved.ts",
            "*** End Patch",
          ].join("\n"),
        },
        signal: freshSignal(),
        bash: { kind: "disabled" },
        projectInstructions,
      });

      // Then
      expect(result.ok).toBe(false);
      expect(result.content).toContain(
        "Project instructions from packages/api/AGENTS.md",
      );
      expect(result.content).toContain(
        "API rule: moved files need scoped review.",
      );
      expect(await readFile(join(workspace, "old.ts"), "utf8")).toBe(
        "export const moved = false;\n",
      );
      expect(
        await fileExists(join(workspace, "packages", "api", "src", "moved.ts")),
      ).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given scoped instructions are visible and AGENTS.md is mutated,
    When a later mutation targets that scope,
    Then the visibility state requires the new instructions to be reviewed again`, async () => {
    // Given
    const workspace = await createWorkspace();
    await mkdir(join(workspace, "packages", "api", "src"), {
      recursive: true,
    });
    await writeFile(
      join(workspace, "packages", "api", "AGENTS.md"),
      "API rule: review me again after changes.\n",
      "utf8",
    );
    await writeFile(
      join(workspace, "packages", "api", "src", "server.ts"),
      "export const route = 'api';\n",
      "utf8",
    );
    const projectInstructions =
      createProjectInstructionVisibilityState(workspace);
    const instructionPath = await realpath(
      join(workspace, "packages", "api", "AGENTS.md"),
    );
    const targetPath = await realpath(
      join(workspace, "packages", "api", "src", "server.ts"),
    );
    projectInstructions.markInstructionPathsVisible([instructionPath]);
    projectInstructions.assertMutationAllowed([targetPath]);

    try {
      // When
      projectInstructions.applyMutationTargetPaths([instructionPath]);

      // Then
      expect(() =>
        projectInstructions.assertMutationAllowed([targetPath]),
      ).toThrow(/project instructions have not been reviewed/u);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a caller reports paths outside the workspace,
    When scoped instruction visibility records or checks them,
    Then the state ignores those paths instead of trusting outside instructions`, async () => {
    // Given
    const workspace = await createWorkspace();
    const outside = await mkdtemp(
      join(tmpdir(), "keel-scoped-project-instructions-outside-"),
    );
    await writeFile(join(outside, "AGENTS.md"), "outside rule\n", "utf8");
    const projectInstructions =
      createProjectInstructionVisibilityState(workspace);
    const outsideInstructionPath = await realpath(join(outside, "AGENTS.md"));

    try {
      // When
      projectInstructions.markInstructionPathsVisible([outsideInstructionPath]);

      // Then
      expect(projectInstructions.visibleInstructionsMostRecentFirst()).toEqual(
        [],
      );
      expect(() =>
        projectInstructions.assertMutationAllowed([
          join(outside, "escaped.ts"),
        ]),
      ).not.toThrow();
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
