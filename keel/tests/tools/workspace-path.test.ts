import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { createProjectIgnorePolicy } from "../../src/tools/project-ignore.ts";
import {
  isInsideWorkspace,
  resolveWorkspaceCreateTarget,
  resolveWorkspaceTarget,
} from "../../src/tools/workspace-path.ts";

function expectWorkspaceError(
  action: () => unknown,
  code: string,
  message: string,
): void {
  expect(action).toThrow(
    expect.objectContaining({
      name: "KeelError",
      code,
      message: expect.stringContaining(message),
    }),
  );
}

describe("Workspace Path Contract", () => {
  test(`Given candidate paths around a workspace,
    When the inside-workspace predicate evaluates them,
    Then only the workspace root and descendants are accepted`, async () => {
    // Given
    const parent = await mkdtemp(join(tmpdir(), "keel-workspace-path-"));
    const workspace = join(parent, "workspace");
    const sibling = join(parent, "workspace-sibling");
    await mkdir(join(workspace, "src"), { recursive: true });
    await mkdir(sibling);

    try {
      // When / Then
      expect(isInsideWorkspace(workspace, workspace)).toBe(true);
      expect(isInsideWorkspace(workspace, join(workspace, "src"))).toBe(true);
      expect(isInsideWorkspace(workspace, sibling)).toBe(false);
      expect(isInsideWorkspace(workspace, parent)).toBe(false);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test(`Given the workspace path is a symlink,
    When a request uses an absolute path under that symlink,
    Then create-target resolution maps it to the real workspace`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-workspace-path-"));
    const parent = await mkdtemp(join(tmpdir(), "keel-workspace-link-"));
    const workspaceLink = join(parent, "workspace-link");
    const workspacePath = await realpath(workspace);
    await symlink(workspace, workspaceLink);

    try {
      // When
      const target = resolveWorkspaceCreateTarget(
        workspaceLink,
        resolve(workspaceLink, "created.txt"),
        "write",
      );

      // Then
      expect(target.workspacePath).toBe(workspacePath);
      expect(target.targetPath).toBe(join(workspacePath, "created.txt"));
    } finally {
      await rm(parent, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given requested and resolved paths can carry different ignore meaning,
    When the target resolver validates symlinked files,
    Then it preserves the real target so callers can enforce both`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-workspace-path-"));
    await writeFile(
      join(workspace, ".gitignore"),
      "ignored-link.txt\nsecret.txt\n",
      "utf8",
    );
    await writeFile(join(workspace, "visible.txt"), "visible\n", "utf8");
    await writeFile(join(workspace, "secret.txt"), "secret\n", "utf8");
    await symlink("visible.txt", join(workspace, "ignored-link.txt"));
    await symlink("secret.txt", join(workspace, "visible-link.txt"));

    try {
      // When / Then
      expectWorkspaceError(
        () => resolveWorkspaceTarget(workspace, "ignored-link.txt", "read"),
        "tool_path_ignored",
        "ignored path",
      );
      const target = resolveWorkspaceTarget(
        workspace,
        "visible-link.txt",
        "read",
      );
      const policy = createProjectIgnorePolicy(target.workspacePath);
      expect(policy.isIgnored(target.targetPath, false)).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given requested and resolved paths can escape the workspace,
    When target and create-target resolution follows symlinks,
    Then it rejects escaped paths before returning a filesystem target`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-workspace-path-"));
    const outside = await mkdtemp(join(tmpdir(), "keel-workspace-outside-"));
    await writeFile(join(outside, "secret.txt"), "secret\n", "utf8");
    await symlink(
      join(outside, "secret.txt"),
      join(workspace, "secret-link.txt"),
    );
    await symlink(outside, join(workspace, "outside-dir"));

    try {
      // When / Then
      expectWorkspaceError(
        () =>
          resolveWorkspaceTarget(
            workspace,
            join(outside, "secret.txt"),
            "read",
          ),
        "tool_path_outside_workspace",
        "outside the workspace",
      );
      expectWorkspaceError(
        () => resolveWorkspaceTarget(workspace, "secret-link.txt", "read"),
        "tool_path_outside_workspace",
        "outside the workspace",
      );
      expectWorkspaceError(
        () =>
          resolveWorkspaceCreateTarget(
            workspace,
            "outside-dir/created.txt",
            "write",
          ),
        "tool_path_outside_workspace",
        "outside the workspace",
      );
      await expect(
        readFile(join(outside, "created.txt"), "utf8"),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test(`Given project gitignore rules cover missing and nested paths,
    When workspace resolution validates the request before existence checks,
    Then ignored missing paths are rejected without file-not-found disclosure`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-workspace-path-"));
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(
      join(workspace, ".gitignore"),
      "secret-dir/\n*.txt\n!keep.txt\n",
    );
    await writeFile(join(workspace, "src", ".gitignore"), "secret.ts\n");
    await writeFile(join(workspace, "keep.txt"), "visible\n");
    await writeFile(join(workspace, "src", "secret.ts"), "secret\n");

    try {
      // When / Then
      expectWorkspaceError(
        () =>
          resolveWorkspaceTarget(workspace, "secret-dir/missing.md", "read"),
        "tool_path_ignored",
        "ignored path",
      );
      expectWorkspaceError(
        () => resolveWorkspaceTarget(workspace, "secret-dir", "read"),
        "tool_path_ignored",
        "ignored path",
      );
      expectWorkspaceError(
        () =>
          resolveWorkspaceCreateTarget(
            workspace,
            "secret-dir/new.txt",
            "write",
          ),
        "tool_path_ignored",
        "ignored path",
      );
      expectWorkspaceError(
        () => resolveWorkspaceTarget(workspace, "src/secret.ts", "read"),
        "tool_path_ignored",
        "ignored path",
      );
      const workspacePath = await realpath(workspace);
      expect(
        resolveWorkspaceTarget(workspace, "keep.txt", "read").targetPath,
      ).toBe(join(workspacePath, "keep.txt"));
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")(
    `Given a workspace contains a Unix socket,
    When target resolution validates the path,
    Then it rejects the unsupported file type before any tool can open it`,
    async () => {
      // Given
      const workspace = await mkdtemp(join(tmpdir(), "keel-workspace-path-"));
      const socketPath = join(workspace, "socket-trap");
      const server = createServer();
      await new Promise<void>((resolveListen, rejectListen) => {
        server.once("error", rejectListen);
        server.listen(socketPath, resolveListen);
      });

      try {
        // When / Then
        expectWorkspaceError(
          () => resolveWorkspaceTarget(workspace, "socket-trap", "read"),
          "tool_not_file",
          "unsupported file type",
        );
        expectWorkspaceError(
          () => resolveWorkspaceTarget(workspace, "socket-trap", "ls"),
          "tool_not_directory",
          "not a directory",
        );
      } finally {
        await new Promise<void>((resolveClose) => {
          server.close(() => resolveClose());
        });
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

  test(`Given gitignore casing differs from the on-disk path,
    When project ignore policy checks the canonical path,
    Then case-only request differences remain ignored`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-workspace-path-"));
    await mkdir(join(workspace, "Secret"));
    await writeFile(join(workspace, ".gitignore"), "secret/\n*.pem\n", "utf8");
    await writeFile(join(workspace, "Secret", "KEY.PEM"), "secret\n", "utf8");

    try {
      // When / Then
      expectWorkspaceError(
        () => resolveWorkspaceTarget(workspace, "Secret/KEY.PEM", "read"),
        "tool_path_ignored",
        "ignored path",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
