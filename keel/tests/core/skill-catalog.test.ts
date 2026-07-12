import { describe, expect, test } from "vitest";
import { exposeSkillCatalog } from "../../src/skills/catalog.ts";
import type { SkillDescriptor } from "../../src/skills/model.ts";

function descriptor(options: {
  readonly name: string;
  readonly rootPriority: number;
  readonly description?: string;
  readonly qualifiedName?: string;
  readonly relativePath?: string;
  readonly scope?: "repo" | "user";
}): SkillDescriptor {
  const scope = options.scope ?? "repo";
  return {
    id: `${scope}:root:${options.name}:digest`,
    packageId: `${scope}:root:${options.name}`,
    rootKey: "root",
    rootPriority: options.rootPriority,
    qualifiedName: options.qualifiedName ?? `${scope}:${options.name}`,
    scope,
    activationPolicy: "implicit",
    name: options.name,
    description: options.description ?? "x".repeat(1_000),
    relativePath:
      options.relativePath ?? `.agents/skills/${options.name}/SKILL.md`,
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

  test(`Given request terms exercise exact, partial, short, and description matches,
    When catalog ranking has identity and path ties under a tiny known context,
    Then relevance and every deterministic tie-break remain bounded`, () => {
    const skills = [
      descriptor({
        name: "review",
        rootPriority: 1,
        description: "Inspect releases",
      }),
      descriptor({
        name: "deploy",
        rootPriority: 1,
        description: "Review releases",
        scope: "user",
      }),
      descriptor({
        name: "same",
        rootPriority: 2,
        description: "Same",
        qualifiedName: "repo:same",
        relativePath: "z/SKILL.md",
      }),
      descriptor({
        name: "same",
        rootPriority: 2,
        description: "Same",
        qualifiedName: "repo:same",
        relativePath: "a/SKILL.md",
      }),
    ];

    const exposure = exposeSkillCatalog({
      skills,
      request: "x repo:review rev releases",
      modelMetadata: {
        status: "known",
        contextWindowTokens: 1,
        maxOutputTokens: null,
        capabilities: {
          textInput: true,
          toolCalls: true,
          reasoning: false,
        },
        costModel: null,
        lastVerified: "2026-01-01",
        source: "registry",
      },
    });

    expect(exposure.budgetChars).toBe(1);
    expect(exposure.skills).toEqual([]);
    expect(exposure.omitted).toBe(4);
    expect(
      exposeSkillCatalog({
        skills,
        request: "same",
        modelMetadata: {
          status: "known",
          contextWindowTokens: null,
          maxOutputTokens: null,
          capabilities: {
            textInput: true,
            toolCalls: true,
            reasoning: false,
          },
          costModel: null,
          lastVerified: "2026-01-01",
          source: "registry",
        },
      })
        .skills.filter((skill) => skill.name === "same")
        .map((skill) => skill.relativePath),
    ).toEqual(["a/SKILL.md", "z/SKILL.md"]);
  });
});
