import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { executeToolCall } from "../../src/tools/execution.ts";
import { createProjectInstructionVisibilityState } from "../../src/tools/scoped-project-instructions.ts";

const fsRace = vi.hoisted(() => ({
  agentsPath: "",
  ignoredAgentsPath: "",
  swapped: false,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: (
      path: string | Buffer | URL,
      flags: string | number,
      mode?: string | number,
    ) => {
      if (
        typeof path === "string" &&
        path === fsRace.agentsPath &&
        !fsRace.swapped
      ) {
        fsRace.swapped = true;
        actual.unlinkSync(fsRace.agentsPath);
        actual.symlinkSync(fsRace.ignoredAgentsPath, fsRace.agentsPath);
      }
      return actual.openSync(path, flags, mode);
    },
  };
});

function freshSignal(): AbortSignal {
  return new AbortController().signal;
}

describe("Scoped Project Instructions Race Handling", () => {
  test(`Given AGENTS.md is swapped to an ignored symlink after validation,
    When scoped instructions are read,
    Then the ignored content is rejected before it reaches tool output`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-scoped-project-instructions-race-"),
    );
    const agentsPath = join(workspace, "packages", "api", "AGENTS.md");
    const ignoredAgentsPath = join(workspace, "secret", "AGENTS.md");
    await mkdir(join(workspace, "packages", "api", "src"), {
      recursive: true,
    });
    await mkdir(join(workspace, "secret"), { recursive: true });
    await writeFile(join(workspace, ".gitignore"), "secret/\n", "utf8");
    await writeFile(
      agentsPath,
      "API rule: original instructions were validated.\n",
      "utf8",
    );
    await writeFile(
      ignoredAgentsPath,
      "Ignored rule must not reach the provider.\n",
      "utf8",
    );
    await writeFile(
      join(workspace, "packages", "api", "src", "server.ts"),
      "export const route = 'api';\n",
      "utf8",
    );
    fsRace.agentsPath = await realpath(agentsPath);
    fsRace.ignoredAgentsPath = ignoredAgentsPath;
    fsRace.swapped = false;

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
        projectInstructions: createProjectInstructionVisibilityState(workspace),
      });

      // Then
      expect(result.ok).toBe(false);
      expect(result.content).toContain(
        "project instructions failed: ignored path: packages/api/AGENTS.md",
      );
      expect(result.content).not.toContain(
        "Ignored rule must not reach the provider.",
      );
      expect(fsRace.swapped).toBe(true);
    } finally {
      fsRace.agentsPath = "";
      fsRace.ignoredAgentsPath = "";
      fsRace.swapped = false;
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")(
    `Given AGENTS.md is swapped to a directory after validation,
    When scoped instructions are read,
    Then the raced directory is rejected before content decoding`,
    async () => {
      // Given
      const workspace = await mkdtemp(
        join(tmpdir(), "keel-scoped-project-instructions-race-"),
      );
      const agentsPath = join(workspace, "packages", "api", "AGENTS.md");
      const replacementDirectory = join(workspace, "replacement-agents-dir");
      await mkdir(join(workspace, "packages", "api", "src"), {
        recursive: true,
      });
      await mkdir(replacementDirectory);
      await writeFile(
        agentsPath,
        "API rule: original instructions were validated.\n",
        "utf8",
      );
      await writeFile(
        join(workspace, "packages", "api", "src", "server.ts"),
        "export const route = 'api';\n",
        "utf8",
      );
      fsRace.agentsPath = await realpath(agentsPath);
      fsRace.ignoredAgentsPath = replacementDirectory;
      fsRace.swapped = false;

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
          projectInstructions:
            createProjectInstructionVisibilityState(workspace),
        });

        // Then
        expect(result.ok).toBe(false);
        expect(result.content).toContain(
          "project instructions failed: packages/api/AGENTS.md is not a regular file",
        );
        expect(fsRace.swapped).toBe(true);
      } finally {
        fsRace.agentsPath = "";
        fsRace.ignoredAgentsPath = "";
        fsRace.swapped = false;
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );
});
