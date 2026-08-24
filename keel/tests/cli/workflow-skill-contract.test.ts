import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { setAllWorkflowSkillsEnabled } from "../../src/cli/skill-user-config.ts";
import {
  discoverWorkflowSkillCatalog,
  filterWorkflowSkillCatalog,
  formatWorkflowSkillList,
} from "../../src/cli/workflow-skills.ts";
import type {
  DiscoveredSkillCatalog,
  SkillDescriptor,
  WorkflowSkill,
} from "../../src/skills/model.ts";
import { WorkflowSkillError } from "../../src/skills/model.ts";
import { resolveSkillDescriptor } from "../../src/skills/project.ts";
import { isWorkflowSkillResourcePath } from "../../src/skills/resources.ts";

function descriptor(name: string): SkillDescriptor {
  return {
    id: `repo:root:${name}:digest`,
    packageId: `repo:root:${name}`,
    rootKey: "root",
    rootPriority: 0,
    qualifiedName: `repo:${name}`,
    scope: "repo",
    activationPolicy: "implicit",
    name,
    description: `${name} description`,
    relativePath: `.agents/skills/${name}/SKILL.md`,
    digest: "digest",
  };
}

function workflowSkill(skill: SkillDescriptor): WorkflowSkill {
  return {
    id: skill.id,
    packageId: skill.packageId,
    qualifiedName: skill.qualifiedName,
    scope: skill.scope,
    digest: skill.digest,
    relativePath: skill.relativePath,
    name: skill.name,
    resourcePaths: ["references/marker.txt"],
    content: `${skill.name} body`,
  };
}

describe("Workflow Skill Resource Contract", () => {
  test(`Given KEEL_HOME is a symbolic link,
    When user controls and managed Skill discovery resolve private state,
    Then both owners reject the linked boundary`, async () => {
    // Given
    const parent = await mkdtemp(join(tmpdir(), "keel-skill-linked-home-"));
    const workspace = join(parent, "workspace");
    const target = join(parent, "target");
    const home = join(parent, "home");
    await mkdir(workspace);
    await mkdir(target);
    await symlink(target, home, "dir");
    const runtime = {
      env: (key: string) => {
        if (key === "KEEL_HOME") return home;
        if (key === "HOME") return parent;
        return undefined;
      },
    };

    try {
      // When / Then
      expect(() => setAllWorkflowSkillsEnabled(runtime, false)).toThrow(
        /symbolic link/u,
      );
      expect(() => discoverWorkflowSkillCatalog(runtime, workspace)).toThrow(
        WorkflowSkillError,
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test(`Given private Skill path resolution raises an unexpected runtime failure,
    When user controls and managed Skill discovery resolve their roots,
    Then both owners preserve the unexpected failure`, () => {
    // Given
    const unexpected = new Error("runtime env failed");
    const runtime = {
      env: (key: string) => {
        if (key === "HOME") return tmpdir();
        if (key === "KEEL_HOME") throw unexpected;
        return undefined;
      },
    };

    // When / Then
    expect(() => setAllWorkflowSkillsEnabled(runtime, false)).toThrow(
      unexpected,
    );
    expect(() => discoverWorkflowSkillCatalog(runtime, tmpdir())).toThrow(
      unexpected,
    );
  });

  test(`Given one package is disabled in a mixed catalog,
    When every lazy catalog operation resolves a package,
    Then disabled identities fail closed and enabled identities remain usable`, () => {
    // Given
    const review = descriptor("review");
    const qa = descriptor("qa");
    const skills = [review, qa];
    const load = (lookup: string): WorkflowSkill =>
      workflowSkill(resolveSkillDescriptor(skills, lookup));
    const catalog: DiscoveredSkillCatalog = {
      skills,
      implicitSkills: skills,
      warnings: [],
      audits: [],
      repositoryPackageWorkspacePaths: (_workspace, packageIds) =>
        packageIds === "all"
          ? skills.map((skill) => skill.packageId)
          : packageIds,
      load,
      loadImplicit: load,
      loadPackage: (packageId) => {
        const skill = skills.find(
          (candidate) => candidate.packageId === packageId,
        );
        return skill === undefined ? undefined : workflowSkill(skill);
      },
      search: () => skills,
      readResource: (lookup, path) =>
        `${resolveSkillDescriptor(skills, lookup).qualifiedName}:${path}`,
      readPackageResource: (packageId, digest, path) =>
        `${packageId}:${digest}:${path}`,
    };
    const filtered = filterWorkflowSkillCatalog(catalog, [review.packageId]);

    // When / Then
    expect(filtered.skills).toEqual([qa]);
    expect(
      filtered.repositoryPackageWorkspacePaths("/workspace", [
        review.packageId,
        qa.packageId,
      ]),
    ).toEqual([review.packageId, qa.packageId]);
    expect(
      filtered.repositoryPackageWorkspacePaths("/workspace", "all"),
    ).toEqual([review.packageId, qa.packageId]);
    expect(() => filtered.load("review")).toThrow(
      'workflow skill "repo:review" is disabled by user configuration',
    );
    expect(() => filtered.load("missing")).toThrow(
      'workflow skill "missing" was not found',
    );
    expect(filtered.loadImplicit("qa").qualifiedName).toBe("repo:qa");
    expect(filtered.loadPackage(review.packageId)).toBeUndefined();
    expect(filtered.loadPackage(qa.packageId)?.qualifiedName).toBe("repo:qa");
    expect(filtered.search("anything", 1)).toEqual([qa]);
    expect(filtered.readResource("qa", "references/marker.txt")).toBe(
      "repo:qa:references/marker.txt",
    );
    expect(() =>
      filtered.readResource("review", "references/marker.txt"),
    ).toThrow(WorkflowSkillError);
    expect(() =>
      filtered.readPackageResource(
        review.packageId,
        review.digest,
        "references/marker.txt",
      ),
    ).toThrow('workflow skill "repo:review" is disabled');
    expect(() =>
      filterWorkflowSkillCatalog(catalog, [
        "repo:missing:ghost",
      ]).readPackageResource(
        "repo:missing:ghost",
        "digest",
        "references/marker.txt",
      ),
    ).toThrow('workflow skill "repo:missing:ghost" is disabled');
    expect(
      filtered.readPackageResource(
        qa.packageId,
        qa.digest,
        "references/marker.txt",
      ),
    ).toBe("repo:root:qa:digest:references/marker.txt");
    expect(formatWorkflowSkillList([])).toBe(
      "No workflow skills found across repo, user, system, or extra scopes.\n",
    );
    expect(formatWorkflowSkillList([], { globallyEnabled: false })).toContain(
      "Workflow skills are globally disabled.",
    );
  });

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
