import { appendFile, mkdtemp, readFile, rm, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createSessionStore,
  forkSessionStore,
  listSessionCatalog,
  persistSessionMessages,
  persistSessionSkillState,
  resumeSessionStore,
} from "../../../src/cli/session-store.ts";
import { skillActivationFromWorkflowSkill } from "../../../src/skills/lifecycle.ts";
import type { WorkflowSkill } from "../../../src/skills/model.ts";
import {
  restoredUserMessageId,
  runtime,
} from "../../../src/testing/session-store-fixtures.ts";

function workflowSkill(name: string, digest: string): WorkflowSkill {
  return {
    id: `repo:root:${name}:${digest}`,
    packageId: `repo:root:${name}`,
    qualifiedName: `repo:${name}`,
    scope: "repo",
    digest,
    relativePath: `.agents/skills/${name}/SKILL.md`,
    name,
    resourcePaths: [],
    content: `${name} instructions`,
  };
}

function activation(skill: WorkflowSkill, activatedAt: string) {
  return skillActivationFromWorkflowSkill({
    skill,
    trigger: "user_explicit",
    args: "",
    activatedAt,
  });
}

describe("Session Store Skill Lifecycle", () => {
  test(`Given a completed turn model-selects a Skill,
    When transcript and lifecycle state are committed,
    Then one append record durably contains both or neither`, async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-session-skill-atomic-workspace-"),
    );
    const home = await mkdtemp(
      join(tmpdir(), "keel-session-skill-atomic-home-"),
    );
    const review = activation(
      workflowSkill("review", "review-digest"),
      "1970-01-01T00:00:00.000Z",
    );
    const messages = [
      { role: "user", content: "review alpha" },
      { role: "assistant", content: "Reviewed alpha.", toolCalls: [] },
    ] as const;

    try {
      const session = createSessionStore({
        sessionId: "atomic",
        workspace,
        runtime: runtime(home),
      });

      // When
      persistSessionMessages({
        session,
        previousMessages: [],
        currentMessages: messages,
        runtime: runtime(home, 1),
        reason: "turn",
        skillState: {
          skillActivations: [review],
          activeSkillIds: [review.descriptorId],
        },
      });

      // Then
      const records = (await readFile(session.filePath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(records.map((record) => record.type)).toEqual([
        "session",
        "append",
      ]);
      expect(records[1]).toMatchObject({
        type: "append",
        skillState: {
          skillActivations: [{ qualifiedName: "repo:review" }],
          activeSkillIds: [review.descriptorId],
        },
      });
      expect(
        resumeSessionStore({
          sessionId: "atomic",
          workspace,
          runtime: runtime(home, 2),
        }).activeSkillIds,
      ).toEqual([review.descriptorId]);
      expect(
        listSessionCatalog({ workspace, runtime: runtime(home, 3) }).sessions[0]
          ?.workflowSkills,
      ).toEqual([expect.objectContaining({ qualifiedName: "repo:review" })]);

      const replacementMessages = [
        { role: "user", content: "review replacement" },
        {
          role: "assistant",
          content: "Reviewed replacement.",
          toolCalls: [],
        },
      ] as const;
      persistSessionMessages({
        session,
        previousMessages: messages,
        currentMessages: replacementMessages,
        runtime: runtime(home, 4),
        reason: "compaction",
        skillState: {
          skillActivations: [review],
          activeSkillIds: [review.descriptorId],
        },
      });
      expect(
        resumeSessionStore({
          sessionId: "atomic",
          workspace,
          runtime: runtime(home, 5),
        }).messages,
      ).toEqual(replacementMessages);

      const finalMessages = [
        { role: "user", content: "review final" },
        { role: "assistant", content: "Reviewed final.", toolCalls: [] },
      ] as const;
      persistSessionMessages({
        session,
        previousMessages: replacementMessages,
        currentMessages: finalMessages,
        runtime: runtime(home, 6),
        reason: "compaction",
      });
      expect(
        listSessionCatalog({ workspace, runtime: runtime(home, 7) }).sessions[0]
          ?.workflowSkills,
      ).toEqual([expect.objectContaining({ qualifiedName: "repo:review" })]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a ledger mutation contains corrupt Skill lifecycle references,
    When resume or oversized-snapshot probing validates it,
    Then duplicate, missing, and same-package active identities are rejected`, async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-session-skill-invalid-workspace-"),
    );
    const home = await mkdtemp(
      join(tmpdir(), "keel-session-skill-invalid-home-"),
    );
    const review = activation(
      workflowSkill("review", "review-digest"),
      "1970-01-01T00:00:00.000Z",
    );
    const changedReview = activation(
      {
        ...workflowSkill("review", "changed-digest"),
        id: "repo:root:review:changed-digest",
      },
      "1970-01-01T00:00:00.001Z",
    );
    const invalidStates = [
      {
        skillActivations: [review],
        activeSkillIds: [review.descriptorId, review.descriptorId],
      },
      { skillActivations: [], activeSkillIds: ["missing"] },
      {
        skillActivations: [review, changedReview],
        activeSkillIds: [review.descriptorId, changedReview.descriptorId],
      },
    ] as const;

    try {
      for (const [index, state] of invalidStates.entries()) {
        const sessionId = `invalid-${index}`;
        const session = createSessionStore({
          sessionId,
          workspace,
          runtime: runtime(home, index),
        });
        await appendFile(
          session.filePath,
          `${JSON.stringify({
            schemaVersion: 4,
            type: "skill_state",
            timestamp: "1970-01-01T00:00:00.010Z",
            messageOrdinal: 0,
            ...state,
          })}\n`,
        );
        expect(() =>
          resumeSessionStore({
            sessionId,
            workspace,
            runtime: runtime(home, 20 + index),
          }),
        ).toThrow("not a valid session mutation record");
      }

      const oversized = createSessionStore({
        sessionId: "invalid-oversized-snapshot",
        workspace,
        runtime: runtime(home, 30),
      });
      await truncate(oversized.filePath, 32 * 1024 * 1024 + 1);
      await appendFile(
        oversized.filePath,
        `\n${JSON.stringify({
          schemaVersion: 4,
          type: "snapshot",
          timestamp: "1970-01-01T00:00:00.031Z",
          reason: "size_threshold",
          messages: [],
          pendingInputs: [],
          skillStateCheckpoints: [{ messageOrdinal: 0, ...invalidStates[0] }],
        })}\n`,
      );
      expect(() =>
        resumeSessionStore({
          sessionId: "invalid-oversized-snapshot",
          workspace,
          runtime: runtime(home, 32),
        }),
      ).toThrow("no bounded snapshot was found");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given active Skill state changes between completed prompts,
    When the session is forked at a historical prompt and at the end,
    Then each fork inherits the activation ledger and active set from its fork point`, async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-session-skill-workspace-"),
    );
    const home = await mkdtemp(join(tmpdir(), "keel-session-skill-home-"));
    const review = activation(
      workflowSkill("review", "review-digest"),
      "1970-01-01T00:00:00.000Z",
    );
    const qa = activation(
      workflowSkill("qa", "qa-digest"),
      "1970-01-01T00:00:00.001Z",
    );
    const firstMessages = [
      { role: "user", content: "review alpha" },
      { role: "assistant", content: "Reviewed alpha.", toolCalls: [] },
    ] as const;
    const allMessages = [
      ...firstMessages,
      { role: "user", content: "test beta" },
      { role: "assistant", content: "Tested beta.", toolCalls: [] },
    ] as const;

    try {
      const source = createSessionStore({
        sessionId: "source",
        workspace,
        runtime: runtime(home),
        skillState: {
          skillActivations: [review],
          activeSkillIds: [review.descriptorId],
        },
      });
      persistSessionMessages({
        session: source,
        previousMessages: [],
        currentMessages: firstMessages,
        runtime: runtime(home, 1),
        reason: "turn",
      });
      persistSessionSkillState({
        session: source,
        state: {
          skillActivations: [review, qa],
          activeSkillIds: [review.descriptorId, qa.descriptorId],
        },
        runtime: runtime(home, 2),
        consumedInputIds: [],
      });
      persistSessionMessages({
        session: source,
        previousMessages: firstMessages,
        currentMessages: allMessages,
        runtime: runtime(home, 3),
        reason: "turn",
      });
      persistSessionSkillState({
        session: source,
        state: {
          skillActivations: [review, qa],
          activeSkillIds: [qa.descriptorId],
        },
        runtime: runtime(home, 4),
      });
      const restoredSource = resumeSessionStore({
        sessionId: "source",
        workspace,
        runtime: runtime(home, 5),
      });
      const secondUserId = restoredUserMessageId(restoredSource, "test beta");

      // When
      const historical = forkSessionStore({
        source: restoredSource,
        targetSessionId: "historical",
        forkPoint: {
          beforeMessageId: secondUserId,
          optionName: "--before-message",
        },
        runtime: runtime(home, 6),
      });
      const atEnd = forkSessionStore({
        source: restoredSource,
        targetSessionId: "at-end",
        runtime: runtime(home, 7),
      });

      // Then
      expect(historical.skillActivations).toEqual([review, qa]);
      expect(historical.activeSkillIds).toEqual([
        review.descriptorId,
        qa.descriptorId,
      ]);
      expect(atEnd.skillActivations).toEqual([review, qa]);
      expect(atEnd.activeSkillIds).toEqual([qa.descriptorId]);
      expect(
        resumeSessionStore({
          sessionId: "historical",
          workspace,
          runtime: runtime(home, 8),
        }).activeSkillIds,
      ).toEqual([review.descriptorId, qa.descriptorId]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
});
