import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runCliMain } from "../../../src/cli/index.ts";
import { createRuntime } from "../../../src/testing/cli-runtime-fixtures.ts";

interface WriteSkillOptions {
  readonly descriptionQuote?: "none" | "single" | "double";
  readonly extraFrontmatterLines?: readonly string[];
  readonly frontmatterName?: string;
}

function formatDescription(
  description: string,
  quote: WriteSkillOptions["descriptionQuote"] = "none",
): string {
  if (quote === "single") return `'${description}'`;
  if (quote === "double") return `"${description}"`;
  return description;
}

async function writeSkill(
  workspace: string,
  name: string,
  description: string,
  body: string,
  options: WriteSkillOptions = {},
): Promise<void> {
  const skillDir = join(workspace, ".agents", "skills", name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    [
      "---",
      `name: ${options.frontmatterName ?? name}`,
      ...(options.extraFrontmatterLines ?? []),
      `description: ${formatDescription(description, options.descriptionQuote)}`,
      "---",
      "",
      body,
      "",
    ].join("\n"),
  );
}

async function writeRawSkill(
  workspace: string,
  name: string,
  content: string | Uint8Array,
): Promise<void> {
  const skillDir = join(workspace, ".agents", "skills", name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), content);
}

describe("CLI Main - Skills", () => {
  test(`Given no local workflow skills exist,
    When the user lists skills,
    Then the CLI prints an empty local skills message`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-skills-empty-"));
    const fixture = createRuntime(["skills"], { cwd: workspace });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toBe(
        "No local workflow skills found in .agents/skills.\n",
      );
      expect(fixture.stderr()).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an unsupported skills command argument,
    When the user lists skills,
    Then the CLI reports a validation error before reading local skills`, async () => {
    // Given
    const fixture = createRuntime(["skills", "--json"]);

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe('Error: unknown skills option "--json"\n');
  });

  test(`Given local workflow skills exist,
    When the user lists skills,
    Then the CLI prints their names and descriptions without starting a provider`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-skills-list-"));
    await writeSkill(
      workspace,
      "slice",
      "Execute the standard Keel PR-slice workflow.",
      "Implement one bounded slice.",
      {
        descriptionQuote: "single",
        extraFrontmatterLines: ["ignored frontmatter prose"],
      },
    );
    await writeSkill(
      workspace,
      "merge-pr",
      "Merge a reviewed PR.",
      "Clean up after merge.",
      { descriptionQuote: "double" },
    );
    await mkdir(join(workspace, ".agents", "skills", "scratch"), {
      recursive: true,
    });
    const fixture = createRuntime(["skills"], { cwd: workspace });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toContain("slice");
      expect(fixture.stdout()).toContain(
        "Execute the standard Keel PR-slice workflow.",
      );
      expect(fixture.stdout()).toContain("merge-pr");
      expect(fixture.stdout()).toContain("Merge a reviewed PR.");
      expect(fixture.stdout()).not.toContain("scratch");
      expect(fixture.stderr()).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given valid and malformed local workflow skills exist,
    When the user lists skills,
    Then the CLI lists the valid skills and warns about skipped malformed ones`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-skills-mixed-"));
    await writeSkill(
      workspace,
      "review",
      "Review a PR using the project checklist.",
      "Read PR comments first.",
    );
    await writeRawSkill(workspace, "broken", "---\nname: broken\n---\nbody\n");
    const fixture = createRuntime(["skills"], { cwd: workspace });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toContain("review");
      expect(fixture.stdout()).toContain(
        "Review a PR using the project checklist.",
      );
      expect(fixture.stdout()).not.toContain("broken");
      expect(fixture.stderr()).toContain(
        'Warning: skipped workflow skill "broken":',
      );
      expect(fixture.stderr()).toContain(
        "must declare non-empty name and description frontmatter",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given workflow skills live at a parent git workspace,
    When the user lists skills from a nested package directory,
    Then the CLI still prints the parent workflow skills`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-skills-parent-"));
    const nestedPackage = join(workspace, "keel");
    await mkdir(join(workspace, ".git"), { recursive: true });
    await mkdir(join(nestedPackage, ".git"), { recursive: true });
    await writeSkill(
      workspace,
      "agent-research",
      "Research a Keel design question.",
      "Gather evidence before recommending a slice.",
    );
    const fixture = createRuntime(["skills"], { cwd: nestedPackage });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toContain("agent-research");
      expect(fixture.stdout()).toContain("Research a Keel design question.");
      expect(fixture.stderr()).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a local workflow skill is selected for a one-shot run,
    When the CLI starts the agent,
    Then the provider-visible system prompt includes that skill body`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-skill-run-"));
    const transcriptPath = join(workspace, "run.jsonl");
    await writeSkill(
      workspace,
      "review",
      "Review a PR using the project checklist.",
      "Read PR comments first.\nRun coverage before declaring ready.",
    );
    const fixture = createRuntime(
      ["--transcript", transcriptPath, "--skill", "review", "review PR 123"],
      {
        cwd: workspace,
        env: { KEEL_PROVIDER: "fake" },
      },
    );

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toBe("Hello from fake provider.\n");
      expect(fixture.stderr()).toBe("");
      const [header] = (await readFile(transcriptPath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(header).toMatchObject({
        type: "transcript",
        systemPrompt: expect.stringContaining(
          "Workflow skill review from .agents/skills/review/SKILL.md",
        ),
      });
      expect(header.systemPrompt).toContain("> Read PR comments first.");
      expect(header.systemPrompt).toContain(
        "> Run coverage before declaring ready.",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a local workflow skill is selected with equals syntax,
    When the CLI starts the agent,
    Then the provider-visible system prompt includes that skill body`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-skill-equals-"));
    const transcriptPath = join(workspace, "run.jsonl");
    await writeSkill(
      workspace,
      "review",
      "Review a PR using the project checklist.",
      "Read PR comments first.",
    );
    const fixture = createRuntime(
      [`--transcript=${transcriptPath}`, "--skill=review", "review PR 123"],
      {
        cwd: workspace,
        env: { KEEL_PROVIDER: "fake" },
      },
    );

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      const [header] = (await readFile(transcriptPath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(header.systemPrompt).toContain(
        "Workflow skill review from .agents/skills/review/SKILL.md",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test.each([
    { label: "--skill", args: ["--skill"] },
    { label: "--skill=", args: ["--skill=", "hello"] },
  ])(`Given a skill option $label without a name,
    When the CLI parses the request,
    Then it returns a validation error before resolving a provider`, async ({
    args,
  }) => {
    // Given
    const fixture = createRuntime(args, {
      env: { KEEL_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "" },
    });

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    expect(fixture.stderr()).toBe("Error: --skill requires a value.\n");
  });

  test(`Given a missing local workflow skill is selected,
    When the CLI starts a one-shot run,
    Then it reports the missing skill before contacting a provider`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-skill-missing-"));
    const fixture = createRuntime(["--skill", "missing", "hello"], {
      cwd: workspace,
      env: { KEEL_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "" },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(fixture.stdout()).toBe("");
      expect(fixture.stderr()).toBe(
        'Error: workflow skill "missing" was not found in .agents/skills.\n',
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the local workflow skill root exists without the selected skill,
    When the CLI starts a one-shot run,
    Then it reports the missing skill before contacting a provider`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-skill-missing-root-"),
    );
    await mkdir(join(workspace, ".agents", "skills"), { recursive: true });
    const fixture = createRuntime(["--skill", "missing", "hello"], {
      cwd: workspace,
      env: { KEEL_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "" },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(fixture.stdout()).toBe("");
      expect(fixture.stderr()).toBe(
        'Error: workflow skill "missing" was not found in .agents/skills.\n',
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a workflow skill name attempts path traversal,
    When the CLI starts a one-shot run,
    Then it rejects the name before resolving any skill path`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-skill-invalid-"));
    const fixture = createRuntime(["--skill", "../secret", "hello"], {
      cwd: workspace,
      env: { KEEL_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "" },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(fixture.stdout()).toBe("");
      expect(fixture.stderr()).toContain("workflow skill names may contain");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a workflow skill flag has no one-shot prompt,
    When the CLI starts,
    Then it rejects the skill before starting interactive mode`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-skill-no-prompt-"),
    );
    const fixture = createRuntime(["--skill", "review"], {
      cwd: workspace,
      env: { KEEL_FORCE_INTERACTIVE: "1" },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(fixture.stdout()).toBe("");
      expect(fixture.stderr()).toBe(
        "Error: --skill is only supported for one-shot runs.\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a workflow skill symlink resolves outside the local skill root,
    When the CLI starts a one-shot run,
    Then it rejects the escaped SKILL.md path before contacting a provider`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-skill-escape-"));
    const outside = await mkdtemp(join(tmpdir(), "keel-cli-skill-outside-"));
    await mkdir(join(workspace, ".agents", "skills"), { recursive: true });
    await writeFile(
      join(outside, "SKILL.md"),
      "---\nname: escape\ndescription: Escaped skill.\n---\noutside\n",
    );
    await symlink(
      outside,
      join(workspace, ".agents", "skills", "escape"),
      "dir",
    );
    const fixture = createRuntime(["--skill", "escape", "hello"], {
      cwd: workspace,
      env: { KEEL_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "" },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(fixture.stdout()).toBe("");
      expect(fixture.stderr()).toBe(
        "Error: cannot load workflow skill: resolved SKILL.md path escapes .agents/skills.\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test(`Given the local workflow skills root is a symlink,
    When the user lists skills,
    Then the CLI rejects the non-local root`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-skills-root-link-"),
    );
    const outside = await mkdtemp(join(tmpdir(), "keel-cli-skills-outside-"));
    await mkdir(join(workspace, ".agents"), { recursive: true });
    await writeSkill(
      outside,
      "outside",
      "Outside skill.",
      "This skill is outside the workspace root.",
    );
    await symlink(
      join(outside, ".agents", "skills"),
      join(workspace, ".agents", "skills"),
      "dir",
    );
    const fixture = createRuntime(["skills"], { cwd: workspace });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(fixture.stdout()).toBe("");
      expect(fixture.stderr()).toBe(
        "Error: .agents/skills must be a local directory to load workflow skills.\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test(`Given the local workflow skills root is a symlink,
    When the CLI starts a one-shot run with a skill from that root,
    Then it rejects the root before contacting a provider`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-skill-root-link-"),
    );
    const outside = await mkdtemp(join(tmpdir(), "keel-cli-skill-outside-"));
    await mkdir(join(workspace, ".agents"), { recursive: true });
    await writeSkill(
      outside,
      "outside",
      "Outside skill.",
      "This skill is outside the workspace root.",
    );
    await symlink(
      join(outside, ".agents", "skills"),
      join(workspace, ".agents", "skills"),
      "dir",
    );
    const fixture = createRuntime(["--skill", "outside", "hello"], {
      cwd: workspace,
      env: { KEEL_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "" },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(fixture.stdout()).toBe("");
      expect(fixture.stderr()).toBe(
        "Error: .agents/skills must be a local directory to load workflow skills.\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test(`Given the local .agents directory is a symlink,
    When the CLI starts a one-shot run with a skill from that root,
    Then it rejects the indirect non-local root before contacting a provider`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-agents-link-"));
    const outside = await mkdtemp(join(tmpdir(), "keel-cli-agents-outside-"));
    await writeSkill(
      outside,
      "outside",
      "Outside skill.",
      "This skill is outside the workspace root.",
    );
    await symlink(join(outside, ".agents"), join(workspace, ".agents"), "dir");
    const fixture = createRuntime(["--skill", "outside", "hello"], {
      cwd: workspace,
      env: { KEEL_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "" },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(fixture.stdout()).toBe("");
      expect(fixture.stderr()).toBe(
        "Error: .agents/skills must be a local directory to load workflow skills.\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test(`Given a workflow skill file is too large,
    When the CLI starts a one-shot run,
    Then it rejects the skill before provider-visible prompt construction`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-skill-huge-"));
    await writeRawSkill(
      workspace,
      "huge",
      `---\nname: huge\ndescription: Huge skill.\n---\n${"x".repeat(50 * 1024)}`,
    );
    const fixture = createRuntime(["--skill", "huge", "hello"], {
      cwd: workspace,
      env: { KEEL_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "" },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(fixture.stdout()).toBe("");
      expect(fixture.stderr()).toContain(
        "Error: workflow skill SKILL.md is too large to load",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test.each([
    { name: "binary", content: Buffer.from([0]), label: "binary bytes" },
    {
      name: "bad-utf8",
      content: Buffer.from([0xc3, 0x28]),
      label: "invalid UTF-8",
    },
  ])(`Given a workflow skill contains $label,
    When the CLI starts a one-shot run,
    Then it rejects the non-text skill file`, async ({ name, content }) => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-skill-text-"));
    await writeRawSkill(workspace, name, content);
    const fixture = createRuntime(["--skill", name, "hello"], {
      cwd: workspace,
      env: { KEEL_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "" },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(fixture.stdout()).toBe("");
      expect(fixture.stderr()).toBe(
        "Error: workflow skill SKILL.md is binary or not valid UTF-8 text.\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test.each([
    {
      name: "plain",
      content: "name: plain\ndescription: Plain skill.\n",
      expected: "must start with YAML frontmatter",
    },
    {
      name: "unterminated",
      content: "---\nname: unterminated\ndescription: Unterminated skill.\n",
      expected: "has unterminated YAML frontmatter",
    },
    {
      name: "missing-description",
      content: "---\nname: missing-description\n---\nbody\n",
      expected: "must declare non-empty name and description frontmatter",
    },
  ])(`Given a workflow skill has invalid frontmatter for $name,
    When the CLI starts a one-shot run,
    Then it reports the frontmatter problem`, async ({
    name,
    content,
    expected,
  }) => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-skill-frontmatter-"),
    );
    await writeRawSkill(workspace, name, content);
    const fixture = createRuntime(["--skill", name, "hello"], {
      cwd: workspace,
      env: { KEEL_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "" },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(fixture.stdout()).toBe("");
      expect(fixture.stderr()).toContain(expected);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a workflow skill frontmatter name does not match its directory,
    When the CLI starts a one-shot run,
    Then it reports the mismatch before contacting a provider`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-skill-mismatch-"));
    await writeSkill(workspace, "review", "Review a PR.", "Read the PR.", {
      frontmatterName: "other",
    });
    const fixture = createRuntime(["--skill", "review", "hello"], {
      cwd: workspace,
      env: { KEEL_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "" },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(fixture.stdout()).toBe("");
      expect(fixture.stderr()).toBe(
        'Error: workflow skill "review" has mismatched frontmatter name "other".\n',
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a workflow skill path is not a regular SKILL.md file,
    When the CLI starts a one-shot run,
    Then it rejects the skill file shape`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-skill-not-file-"));
    await mkdir(join(workspace, ".agents", "skills", "folder", "SKILL.md"), {
      recursive: true,
    });
    const fixture = createRuntime(["--skill", "folder", "hello"], {
      cwd: workspace,
      env: { KEEL_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "" },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(fixture.stdout()).toBe("");
      expect(fixture.stderr()).toBe(
        'Error: workflow skill "folder" must be a regular SKILL.md file.\n',
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
