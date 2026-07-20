import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../src/agent/events.ts";
import { runAgent } from "../../src/agent/loop.ts";
import { defaultStopPolicy } from "../../src/agent/stop-policy.ts";
import {
  createFakeProvider,
  fakeResponse,
  fakeToolResponse,
} from "../../src/llm/providers/fake.ts";
import { createSkillActivation } from "../../src/skills/lifecycle.ts";
import type {
  SkillCatalog,
  SkillDescriptor,
  WorkflowSkill,
} from "../../src/skills/model.ts";

const REVIEW_SKILL: WorkflowSkill = {
  id: "repo:root:review:digest",
  packageId: "repo:root:review",
  qualifiedName: "repo:review",
  scope: "repo",
  digest: "digest",
  relativePath: ".agents/skills/review/SKILL.md",
  name: "review",
  resourcePaths: [],
  content: "Review changed files carefully.",
};

const REVIEW_DESCRIPTOR: SkillDescriptor = {
  id: REVIEW_SKILL.id,
  packageId: REVIEW_SKILL.packageId,
  rootKey: "root",
  rootPriority: 0,
  qualifiedName: REVIEW_SKILL.qualifiedName,
  scope: REVIEW_SKILL.scope,
  activationPolicy: "implicit",
  name: REVIEW_SKILL.name,
  description: "Review changed files.",
  relativePath: REVIEW_SKILL.relativePath,
  digest: REVIEW_SKILL.digest,
};

function skillCatalog(): SkillCatalog {
  return {
    skills: [REVIEW_DESCRIPTOR],
    implicitSkills: [REVIEW_DESCRIPTOR],
    warnings: [],
    audits: [],
    load: () => REVIEW_SKILL,
    loadImplicit: () => REVIEW_SKILL,
    loadPackage: () => REVIEW_SKILL,
    search: () => [REVIEW_DESCRIPTOR],
    readResource: () => "",
    readPackageResource: () => "",
  };
}

async function collect(
  source: AsyncIterable<AgentEvent>,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of source) {
    events.push(event);
  }
  return events;
}

describe("Agent Skill Activation", () => {
  test(`Given the model activates a workflow skill,
    When the tool execution succeeds,
    Then the agent publishes the skill activation event`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-agent-skill-"));
    const skillActivation = createSkillActivation(skillCatalog(), {
      now: () => "1970-01-01T00:00:00.000Z",
    });
    skillActivation.expose([REVIEW_DESCRIPTOR]);

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider: createFakeProvider([
            fakeToolResponse("skill", { name: REVIEW_SKILL.qualifiedName }),
            fakeResponse("Reviewed."),
          ]),
          userMessage: "review this change",
          systemPrompt: "You are a helpful assistant.",
          signal: new AbortController().signal,
          bash: { kind: "disabled" },
          stopPolicy: defaultStopPolicy(),
          skillActivation,
        }),
      );

      // Then
      expect(events).toContainEqual({
        type: "skill_activated",
        name: REVIEW_SKILL.qualifiedName,
        relativePath: REVIEW_SKILL.relativePath,
        trigger: "model_selected",
      });
      expect(events).toContainEqual({
        type: "text",
        text: "Reviewed.",
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
