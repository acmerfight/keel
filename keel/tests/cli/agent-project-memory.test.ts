import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createAgentProjectMemory } from "../../src/cli/agent-project-memory.ts";
import { rejectProjectMemoryCandidate } from "../../src/cli/project-memory-candidates.ts";
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

  test(`Given reviewed proposals conflict, contain sensitive evidence, or lose approval input,
    When the project-memory owner handles them,
    Then conflicts and interruptions stay pending while sensitive text is never recorded`, async () => {
    const workspace = await createGitWorkspace("keel-agent-reviewed-memory-");
    const keelHome = await mkdtemp(
      join(tmpdir(), "keel-agent-reviewed-memory-home-"),
    );
    const runtime = {
      env: (key: string) => (key === "KEEL_HOME" ? keelHome : undefined),
      now: () => Date.UTC(2026, 0, 1),
    };
    const agentMemory = createAgentProjectMemory({ runtime, workspace });

    try {
      const active = agentMemory.capability.add(
        "Release validation uses pnpm test.",
        "Remember the current release validation command.",
      );
      let reviewCalls = 0;
      const conflict = await agentMemory.proposalCapability.propose(
        {
          kind: "project_context",
          statement: "Release validation uses pnpm test:coverage.",
          why: "The release command may have changed.",
          sourceQuote: "pnpm test:coverage",
          conflictMemoryIds: [active.id],
        },
        {
          sessionId: "review-session",
          messageId: "msg_conflict",
          providerId: "deepseek",
          model: "deepseek-chat",
        },
        async () => {
          reviewCalls++;
          return { type: "approve" };
        },
        new AbortController().signal,
      );
      const interrupted = await agentMemory.proposalCapability.propose(
        {
          kind: "user_preference",
          statement: "Prefer concise release notes.",
          why: "This preference may help later writing.",
          sourceQuote: "concise release notes",
          conflictMemoryIds: [],
        },
        {
          sessionId: "review-session",
          messageId: "msg_interrupted",
          providerId: "deepseek",
          model: "deepseek-chat",
        },
        async () => {
          reviewCalls++;
          return { type: "pending" };
        },
        new AbortController().signal,
      );
      const secret = `ghp_${"S".repeat(36)}`;

      await expect(
        agentMemory.proposalCapability.propose(
          {
            kind: "reference",
            statement: "Use the release credential.",
            why: "It may be reused.",
            sourceQuote: secret,
            conflictMemoryIds: [],
          },
          {
            sessionId: "review-session",
            messageId: "msg_secret",
            providerId: "deepseek",
            model: "deepseek-chat",
          },
          async () => {
            throw new Error("sensitive proposal must not reach review");
          },
          new AbortController().signal,
        ),
      ).rejects.toThrow("candidate source was not stored");
      expect(conflict).toMatchObject({
        memoryId: null,
        outcome: "pending",
      });
      expect(interrupted).toMatchObject({
        memoryId: null,
        outcome: "pending",
      });
      expect(reviewCalls).toBe(1);
      expect(agentMemory.operations().slice(-2)).toEqual([
        expect.objectContaining({
          candidateId: conflict.candidateId,
          outcome: "pending",
        }),
        expect.objectContaining({
          candidateId: interrupted.candidateId,
          outcome: "pending",
        }),
      ]);

      await expect(
        agentMemory.proposalCapability.propose(
          {
            kind: "project_context",
            statement: "Release branches require two reviewers.",
            why: "The rule should survive later sessions.",
            sourceQuote: "two reviewers",
            conflictMemoryIds: [],
          },
          {
            sessionId: "review-session",
            messageId: "msg_race",
            providerId: "deepseek",
            model: "deepseek-chat",
          },
          async (request) => {
            rejectProjectMemoryCandidate(
              runtime,
              workspace,
              request.candidateId,
            );
            return { type: "approve" };
          },
          new AbortController().signal,
        ),
      ).rejects.toThrow("rejected, not pending");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(keelHome, { recursive: true, force: true });
    }
  });
});
