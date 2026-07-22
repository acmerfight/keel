import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parseExplicitSkillInvocation } from "../../src/skills/explicit.ts";
import {
  createSkillActivation,
  skillActivationFromWorkflowSkill,
  skillLifecycleStatesEqual,
} from "../../src/skills/lifecycle.ts";
import {
  type SkillCatalog,
  type WorkflowSkill,
  WorkflowSkillError,
} from "../../src/skills/model.ts";
import { discoverSkillCatalog } from "../../src/skills/project.ts";

function workflowSkill(
  options: {
    readonly id?: string;
    readonly packageId?: string;
    readonly qualifiedName?: string;
    readonly name?: string;
    readonly digest?: string;
    readonly resourcePaths?: readonly string[];
  } = {},
): WorkflowSkill {
  const name = options.name ?? "review";
  const digest = options.digest ?? "digest-one";
  return {
    id: options.id ?? `repo:root:${name}:${digest}`,
    packageId: options.packageId ?? `repo:root:${name}`,
    qualifiedName: options.qualifiedName ?? `repo:${name}`,
    scope: "repo",
    digest,
    relativePath: `.agents/skills/${name}/SKILL.md`,
    name,
    resourcePaths: options.resourcePaths ?? ["references/guide.md"],
    content: `${name} ${digest}`,
  };
}

function inMemoryCatalog(
  options: {
    readonly loadPackage?: SkillCatalog["loadPackage"];
    readonly readPackageResource?: SkillCatalog["readPackageResource"];
  } = {},
): SkillCatalog {
  return {
    skills: [],
    implicitSkills: [],
    warnings: [],
    audits: [],
    load: () => {
      throw new WorkflowSkillError("not configured");
    },
    loadImplicit: () => {
      throw new WorkflowSkillError("not configured");
    },
    loadPackage: options.loadPackage ?? (() => undefined),
    search: () => [],
    readResource: () => {
      throw new WorkflowSkillError("not configured");
    },
    readPackageResource:
      options.readPackageResource ??
      (() => {
        throw new WorkflowSkillError("not configured");
      }),
  };
}

