import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parseExplicitSkillInvocation } from "../../src/skills/explicit.ts";
import {
  createSkillActivation,
  discoverSkillCatalog,
} from "../../src/skills/project.ts";

describe("project skills catalog", () => {
  test(`Given a root-discriminated qualified identity,
    When the user invokes it through the dollar surface,
    Then the parser preserves the actionable identity and task arguments`, () => {
    expect(
      parseExplicitSkillInvocation("$repo:012345abcdef:review inspect PR 430"),
    ).toEqual({
      lookup: "repo:012345abcdef:review",
      arguments: "inspect PR 430",
    });
  });

  test(`Given no project skill root exists,
    When a caller resolves a name from the empty catalog,
    Then the catalog rejects the missing skill`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-skill-empty-"));
    try {
      const catalog = discoverSkillCatalog({ workspace });

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
      const catalog = discoverSkillCatalog({ workspace });
      const activation = createSkillActivation(catalog);
      activation.expose(catalog.implicitSkills);

      expect(() => catalog.load("missing")).toThrow(
        'workflow skill "missing" was not found',
      );
      expect(activation.activate("review").record).toEqual({
        name: "repo:review",
        relativePath: ".agents/skills/review/SKILL.md",
        trigger: "model_selected",
      });
      expect(() => activation.activate("review")).toThrow(
        'workflow skill "repo:review" is already active',
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an implicit skill was omitted from the exposed catalog,
    When activation guesses its name before and after catalog search,
    Then Keel rejects the guess until search authorizes the exact descriptor`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-skill-search-gate-"));
    const skillDirectory = join(workspace, ".agents", "skills", "review");
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(
      join(skillDirectory, "SKILL.md"),
      "---\nname: review\ndescription: Review a change.\n---\nRead the diff.\n",
    );

    try {
      const catalog = discoverSkillCatalog({ workspace });
      const activation = createSkillActivation(catalog);

      expect(() => activation.activate("repo:review")).toThrow(
        "is not in the exposed catalog or recent search results",
      );
      expect(
        activation.search("review").map((skill) => skill.qualifiedName),
      ).toEqual(["repo:review"]);
      expect(activation.activate("repo:review").record.name).toBe(
        "repo:review",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an implicit skill is already active through an explicit surface,
    When model-selected activation finds the same package through search,
    Then Keel rejects the duplicate cross-trigger activation`, async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-skill-explicit-model-duplicate-"),
    );
    const skillDirectory = join(workspace, ".agents", "skills", "review");
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(
      join(skillDirectory, "SKILL.md"),
      "---\nname: review\ndescription: Review a change.\n---\nRead the diff.\n",
    );

    try {
      const catalog = discoverSkillCatalog({ workspace });
      const activation = createSkillActivation(catalog);
      activation.registerExplicit([catalog.load("repo:review")]);
      activation.search("review");

      expect(() => activation.activate("repo:review")).toThrow(
        'workflow skill "repo:review" is already active',
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given two repository roots contain the same skill name,
    When lookup uses the ordinary scope name and a root-qualified identity,
    Then ambiguity lists two actionable identities and either exact identity loads`, async () => {
    const project = await mkdtemp(join(tmpdir(), "keel-skill-root-clash-"));
    const workspace = join(project, "package");
    await mkdir(join(project, ".git"), { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(
      join(workspace, ".git"),
      "gitdir: ../.git/worktrees/package\n",
    );
    for (const [root, body] of [
      [project, "outer instructions"],
      [workspace, "inner instructions"],
    ] as const) {
      const skillDirectory = join(root, ".agents", "skills", "review");
      await mkdir(skillDirectory, { recursive: true });
      await writeFile(
        join(skillDirectory, "SKILL.md"),
        `---\nname: review\ndescription: Review from ${body}.\n---\n${body}\n`,
      );
    }

    try {
      const catalog = discoverSkillCatalog({ workspace });
      const identities = catalog.skills.map((skill) => skill.qualifiedName);

      expect(identities).toHaveLength(2);
      expect(new Set(identities).size).toBe(2);
      expect(
        identities.every((identity) =>
          /^repo:[a-f0-9]{12}:review$/u.test(identity),
        ),
      ).toBe(true);
      expect(() => catalog.load("repo:review")).toThrow(
        expect.objectContaining({
          message: expect.stringContaining(identities[0] ?? "missing"),
        }),
      );
      expect(
        identities.map((identity) => catalog.load(identity).content).toSorted(),
      ).toEqual(["inner instructions", "outer instructions"]);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test(`Given the same configured root is repeated,
    When the scoped catalog is discovered,
    Then the canonical root contributes one resolvable descriptor`, async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-skill-repeat-workspace-"),
    );
    const extraRoot = await mkdtemp(join(tmpdir(), "keel-skill-repeat-extra-"));
    const skillDirectory = join(extraRoot, "review");
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(
      join(skillDirectory, "SKILL.md"),
      "---\nname: review\ndescription: Review from one configured root.\n---\nreview\n",
    );

    try {
      const catalog = discoverSkillCatalog({
        workspace,
        extraRoots: [extraRoot, extraRoot],
      });

      expect(catalog.skills.map((skill) => skill.qualifiedName)).toEqual([
        "extra:review",
      ]);
      expect(catalog.load("extra:review").content).toBe("review");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(extraRoot, { recursive: true, force: true });
    }
  });

  test(`Given a cataloged skill becomes invalid or disappears after discovery,
    When lookup requests it,
    Then Keel returns the actionable validation or atomicity failure`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-skill-invalid-load-"));
    const skillDirectory = join(workspace, ".agents", "skills", "review");
    await mkdir(skillDirectory, { recursive: true });
    const skillPath = join(skillDirectory, "SKILL.md");
    await writeFile(
      skillPath,
      "---\nname: review\ndescription: Review changes.\nmetadata:\n  keel.activation: sometimes\n---\nreview\n",
    );

    try {
      const invalidCatalog = discoverSkillCatalog({ workspace });
      expect(() => invalidCatalog.load("repo:review")).toThrow(
        'metadata.keel.activation must be "implicit" or "explicit"',
      );
      await writeFile(
        skillPath,
        "---\nname: review\ndescription: Review changes.\n---\nreview\n",
      );
      const catalog = discoverSkillCatalog({ workspace });
      await rm(skillPath);
      expect(() => catalog.load("repo:review")).toThrow(
        'workflow skill "repo:review" was not found',
      );
      expect(() => catalog.load("repo:a:b:c")).toThrow(
        "qualified skill names use scope:name or scope:root-id:name",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a skill advertises one resource,
    When callers use inactive, invalid, missing, valid, and stale resource paths,
    Then every resource authorization boundary fails closed`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-skill-resources-"));
    const skillDirectory = join(workspace, ".agents", "skills", "review");
    const references = join(skillDirectory, "references");
    await mkdir(references, { recursive: true });
    const skillPath = join(skillDirectory, "SKILL.md");
    await writeFile(
      skillPath,
      "---\nname: review\ndescription: Review changes.\n---\nread marker\n",
    );
    await writeFile(join(references, "marker.txt"), "RESOURCE-OK");

    try {
      const catalog = discoverSkillCatalog({ workspace });
      const activation = createSkillActivation(catalog);
      expect(() =>
        activation.readResource("repo:review", "references/marker.txt"),
      ).toThrow("must be active before reading its resources");
      expect(() => catalog.readResource("repo:review", "notes.md")).toThrow(
        "must stay under references/, scripts/, or assets/",
      );
      expect(() =>
        catalog.readResource("repo:review", "references/missing.txt"),
      ).toThrow("was not discovered");
      activation.registerExplicit([catalog.load("repo:review")]);
      expect(
        activation.readResource("repo:review", "references/marker.txt"),
      ).toBe("RESOURCE-OK");
      await writeFile(
        skillPath,
        "---\nname: review\ndescription: Review changes.\n---\nchanged\n",
      );
      expect(() =>
        catalog.readResource("repo:review", "references/marker.txt"),
      ).toThrow("changed after catalog discovery");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given searchable skills vary by scope, name, description, and root,
    When the full catalog is searched with blank and bounded queries,
    Then deterministic ranking and limits cover every relevance path`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-skill-search-rank-"));
    const userRoot = await mkdtemp(join(tmpdir(), "keel-skill-search-user-"));
    for (const [root, name, description] of [
      [join(workspace, ".agents", "skills"), "review", "Inspect code"],
      [join(workspace, ".agents", "skills"), "deploy", "Review releases"],
      [userRoot, "release", "Ship code"],
    ] as const) {
      const directory = join(root, name);
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${description}.\n---\n${name}\n`,
      );
    }

    try {
      const catalog = discoverSkillCatalog({ workspace, userRoot });
      expect(catalog.search("", -1)).toEqual([]);
      expect(catalog.search("repo:review")[0]?.qualifiedName).toBe(
        "repo:review",
      );
      expect(catalog.search("review").map((skill) => skill.name)).toEqual([
        "review",
        "deploy",
      ]);
      expect(catalog.search("r").map((skill) => skill.name)).toEqual([
        "review",
        "release",
        "deploy",
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(userRoot, { recursive: true, force: true });
    }
  });
});
