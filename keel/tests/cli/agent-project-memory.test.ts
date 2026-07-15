import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createAgentProjectMemory } from "../../src/cli/agent-project-memory.ts";
import { createGitWorkspace } from "../../src/testing/cli-harness.ts";

describe("CLI Agent Project Memory", () => {
  test(`Given an agent memory capability mutates project memory,
    When it adds lists forgets and snapshots operations,
    Then operations expose stable IDs scopes and outcomes without sharing mutable state`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-agent-project-memory-");
    const keelHome = await mkdtemp(
      join(tmpdir(), "keel-agent-project-memory-home-"),
    );
    const runtime = {
      env: (key: string) => (key === "KEEL_HOME" ? keelHome : undefined),
      now: () => Date.UTC(2026, 0, 1),
    };
    const agentMemory = createAgentProjectMemory({ runtime, workspace });

    try {
      // When
      const saved = agentMemory.capability.add(
        "Release tags use a v prefix.",
        "Remember that release tags use a v prefix.",
      );
      const listAfterAdd = agentMemory.capability.list();
      const afterAdd = agentMemory.operations();
      const forgotten = agentMemory.capability.forget(
        saved.id,
        `Forget ${saved.id}.`,
      );

      // Then
      expect(listAfterAdd).toEqual([
        { id: saved.id, text: "Release tags use a v prefix." },
      ]);
      expect(agentMemory.capability.list()).toEqual([]);
      expect(forgotten).toEqual({ id: saved.id, scope: saved.scope });
      expect(afterAdd).toEqual([
        {
          operation: "add",
          id: saved.id,
          scope: saved.scope,
          outcome: "saved",
        },
      ]);
      expect(agentMemory.operations()).toEqual([
        {
          operation: "add",
          id: saved.id,
          scope: saved.scope,
          outcome: "saved",
        },
        {
          operation: "forget",
          id: saved.id,
          scope: saved.scope,
          outcome: "forgotten",
        },
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(keelHome, { recursive: true, force: true });
    }
  });
});
