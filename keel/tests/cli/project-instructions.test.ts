import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { loadProjectInstructions } from "../../src/cli/project-instructions.ts";

describe("Project Instructions", () => {
  test(`Given root AGENTS is a symlink escaping the workspace,
    When project instructions are loaded,
    Then the outside file is rejected before any content can be injected`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-agents-workspace-"));
    const outside = await mkdtemp(join(tmpdir(), "keel-agents-outside-"));
    await writeFile(join(outside, "secret.txt"), "SECRET_OUTSIDE_WORKSPACE");
    await symlink(join(outside, "secret.txt"), join(workspace, "AGENTS.md"));

    try {
      // When / Then
      expect(() => loadProjectInstructions(workspace)).toThrow(
        /outside the workspace/i,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test(`Given root AGENTS is a symlink to an ignored workspace file,
    When project instructions are loaded,
    Then the ignored file is rejected before any content can be injected`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-ignored-agents-"));
    await writeFile(join(workspace, ".gitignore"), "secret.env\n", "utf8");
    await writeFile(join(workspace, "secret.env"), "SECRET_FROM_GITIGNORE");
    await symlink(join(workspace, "secret.env"), join(workspace, "AGENTS.md"));

    try {
      // When / Then
      expect(() => loadProjectInstructions(workspace)).toThrow(/ignored path/i);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given root AGENTS is a dangling symlink,
    When project instructions are loaded,
    Then startup reports the broken project instructions path`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-dangling-agents-"));
    await symlink(join(workspace, "missing.md"), join(workspace, "AGENTS.md"));

    try {
      // When / Then
      expect(() => loadProjectInstructions(workspace)).toThrow(
        /cannot load AGENTS\.md/i,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given root AGENTS is a symlink loop,
    When project instructions are loaded,
    Then startup reports the broken project instructions path`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-loop-agents-"));
    await symlink("AGENTS.md", join(workspace, "AGENTS.md"));

    try {
      // When / Then
      expect(() => loadProjectInstructions(workspace)).toThrow(
        /cannot load AGENTS\.md/i,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given root AGENTS is too large for automatic prompt injection,
    When project instructions are loaded,
    Then startup rejects the file instead of reading it into context`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-large-agents-"));
    await writeFile(join(workspace, "AGENTS.md"), "x".repeat(50 * 1024 + 1));

    try {
      // When / Then
      expect(() => loadProjectInstructions(workspace)).toThrow(/too large/i);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given root AGENTS is binary data,
    When project instructions are loaded,
    Then startup rejects it instead of sending binary content to the provider`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-binary-agents-"));
    await writeFile(
      join(workspace, "AGENTS.md"),
      Buffer.from([0x00, 0x01, 0x02, 0x03]),
    );

    try {
      // When / Then
      expect(() => loadProjectInstructions(workspace)).toThrow(/binary/i);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given root AGENTS is a directory,
    When project instructions are loaded,
    Then startup rejects it as non-file project guidance`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-directory-agents-"));
    await mkdir(join(workspace, "AGENTS.md"));

    try {
      // When / Then
      expect(() => loadProjectInstructions(workspace)).toThrow(/regular file/i);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given root AGENTS is not valid UTF-8 text,
    When project instructions are loaded,
    Then startup rejects it instead of sending corrupted text to the provider`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-invalid-agents-"));
    await writeFile(join(workspace, "AGENTS.md"), Buffer.from([0xc3, 0x28]));

    try {
      // When / Then
      expect(() => loadProjectInstructions(workspace)).toThrow(/UTF-8/i);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given root AGENTS instructions are empty,
    When project instructions are loaded,
    Then the workspace has no project guidance to inject`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-empty-agents-"));
    await writeFile(join(workspace, "AGENTS.md"), "\n\n", "utf8");

    try {
      // When
      const projectInstructions = loadProjectInstructions(workspace);

      // Then
      expect(projectInstructions).toBeUndefined();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
