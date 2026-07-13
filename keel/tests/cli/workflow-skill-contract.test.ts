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
    expect(isWorkflowSkillResourcePath("references/bad\u0085name.md")).toBe(
      false,
    );
    expect(isWorkflowSkillResourcePath("references/bad\u202ename.md")).toBe(
      false,
    );
    expect(isWorkflowSkillResourcePath("assets/zero\u200bwidth.txt")).toBe(
      false,
    );
    expect(isWorkflowSkillResourcePath("assets/arabic\u061cmark.txt")).toBe(
      false,
    );
    expect(isWorkflowSkillResourcePath("assets/word\u2060joiner.txt")).toBe(
      false,
    );
    expect(isWorkflowSkillResourcePath("assets/isolate\u2066mark.txt")).toBe(
      false,
    );
    expect(isWorkflowSkillResourcePath("assets/bom\ufeffmark.txt")).toBe(false);
    for (const codePoint of [0x2061, 0x2062, 0x2063, 0x2064]) {
      expect(
        isWorkflowSkillResourcePath(
          `references/safe${String.fromCodePoint(codePoint)}hidden.md`,
        ),
      ).toBe(false);
    }
    for (const codePoint of [
      0x00ad, 0x034f, 0x180e, 0x3164, 0xffa0, 0xe0001, 0xe0020,
    ]) {
      expect(
        isWorkflowSkillResourcePath(
          `references/hidden${String.fromCodePoint(codePoint)}mark.md`,
        ),
      ).toBe(false);
    }
    expect(isWorkflowSkillResourcePath("/references/checklist.md")).toBe(false);
    expect(isWorkflowSkillResourcePath("references\\checklist.md")).toBe(false);
    expect(isWorkflowSkillResourcePath("references")).toBe(false);
    expect(isWorkflowSkillResourcePath("references/../secret.md")).toBe(false);
    expect(isWorkflowSkillResourcePath("scratch/notes.md")).toBe(false);
  });
});
