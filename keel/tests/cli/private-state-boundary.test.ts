import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createAgentTreeHistory } from "../../src/cli/agent-tree-store.ts";
import { addMcpServer } from "../../src/cli/mcp-config.ts";
import { addProjectMemory } from "../../src/cli/project-memory.ts";
import {
  createSessionStore,
  resumeSessionStore,
} from "../../src/cli/session-store.ts";
import {
  readUserSkillConfig,
  setAllWorkflowSkillsEnabled,
} from "../../src/cli/skill-user-config.ts";
import {
  createToolOutputArtifactStore,
  showToolOutputArtifact,
} from "../../src/cli/tool-output-artifacts.ts";

function runtime(home: string) {
  return {
    env: (key: string) => (key === "KEEL_HOME" ? home : undefined),
    now: () => 0,
  };
}

async function withTempRoot<T>(
  prefix: string,
  action: (root: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await action(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function linkedAncestorState(root: string): Promise<{
  readonly home: string;
  readonly externalHome: string;
}> {
  const outside = join(root, "outside");
  const link = join(root, "linked-ancestor");
  const externalHome = join(outside, "nested", "home");
  const home = join(link, "nested", "home");
  await mkdir(outside);
  await symlink(outside, link, "dir");
  return { home, externalHome };
}

async function freshState(root: string, name: string): Promise<string> {
  const home = join(root, name);
  await mkdir(home, { recursive: true });
  return home;
}

async function freshWorkspace(root: string, name: string): Promise<string> {
  const workspace = join(root, name);
  await mkdir(workspace, { recursive: true });
  return workspace;
}

describe("private state boundary", () => {
  test(`Given KEEL_HOME has a linked ancestor,
    When MCP configuration writes private state,
    Then Keel rejects the ancestor link before creating external state`, async () => {
    await withTempRoot("keel-private-state-mcp-ancestor-", async (root) => {
      const { home, externalHome } = await linkedAncestorState(root);

      await expect(
        addMcpServer(runtime(home), {
          id: "linked",
          url: "https://example.com/mcp",
          enabled: true,
          allowPrivateNetwork: false,
          authenticationRequired: false,
          toolFilter: { allow: null, deny: [] },
        }),
      ).rejects.toThrow(/symbolic link/u);
      await expect(
        rm(externalHome, { recursive: true, force: false }),
      ).rejects.toThrow();
    });
  });

  test(`Given KEEL_HOME has a linked ancestor,
    When workflow Skills configuration writes private state,
    Then Keel rejects the ancestor link before creating external state`, async () => {
    await withTempRoot("keel-private-state-skills-ancestor-", async (root) => {
      const { home, externalHome } = await linkedAncestorState(root);

      expect(() => setAllWorkflowSkillsEnabled(runtime(home), false)).toThrow(
        /symbolic link/u,
      );
      await expect(
        rm(externalHome, { recursive: true, force: false }),
      ).rejects.toThrow();
    });
  });

  test(`Given KEEL_HOME has a linked ancestor,
    When a session is created,
    Then Keel rejects the ancestor link before writing the ledger externally`, async () => {
    await withTempRoot("keel-private-state-session-ancestor-", async (root) => {
      const { home, externalHome } = await linkedAncestorState(root);
      const workspace = await freshWorkspace(root, "workspace");

      expect(() =>
        createSessionStore({
          sessionId: "linked-session",
          workspace,
          runtime: runtime(home),
        }),
      ).toThrow(/symbolic link/u);
      await expect(
        rm(externalHome, { recursive: true, force: false }),
      ).rejects.toThrow();
    });
  });

  test(`Given KEEL_HOME has a linked ancestor,
    When a tool output artifact is stored,
    Then Keel rejects the ancestor link before writing artifact content externally`, async () => {
    await withTempRoot(
      "keel-private-state-artifact-ancestor-",
      async (root) => {
        const { home, externalHome } = await linkedAncestorState(root);
        const store = createToolOutputArtifactStore({
          runtime: runtime(home),
          scope: "linked-artifacts",
        });

        const saved = await store.save({
          toolName: "grep",
          toolCallId: "call_1",
          purpose: "settlement",
          sourceStatus: "complete",
          content: "private artifact content",
        });

        expect(saved.status).toBe("failed");
        if (saved.status === "failed") {
          expect(saved.reason).toMatch(/symbolic link/u);
        }
        await expect(
          rm(externalHome, { recursive: true, force: false }),
        ).rejects.toThrow();
      },
    );
  });

  test(`Given KEEL_HOME has a linked ancestor,
    When project memory writes private state,
    Then Keel rejects the ancestor link before writing memory externally`, async () => {
    await withTempRoot("keel-private-state-memory-ancestor-", async (root) => {
      const { home, externalHome } = await linkedAncestorState(root);
      const workspace = await freshWorkspace(root, "workspace");

      expect(() =>
        addProjectMemory(
          runtime(home),
          workspace,
          "Project memory must stay under the configured owner.",
          {
            type: "user_explicit",
            channel: "cli",
            evidence: "memory add",
          },
          { reviewAfter: null, expiresAt: null },
        ),
      ).toThrow(/symbolic link/u);
      await expect(
        rm(externalHome, { recursive: true, force: false }),
      ).rejects.toThrow();
    });
  });

  test(`Given KEEL_HOME has a linked ancestor,
    When the agent tree creates its private history,
    Then Keel rejects the ancestor link before writing agent-tree state externally`, async () => {
    await withTempRoot(
      "keel-private-state-agent-tree-ancestor-",
      async (root) => {
        const { home, externalHome } = await linkedAncestorState(root);

        expect(() =>
          createAgentTreeHistory({
            sessionId: "linked-agent-tree",
            runtime: runtime(home),
          }),
        ).toThrow(/symbolic link/u);
        await expect(
          rm(externalHome, { recursive: true, force: false }),
        ).rejects.toThrow();
      },
    );
  });

  test(`Given MCP config is a final symlink to an external file,
    When MCP configuration is read before a write,
    Then Keel rejects the file instead of replacing or trusting it`, async () => {
    await withTempRoot("keel-private-state-mcp-file-link-", async (root) => {
      const home = await freshState(root, "home");
      const externalConfig = join(root, "external-mcp.json");
      await writeFile(
        externalConfig,
        `${JSON.stringify({
          schemaVersion: 4,
          servers: [],
        })}\n`,
      );
      await symlink(externalConfig, join(home, "mcp.json"));

      await expect(
        addMcpServer(runtime(home), {
          id: "linked",
          url: "https://example.com/mcp",
          enabled: true,
          allowPrivateNetwork: false,
          authenticationRequired: false,
          toolFilter: { allow: null, deny: [] },
        }),
      ).rejects.toThrow(/symbolic link/u);
    });
  });

  test(`Given workflow Skills config is a final symlink to an external file,
    When Skills configuration is read,
    Then Keel rejects the file instead of trusting external state`, async () => {
    await withTempRoot("keel-private-state-skills-file-link-", async (root) => {
      const home = await freshState(root, "home");
      const externalConfig = join(root, "external-skills.json");
      await writeFile(
        externalConfig,
        `${JSON.stringify({
          schemaVersion: 1,
          enabled: false,
          disabledPackageIds: [],
        })}\n`,
      );
      await symlink(externalConfig, join(home, "skills.json"));

      expect(() => readUserSkillConfig(runtime(home))).toThrow(
        /symbolic link/u,
      );
    });
  });

  test(`Given a session ledger is a final symlink to an external file,
    When the session is resumed,
    Then Keel rejects the ledger instead of replaying external state`, async () => {
    await withTempRoot(
      "keel-private-state-session-file-link-",
      async (root) => {
        const home = await freshState(root, "home");
        const outsideHome = await freshState(root, "outside-home");
        const workspace = await freshWorkspace(root, "workspace");
        createSessionStore({
          sessionId: "linked-session",
          workspace,
          runtime: runtime(outsideHome),
        });
        await mkdir(join(home, "sessions", "linked-session"), {
          recursive: true,
        });
        await symlink(
          join(outsideHome, "sessions", "linked-session", "ledger.jsonl"),
          join(home, "sessions", "linked-session", "ledger.jsonl"),
        );

        expect(() =>
          resumeSessionStore({
            sessionId: "linked-session",
            workspace,
            runtime: runtime(home),
          }),
        ).toThrow(/symbolic link/u);
      },
    );
  });

  test(`Given a tool-output artifact is a final symlink to an external file,
    When the artifact is shown,
    Then Keel rejects the file instead of printing external content`, async () => {
    await withTempRoot(
      "keel-private-state-artifact-file-link-",
      async (root) => {
        const home = await freshState(root, "home");
        await mkdir(join(home, "artifacts", "tool-output", "scope"), {
          recursive: true,
        });
        const externalArtifact = join(root, "external-artifact.txt");
        await writeFile(externalArtifact, "external artifact content\n");
        await symlink(
          externalArtifact,
          join(home, "artifacts", "tool-output", "scope", "linked.txt"),
        );

        const result = await showToolOutputArtifact({
          runtime: runtime(home),
          ref: "tool-output:scope/linked",
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.message).toMatch(/symbolic link/u);
        }
      },
    );
  });

  test(`Given a project memory event file is a final symlink to external memory,
    When project memory appends a new event,
    Then Keel rejects the file instead of appending to external memory`, async () => {
    await withTempRoot("keel-private-state-memory-file-link-", async (root) => {
      const home = await freshState(root, "home");
      const outsideHome = await freshState(root, "outside-home");
      const workspace = await freshWorkspace(root, "workspace");
      const externalMemory = addProjectMemory(
        runtime(outsideHome),
        workspace,
        "External memory must not be extended through a link.",
        {
          type: "user_explicit",
          channel: "cli",
          evidence: "memory add",
        },
        { reviewAfter: null, expiresAt: null },
      );
      const localProjectDirectory = join(
        home,
        "memory",
        "projects",
        externalMemory.scope.id,
      );
      await mkdir(localProjectDirectory, { recursive: true });
      await symlink(
        join(
          outsideHome,
          "memory",
          "projects",
          externalMemory.scope.id,
          "events.jsonl",
        ),
        join(localProjectDirectory, "events.jsonl"),
      );

      expect(() =>
        addProjectMemory(
          runtime(home),
          workspace,
          "Local memory must not write through the link.",
          {
            type: "user_explicit",
            channel: "cli",
            evidence: "memory add",
          },
          { reviewAfter: null, expiresAt: null },
        ),
      ).toThrow(/symbolic link/u);
    });
  });

  test(`Given an agent-tree ledger is a final symlink to an external file,
    When agent-tree history is opened,
    Then Keel rejects the ledger instead of replaying external child-agent state`, async () => {
    await withTempRoot("keel-private-state-agent-file-link-", async (root) => {
      const home = await freshState(root, "home");
      const outsideHome = await freshState(root, "outside-home");
      const sessionId = "linked-agent-tree";
      const externalEvents = join(
        outsideHome,
        "sessions",
        sessionId,
        "agents",
        "events.jsonl",
      );
      createAgentTreeHistory({
        sessionId,
        runtime: runtime(outsideHome),
      });
      await mkdir(join(home, "sessions", sessionId, "agents"), {
        recursive: true,
      });
      await symlink(
        externalEvents,
        join(home, "sessions", sessionId, "agents", "events.jsonl"),
      );

      expect(() =>
        createAgentTreeHistory({
          sessionId,
          runtime: runtime(home),
        }),
      ).toThrow(/symbolic link/u);
    });
  });
});
