import { describe, expect, test } from "vitest";
import { exposeSkillCatalog } from "../../src/skills/catalog.ts";
import type { SkillDescriptor } from "../../src/skills/model.ts";

function descriptor(options: {
  readonly name: string;
  readonly rootPriority: number;
}): SkillDescriptor {
  return {
    id: `repo:root:${options.name}:digest`,
    packageId: `repo:root:${options.name}`,
    rootKey: "root",
    rootPriority: options.rootPriority,
    qualifiedName: `repo:${options.name}`,
    scope: "repo",
    activationPolicy: "implicit",
    name: options.name,
    description: "x".repeat(1_000),
    relativePath: `.agents/skills/${options.name}/SKILL.md`,
    digest: "digest",
  };
}

describe("skill catalog exposure", () => {
  test(`Given equally relevant repository skills exceed the catalog budget,
    When their roots have different proximity,
    Then the nearer repository descriptor is exposed first`, () => {
    const nearer = descriptor({ name: "nearer", rootPriority: 0 });
    const farther = Array.from({ length: 8 }, (_, index) =>
      descriptor({ name: `farther-${index}`, rootPriority: 2 }),
    );

    const exposure = exposeSkillCatalog({
      skills: [...farther, nearer],
      request: "unrelated request",
    });

    expect(exposure.skills[0]?.qualifiedName).toBe("repo:nearer");
    expect(exposure.omitted).toBeGreaterThan(0);
  });
});
