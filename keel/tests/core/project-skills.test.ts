import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createProjectSkillActivation,
  discoverProjectSkillCatalog,
} from "../../src/skills/project.ts";

describe("project skills catalog", () => {
  test(`Given no project skill root exists,
    When a caller resolves a name from the empty catalog,
    Then the catalog rejects the missing skill`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-skill-empty-"));
    try {
      const catalog = discoverProjectSkillCatalog(workspace);

      expect(catalog.skills).toEqual([]);
      expect(() => catalog.load("missing")).toThrow(
        'workflow skill "missing" was not found',
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given one valid project skill is cataloged,
    When lookup requests an unknown name and activation requests a second skill,
    Then lookup fails closed and only the first activation succeeds`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-skill-once-"));
    const skillDirectory = join(workspace, ".agents", "skills", "review");
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(
      join(skillDirectory, "SKILL.md"),
      "---\nname: review\ndescription: Review a change.\n---\nRead the diff.\n",
    );

    try {
      const catalog = discoverProjectSkillCatalog(workspace);
      const activation = createProjectSkillActivation(catalog);

      expect(() => catalog.load("missing")).toThrow(
        'workflow skill "missing" was not found',
      );
      expect(activation.activate("review").record).toEqual({
        name: "review",
        relativePath: ".agents/skills/review/SKILL.md",
        trigger: "model_selected",
      });
      expect(() => activation.activate("review")).toThrow(
        'workflow skill "review" is already active',
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
