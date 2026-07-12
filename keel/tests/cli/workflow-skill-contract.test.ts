import { describe, expect, test } from "vitest";
import { isWorkflowSkillResourcePath } from "../../src/skills/resources.ts";

describe("Workflow Skill Resource Contract", () => {
  test(`Given persisted workflow skill resource path candidates,
    When the session-store contract validates them,
    Then only skill-relative files under supported resource directories are accepted`, () => {
    // Given / When / Then
    expect(isWorkflowSkillResourcePath("references/checklist.md")).toBe(true);
    expect(isWorkflowSkillResourcePath("scripts/verify.ts")).toBe(true);
    expect(isWorkflowSkillResourcePath("assets/template.txt")).toBe(true);
    expect(isWorkflowSkillResourcePath("")).toBe(false);
    expect(isWorkflowSkillResourcePath("references/bad\nname.md")).toBe(false);
    expect(isWorkflowSkillResourcePath("scripts/bad\tname.ts")).toBe(false);
    expect(isWorkflowSkillResourcePath("/references/checklist.md")).toBe(false);
    expect(isWorkflowSkillResourcePath("references\\checklist.md")).toBe(false);
    expect(isWorkflowSkillResourcePath("references")).toBe(false);
    expect(isWorkflowSkillResourcePath("references/../secret.md")).toBe(false);
    expect(isWorkflowSkillResourcePath("scratch/notes.md")).toBe(false);
  });
});
