import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ToolAccesses, toolCallAccesses } from "../../src/tools/tool-access.ts";

async function createWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "keel-tool-access-"));
  await mkdir(join(workspace, "src"), { recursive: true });
  await mkdir(join(workspace, "docs"), { recursive: true });
  await writeFile(join(workspace, "src", "a.txt"), "a old\n", "utf8");
  await writeFile(join(workspace, "src", "b.txt"), "b old\n", "utf8");
  await writeFile(join(workspace, "src", "AGENTS.md"), "rules\n", "utf8");
  await writeFile(join(workspace, "docs", "old.txt"), "old\n", "utf8");
  await writeFile(join(workspace, "docs", "delete.txt"), "delete\n", "utf8");
  return workspace;
}

describe("Tool Access", () => {
  test(`Given file resources use read, search, write, readwrite, and all access,
    When access sets are compared,
    Then only write-overlapping resources conflict`, () => {
    expect(
      ToolAccesses.conflict(
        ToolAccesses.readFile("/w/src/a.txt"),
        ToolAccesses.readFile("/w/src/a.txt"),
      ),
    ).toBe(false);
    expect(
      ToolAccesses.conflict(
        ToolAccesses.readFile("/w/src/a.txt"),
        ToolAccesses.readWriteFile("/w/src/a.txt"),
      ),
    ).toBe(true);
    expect(
      ToolAccesses.conflict(
        ToolAccesses.searchTree("/w/src"),
        ToolAccesses.writeFile("/w/src/new.txt"),
      ),
    ).toBe(true);
    expect(
      ToolAccesses.conflict(
        ToolAccesses.readTree("/w/src"),
        ToolAccesses.writeFile("/w/docs/new.txt"),
      ),
    ).toBe(false);
    expect(
      ToolAccesses.conflict(
        ToolAccesses.all(),
        ToolAccesses.readFile("/w/src/a.txt"),
      ),
    ).toBe(true);
    expect(
      ToolAccesses.conflict(
        ToolAccesses.readTree("/w/src/"),
        ToolAccesses.writeFile("/w/src/new.txt/"),
      ),
    ).toBe(true);
    expect(
      ToolAccesses.conflict(
        ToolAccesses.readTree("/"),
        ToolAccesses.writeFile("/tmp/new.txt"),
      ),
    ).toBe(true);
    expect(
      ToolAccesses.conflict(
        ToolAccesses.readFile("/tmp/new.txt"),
        ToolAccesses.writeTree("/"),
      ),
    ).toBe(true);
  });

  test(`Given builtin tool calls target different workspace resources,
    When scheduling access is derived,
    Then independent file mutations can share a same-turn batch while tree searches still protect their scope`, async () => {
    // Given
    const workspace = await createWorkspace();

    try {
      // When
      const editA = toolCallAccesses(workspace, {
        id: "edit_a",
        tool: "edit",
        path: "src/a.txt",
        edits: [{ oldText: "a old", newText: "a new" }],
      });
      const writeDocs = toolCallAccesses(workspace, {
        id: "write_docs",
        tool: "write",
        path: "docs/new.txt",
        content: "new\n",
      });
      const writeParent = toolCallAccesses(workspace, {
        id: "write_parent",
        tool: "write",
        path: "generated",
        content: "parent\n",
      });
      const writeChild = toolCallAccesses(workspace, {
        id: "write_child",
        tool: "write",
        path: "generated/child.txt",
        content: "child\n",
      });
      const grepSrc = toolCallAccesses(workspace, {
        id: "grep_src",
        tool: "grep",
        pattern: "old",
        path: "src",
      });
      const lsRoot = toolCallAccesses(workspace, {
        id: "ls_root",
        tool: "ls",
      });
      const globDocs = toolCallAccesses(workspace, {
        id: "glob_docs",
        tool: "glob",
        pattern: "*.txt",
        path: "docs",
      });

      // Then
      expect(ToolAccesses.conflict(editA, writeDocs)).toBe(false);
      expect(ToolAccesses.conflict(writeParent, writeChild)).toBe(true);
      expect(ToolAccesses.conflict(editA, grepSrc)).toBe(true);
      expect(ToolAccesses.conflict(editA, lsRoot)).toBe(true);
      expect(ToolAccesses.conflict(editA, globDocs)).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given apply_patch calls describe file additions, updates, deletes, and moves,
    When scheduling access is derived,
    Then overlapping mutations conflict and unrelated files can still run independently`, async () => {
    // Given
    const workspace = await createWorkspace();

    try {
      // When
      const patchAccesses = toolCallAccesses(workspace, {
        id: "patch_files",
        tool: "apply_patch",
        patch: [
          "*** Begin Patch",
          "*** Update File: src/a.txt",
          "@@",
          "-a old",
          "+a new",
          "*** Add File: docs/new.txt",
          "+new",
          "*** Delete File: docs/delete.txt",
          "*** Update File: docs/old.txt",
          "*** Move to: docs/moved.txt",
          "@@",
          "-old",
          "+old moved",
          "*** End Patch",
        ].join("\n"),
      });
      const editA = toolCallAccesses(workspace, {
        id: "edit_a",
        tool: "edit",
        path: "src/a.txt",
        edits: [{ oldText: "a old", newText: "a newer" }],
      });
      const writeOther = toolCallAccesses(workspace, {
        id: "write_other",
        tool: "write",
        path: "src/other.txt",
        content: "other\n",
      });
      const addParentPatch = toolCallAccesses(workspace, {
        id: "add_parent",
        tool: "apply_patch",
        patch: [
          "*** Begin Patch",
          "*** Add File: generated",
          "+parent",
          "*** End Patch",
        ].join("\n"),
      });
      const writeChild = toolCallAccesses(workspace, {
        id: "write_child",
        tool: "write",
        path: "generated/child.txt",
        content: "child\n",
      });

      // Then
      expect(ToolAccesses.conflict(patchAccesses, editA)).toBe(true);
      expect(ToolAccesses.conflict(patchAccesses, writeOther)).toBe(false);
      expect(ToolAccesses.conflict(addParentPatch, writeChild)).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given create targets are addressed through a symlinked parent directory,
    When scheduling access is derived,
    Then equivalent real destinations still conflict`, async () => {
    // Given
    const workspace = await createWorkspace();

    try {
      await symlink(
        join(workspace, "docs"),
        join(workspace, "docs-link"),
        "dir",
      );

      // When
      const writeRealPath = toolCallAccesses(workspace, {
        id: "write_real_path",
        tool: "write",
        path: "docs/generated.txt",
        content: "generated\n",
      });
      const writeAliasPath = toolCallAccesses(workspace, {
        id: "write_alias_path",
        tool: "write",
        path: "docs-link/generated.txt",
        content: "generated\n",
      });
      const addAliasPatch = toolCallAccesses(workspace, {
        id: "add_alias_patch",
        tool: "apply_patch",
        patch: [
          "*** Begin Patch",
          "*** Add File: docs-link/generated.txt",
          "+generated",
          "*** End Patch",
        ].join("\n"),
      });
      const moveAliasPatch = toolCallAccesses(workspace, {
        id: "move_alias_patch",
        tool: "apply_patch",
        patch: [
          "*** Begin Patch",
          "*** Update File: docs/old.txt",
          "*** Move to: docs-link/moved.txt",
          "@@",
          "-old",
          "+moved",
          "*** End Patch",
        ].join("\n"),
      });
      const writeMovedRealPath = toolCallAccesses(workspace, {
        id: "write_moved_real_path",
        tool: "write",
        path: "docs/moved.txt",
        content: "moved\n",
      });

      // Then
      expect(ToolAccesses.conflict(writeRealPath, writeAliasPath)).toBe(true);
      expect(ToolAccesses.conflict(writeRealPath, addAliasPatch)).toBe(true);
      expect(ToolAccesses.conflict(moveAliasPatch, writeMovedRealPath)).toBe(
        true,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a tool call may affect global process state or project instructions,
    When scheduling access is derived,
    Then the scheduler treats it as globally conflicting`, async () => {
    // Given
    const workspace = await createWorkspace();

    try {
      // When
      const readA = toolCallAccesses(workspace, {
        id: "read_a",
        tool: "read",
        path: "src/a.txt",
      });
      const bashAccesses = toolCallAccesses(workspace, {
        id: "run_tests",
        tool: "bash",
        command: "pnpm test",
      });
      const editInstructions = toolCallAccesses(workspace, {
        id: "edit_instructions",
        tool: "edit",
        path: "AGENTS.md",
        edits: [{ oldText: "old", newText: "new" }],
      });
      const invalidPatch = toolCallAccesses(workspace, {
        id: "invalid_patch",
        tool: "apply_patch",
        patch: "not a patch",
      });
      await symlink(
        join(workspace, "src", "AGENTS.md"),
        join(workspace, "agents-link.md"),
      );
      const writeInstructions = toolCallAccesses(workspace, {
        id: "write_instructions",
        tool: "write",
        path: "AGENTS.md",
        content: "rules\n",
      });
      const editInstructionAlias = toolCallAccesses(workspace, {
        id: "edit_instruction_alias",
        tool: "edit",
        path: "agents-link.md",
        edits: [{ oldText: "rules", newText: "new rules" }],
      });
      const patchInstructionAlias = toolCallAccesses(workspace, {
        id: "patch_instruction_alias",
        tool: "apply_patch",
        patch: [
          "*** Begin Patch",
          "*** Update File: agents-link.md",
          "@@",
          "-rules",
          "+new rules",
          "*** End Patch",
        ].join("\n"),
      });
      const addInstructionsPatch = toolCallAccesses(workspace, {
        id: "add_instructions_patch",
        tool: "apply_patch",
        patch: [
          "*** Begin Patch",
          "*** Add File: AGENTS.md",
          "+rules",
          "*** End Patch",
        ].join("\n"),
      });
      const deleteInstructionAliasPatch = toolCallAccesses(workspace, {
        id: "delete_instruction_alias_patch",
        tool: "apply_patch",
        patch: [
          "*** Begin Patch",
          "*** Delete File: agents-link.md",
          "*** End Patch",
        ].join("\n"),
      });
      const moveToInstructionsPatch = toolCallAccesses(workspace, {
        id: "move_to_instructions_patch",
        tool: "apply_patch",
        patch: [
          "*** Begin Patch",
          "*** Update File: docs/old.txt",
          "*** Move to: AGENTS.md",
          "@@",
          "-old",
          "+rules",
          "*** End Patch",
        ].join("\n"),
      });

      // Then
      expect(ToolAccesses.conflict(readA, bashAccesses)).toBe(true);
      expect(ToolAccesses.conflict(readA, editInstructions)).toBe(true);
      expect(ToolAccesses.conflict(readA, writeInstructions)).toBe(true);
      expect(ToolAccesses.conflict(readA, invalidPatch)).toBe(true);
      expect(ToolAccesses.conflict(readA, editInstructionAlias)).toBe(true);
      expect(ToolAccesses.conflict(readA, patchInstructionAlias)).toBe(true);
      expect(ToolAccesses.conflict(readA, addInstructionsPatch)).toBe(true);
      expect(ToolAccesses.conflict(readA, deleteInstructionAliasPatch)).toBe(
        true,
      );
      expect(ToolAccesses.conflict(readA, moveToInstructionsPatch)).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given tool calls target paths outside the workspace or unavailable workspace metadata,
    When scheduling access is derived,
    Then the scheduler treats them as globally conflicting`, async () => {
    // Given
    const workspace = await createWorkspace();
    const missingWorkspace = join(workspace, "missing-workspace");
    const outsidePath = join(tmpdir(), "keel-tool-access-outside.txt");

    try {
      // When
      const readA = toolCallAccesses(workspace, {
        id: "read_a",
        tool: "read",
        path: "src/a.txt",
      });
      const missingWorkspaceWrite = toolCallAccesses(missingWorkspace, {
        id: "missing_workspace_write",
        tool: "write",
        path: "new.txt",
        content: "new\n",
      });
      const outsideRead = toolCallAccesses(workspace, {
        id: "outside_read",
        tool: "read",
        path: outsidePath,
      });
      const outsideLs = toolCallAccesses(workspace, {
        id: "outside_ls",
        tool: "ls",
        path: outsidePath,
      });
      const outsideGlob = toolCallAccesses(workspace, {
        id: "outside_glob",
        tool: "glob",
        pattern: "*.txt",
        path: outsidePath,
      });
      const outsideGrep = toolCallAccesses(workspace, {
        id: "outside_grep",
        tool: "grep",
        pattern: "needle",
        path: outsidePath,
      });
      const outsideEdit = toolCallAccesses(workspace, {
        id: "outside_edit",
        tool: "edit",
        path: outsidePath,
        edits: [{ oldText: "old", newText: "new" }],
      });
      const outsideWrite = toolCallAccesses(workspace, {
        id: "outside_write",
        tool: "write",
        path: outsidePath,
        content: "new\n",
      });
      const outsideAddPatch = toolCallAccesses(workspace, {
        id: "outside_add_patch",
        tool: "apply_patch",
        patch: [
          "*** Begin Patch",
          `*** Add File: ${outsidePath}`,
          "+new",
          "*** End Patch",
        ].join("\n"),
      });
      const outsideDeletePatch = toolCallAccesses(workspace, {
        id: "outside_delete_patch",
        tool: "apply_patch",
        patch: [
          "*** Begin Patch",
          `*** Delete File: ${outsidePath}`,
          "*** End Patch",
        ].join("\n"),
      });
      const outsideUpdatePatch = toolCallAccesses(workspace, {
        id: "outside_update_patch",
        tool: "apply_patch",
        patch: [
          "*** Begin Patch",
          `*** Update File: ${outsidePath}`,
          "@@",
          "-old",
          "+new",
          "*** End Patch",
        ].join("\n"),
      });
      const moveOutsidePatch = toolCallAccesses(workspace, {
        id: "move_outside_patch",
        tool: "apply_patch",
        patch: [
          "*** Begin Patch",
          "*** Update File: docs/old.txt",
          `*** Move to: ${outsidePath}`,
          "@@",
          "-old",
          "+new",
          "*** End Patch",
        ].join("\n"),
      });

      // Then
      for (const accesses of [
        missingWorkspaceWrite,
        outsideRead,
        outsideLs,
        outsideGlob,
        outsideGrep,
        outsideEdit,
        outsideWrite,
        outsideAddPatch,
        outsideDeletePatch,
        outsideUpdatePatch,
        moveOutsidePatch,
      ]) {
        expect(ToolAccesses.conflict(readA, accesses)).toBe(true);
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