describe("project skills catalog", () => {
  test(`Given lifecycle snapshots are restored from durable state,
    When their identities, packages, resources, or active references are inconsistent,
    Then equality detects the differences and validation rejects each corrupt state`, () => {
    const firstSkill = workflowSkill();
    const first = skillActivationFromWorkflowSkill({
      skill: firstSkill,
      trigger: "user_explicit",
      args: "PR 430",
      activatedAt: "1970-01-01T00:00:00.000Z",
    });
    const secondSkill = workflowSkill({
      id: "repo:other:review:digest-two",
      packageId: firstSkill.packageId,
      qualifiedName: "repo:other:review",
      digest: "digest-two",
    });
    const second = skillActivationFromWorkflowSkill({
      skill: secondSkill,
      trigger: "model_selected",
      args: "",
      activatedAt: "1970-01-01T00:00:00.001Z",
    });
    const valid = {
      skillActivations: [first],
      activeSkillIds: [first.descriptorId],
    };

    expect(skillLifecycleStatesEqual(valid, valid)).toBe(true);
    expect(
      skillLifecycleStatesEqual(valid, {
        skillActivations: [],
        activeSkillIds: [first.descriptorId],
      }),
    ).toBe(false);
    expect(
      skillLifecycleStatesEqual(valid, {
        skillActivations: [
          { ...first, resourcePaths: ["references/other.md"] },
        ],
        activeSkillIds: [first.descriptorId],
      }),
    ).toBe(false);
    expect(() =>
      createSkillActivation(inMemoryCatalog(), {
        initialState: { skillActivations: [], activeSkillIds: ["missing"] },
      }),
    ).toThrow("has no activation snapshot");
    expect(() =>
      createSkillActivation(inMemoryCatalog(), {
        initialState: {
          skillActivations: [first],
          activeSkillIds: [first.descriptorId, first.descriptorId],
        },
      }),
    ).toThrow("is duplicated");
    expect(() =>
      createSkillActivation(inMemoryCatalog(), {
        initialState: {
          skillActivations: [first, second],
          activeSkillIds: [first.descriptorId, second.descriptorId],
        },
      }),
    ).toThrow("has multiple active snapshots");
  });

  test(`Given active snapshots have ambiguous names, stale packages, and disk failures,
    When lifecycle controls resolve, inspect, reload, and read them,
    Then every reachable control path remains deterministic and fail-closed`, () => {
    const firstSkill = workflowSkill({
      qualifiedName: "repo:root-one:review",
      packageId: "repo:root-one:review",
    });
    const secondSkill = workflowSkill({
      id: "repo:root-two:review:digest-two",
      qualifiedName: "repo:root-two:review",
      packageId: "repo:root-two:review",
      digest: "digest-two",
    });
    const first = skillActivationFromWorkflowSkill({
      skill: firstSkill,
      trigger: "user_explicit",
      args: "",
      activatedAt: "1970-01-01T00:00:00.000Z",
    });
    const second = skillActivationFromWorkflowSkill({
      skill: secondSkill,
      trigger: "user_explicit",
      args: "",
      activatedAt: "1970-01-01T00:00:00.001Z",
    });
    const qaSkill = workflowSkill({
      id: "repo:root-three:qa:digest-three",
      qualifiedName: "repo:root-three:qa",
      packageId: "repo:root-three:qa",
      name: "qa",
      digest: "digest-three",
    });
    const qa = skillActivationFromWorkflowSkill({
      skill: qaSkill,
      trigger: "user_explicit",
      args: "",
      activatedAt: "1970-01-01T00:00:00.002Z",
    });
    const byPackage = new Map([
      [firstSkill.packageId, firstSkill],
      [secondSkill.packageId, secondSkill],
      [qaSkill.packageId, qaSkill],
    ]);
    const lifecycle = createSkillActivation(
      inMemoryCatalog({
        loadPackage: (packageId) => byPackage.get(packageId),
        readPackageResource: (_packageId, _digest, path) => `read:${path}`,
      }),
      {
        initialState: {
          skillActivations: [first, second, qa],
          activeSkillIds: [
            first.descriptorId,
            second.descriptorId,
            qa.descriptorId,
          ],
        },
      },
    );

    expect(() => lifecycle.deactivate("review")).toThrow("is ambiguous");
    expect(() => lifecycle.deactivate("repo:review")).toThrow("is ambiguous");
    expect(() => lifecycle.deactivate("bogus:review")).toThrow("is not active");
    expect(
      lifecycle.readResource(firstSkill.packageId, "references/guide.md"),
    ).toBe("read:references/guide.md");
    expect(lifecycle.reload(firstSkill.packageId).newlyActivated).toBe(false);
    expect(lifecycle.deactivate(firstSkill.packageId).descriptorId).toBe(
      first.descriptorId,
    );
    expect(lifecycle.deactivate("repo:review").descriptorId).toBe(
      second.descriptorId,
    );
    expect(() => lifecycle.deactivate("missing")).toThrow("is not active");

    byPackage.delete(qaSkill.packageId);
    expect(lifecycle.activeStatuses()[0]?.diskStatus).toBe("missing_on_disk");
    expect(() => lifecycle.reload(qaSkill.qualifiedName)).toThrow(
      "is missing on disk",
    );

    const missingFailure = createSkillActivation(
      inMemoryCatalog({
        loadPackage: () => {
          throw new WorkflowSkillError("workflow skill was not found.");
        },
      }),
      {
        initialState: {
          skillActivations: [qa],
          activeSkillIds: [qa.descriptorId],
        },
      },
    );
    expect(missingFailure.activeStatuses()[0]?.diskStatus).toBe(
      "missing_on_disk",
    );

    const validationFailure = createSkillActivation(
      inMemoryCatalog({
        loadPackage: () => {
          throw new WorkflowSkillError("invalid current Skill");
        },
      }),
      {
        initialState: {
          skillActivations: [second],
          activeSkillIds: [second.descriptorId],
        },
      },
    );
    expect(validationFailure.activeStatuses()[0]?.diskStatus).toBe(
      "changed_on_disk",
    );

    const unexpectedFailure = createSkillActivation(
      inMemoryCatalog({
        loadPackage: () => {
          throw new TypeError("unexpected");
        },
      }),
      {
        initialState: {
          skillActivations: [second],
          activeSkillIds: [second.descriptorId],
        },
      },
    );
    expect(() => unexpectedFailure.activeStatuses()).toThrow("unexpected");
  });

  test(`Given an active package is rediscovered with a different descriptor digest,
    When ordinary activation tries to replace it,
    Then Keel requires the explicit reload control`, () => {
    const previousSkill = workflowSkill();
    const previous = skillActivationFromWorkflowSkill({
      skill: previousSkill,
      trigger: "user_explicit",
      args: "",
      activatedAt: "1970-01-01T00:00:00.000Z",
    });
    const changed = workflowSkill({ digest: "digest-two" });
    const lifecycle = createSkillActivation(inMemoryCatalog(), {
      initialState: {
        skillActivations: [previous],
        activeSkillIds: [previous.descriptorId],
      },
    });

    expect(() => lifecycle.activateExplicit(changed, "")).toThrow(
      "already active with a different digest",
    );
  });
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
    When lookup requests an unknown name and activation repeats the same digest,
    Then lookup fails closed and the repeated activation is a no-op`, async () => {
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
      const duplicate = activation.activate("review");
      expect(duplicate.newlyActivated).toBe(false);
      expect(duplicate.record).toBeUndefined();
      expect(activation.state().skillActivations).toHaveLength(1);
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
      expect(activation.activate("repo:review").record?.name).toBe(
        "repo:review",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an implicit skill is already active through an explicit surface,
    When model-selected activation finds the same package through search,
    Then Keel keeps one snapshot without a duplicate activation event`, async () => {
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

      const duplicate = activation.activate("repo:review");
      expect(duplicate.newlyActivated).toBe(false);
      expect(duplicate.record).toBeUndefined();
      expect(activation.state().skillActivations).toHaveLength(1);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given four implicit Skills match one model turn,
    When the model activates three and attempts a fourth,
    Then the focused model-selected cap stops the fourth while explicit activation can override it`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-skill-model-cap-"));
    for (const name of ["alpha", "beta", "gamma", "delta"]) {
      const directory = join(workspace, ".agents", "skills", name);
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "SKILL.md"),
        `---\nname: ${name}\ndescription: Apply ${name} guidance.\n---\nFollow ${name}.\n`,
      );
    }

    try {
      const catalog = discoverSkillCatalog({ workspace });
      const activation = createSkillActivation(catalog);
      activation.beginTurn();
      activation.expose(catalog.implicitSkills);

      for (const name of ["alpha", "beta", "gamma"]) {
        expect(activation.activate(`repo:${name}`).newlyActivated).toBe(true);
      }
      expect(() => activation.activate("repo:delta")).toThrow(
        "already activated 3 model-selected workflow skills",
      );
      expect(
        activation.activateExplicit(catalog.load("repo:delta"), "")
          .newlyActivated,
      ).toBe(true);
      expect(activation.active()).toHaveLength(4);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an active Skill changes while the session remains open,
    When the user inspects and reloads it,
    Then changed_on_disk is visible and the new validated snapshot replaces the active digest`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-skill-live-reload-"));
    const directory = join(workspace, ".agents", "skills", "review");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "SKILL.md"),
      "---\nname: review\ndescription: Review changes.\n---\nVERSION ONE\n",
    );

    try {
      const catalog = discoverSkillCatalog({ workspace });
      const activation = createSkillActivation(catalog);
      activation.activateExplicit(catalog.load("review"), "PR 430");
      await writeFile(
        join(directory, "SKILL.md"),
        "---\nname: review\ndescription: Review changes.\n---\nVERSION TWO\n",
      );

      expect(activation.activeStatuses()[0]?.diskStatus).toBe(
        "changed_on_disk",
      );
      const reloaded = activation.reload("repo:review");
      expect(reloaded.skill.content).toContain("VERSION TWO");
      expect(reloaded.activation.args).toBe("PR 430");
      expect(activation.activeStatuses()[0]?.diskStatus).toBe("current");
      expect(activation.state().skillActivations).toHaveLength(2);
      const state = activation.state();
      expect(() =>
        activation.restore({
          skillActivations: state.skillActivations,
          activeSkillIds: state.skillActivations.map(
            (snapshot) => snapshot.descriptorId,
          ),
        }),
      ).toThrow("has multiple active snapshots");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an active Skill becomes invalid on disk,
    When explicit reload fails validation,
    Then the original active snapshot remains unchanged`, async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-skill-reload-atomic-"),
    );
    const directory = join(workspace, ".agents", "skills", "review");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "SKILL.md"),
      "---\nname: review\ndescription: Review changes.\n---\nVALID BODY\n",
    );

    try {
      const catalog = discoverSkillCatalog({ workspace });
      const activation = createSkillActivation(catalog);
      activation.activateExplicit(catalog.load("review"), "");
      const before = activation.state();
      await writeFile(join(directory, "SKILL.md"), "invalid document\n");

      expect(() => activation.reload("repo:review")).toThrow();
      expect(skillLifecycleStatesEqual(before, activation.state())).toBe(true);
      expect(activation.active()[0]?.contentSnapshot).toContain("VALID BODY");
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
      expect(
        catalog.audits.map((audit) => audit.qualifiedName).toSorted(),
      ).toEqual(identities.toSorted());
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
      const secret = `AKIA${"Z".repeat(16)}`;
      await writeFile(
        skillPath,
        `---\nname: review\ndescription: Review changes.\nsecret: [${secret}\n---\nreview\n`,
      );
      expect(() => catalog.load("repo:review")).toThrow(
        "SKILL.md contains invalid YAML frontmatter",
      );
      try {
        catalog.load("repo:review");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        if (error instanceof Error) {
          expect(error.message).not.toContain(secret);
        }
      }
      await rm(skillPath);
      expect(() => catalog.load("repo:review")).toThrow(
        "SKILL.md is missing from the package",
      );
      expect(() => catalog.load("repo:a:b:c")).toThrow(
        "qualified skill names use scope:name or scope:root-id:name",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given SKILL.md contains invalid UTF-8 beyond the bounded binary sample,
    When the project catalog decodes the complete package document,
    Then the package is blocked with the stable text-validation diagnostic`, async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-skill-late-invalid-utf8-"),
    );
    const skillDirectory = join(workspace, ".agents", "skills", "review");
    await mkdir(skillDirectory, { recursive: true });
    const bytes = Buffer.alloc(4_097, 0x61);
    Buffer.from(
      "---\nname: review\ndescription: Review changes.\n---\n",
    ).copy(bytes);
    bytes[4_096] = 0x80;
    await writeFile(join(skillDirectory, "SKILL.md"), bytes);

    try {
      const catalog = discoverSkillCatalog({ workspace });

      expect(catalog.skills).toEqual([]);
      expect(catalog.audits[0]?.findings).toContainEqual(
        expect.objectContaining({
          severity: "blocker",
          code: "invalid_package",
          message: "SKILL.md must be valid UTF-8 text without binary control bytes",
        }),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a safe cataloged Skill gains a secret before activation,
    When the user activates that existing descriptor,
    Then Keel re-audits and blocks it before returning changed content`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-skill-audit-change-"));
    const skillDirectory = join(workspace, ".agents", "skills", "review");
    await mkdir(skillDirectory, { recursive: true });
    const skillPath = join(skillDirectory, "SKILL.md");
    await writeFile(
      skillPath,
      "---\nname: review\ndescription: Review changes.\n---\nSafe body.\n",
    );

    try {
      const catalog = discoverSkillCatalog({ workspace });
      await writeFile(
        skillPath,
        `---\nname: review\ndescription: Review changes.\n---\nCredential: ghp_${"c".repeat(36)}\n`,
      );

      expect(() => catalog.load("repo:review")).toThrow("embedded_secret");
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
      ).toThrow('workflow skill "repo:review" is not active');
      expect(() => catalog.readResource("repo:review", "notes.md")).toThrow(
        "must stay under references/, scripts/, or assets/",
      );
      expect(() =>
        catalog.readResource("repo:review", "references/missing.txt"),
      ).toThrow("was not discovered");
      expect(catalog.loadPackage("repo:missing")).toBeUndefined();
      expect(() =>
        catalog.readPackageResource(
          "repo:missing",
          "digest",
          "references/marker.txt",
        ),
      ).toThrow("is no longer available");
      expect(catalog.readResource("repo:review", "references/marker.txt")).toBe(
        "RESOURCE-OK",
      );
      activation.registerExplicit([catalog.load("repo:review")]);
      expect(
        activation.readResource("repo:review", "references/marker.txt"),
      ).toBe("RESOURCE-OK");
      expect(() => activation.readResource("repo:review", "notes.md")).toThrow(
        "must stay under references/",
      );
      expect(() =>
        activation.readResource("repo:review", "references/missing.txt"),
      ).toThrow("was not discovered");
      await writeFile(
        skillPath,
        "---\nname: review\ndescription: Review changes.\n---\nchanged\n",
      );
      expect(() =>
        catalog.readResource("repo:review", "references/marker.txt"),
      ).toThrow("changed after catalog discovery");
      expect(() =>
        activation.readResource("repo:review", "references/marker.txt"),
      ).toThrow("changed on disk; reload it");
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
