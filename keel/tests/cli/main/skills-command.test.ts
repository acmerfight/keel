import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import { runCliMain } from "../../../src/cli/index.ts";
import { requestWithMessagesSchema } from "../../../src/testing/cli-main-schemas.ts";
import { createRuntime } from "../../../src/testing/cli-runtime-fixtures.ts";
import {
  close,
  getPort,
  listen,
  sseTextReplyWithUsage,
} from "../../../src/testing/provider-sse-fixtures.ts";

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

  test(`Given a selected workflow skill has local resource files,
    When the CLI starts a one-shot run,
    Then the provider-visible system prompt includes bounded resource paths without loading their contents`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-skill-resources-"),
    );
    const transcriptPath = join(workspace, "run.jsonl");
    await writeSkill(
      workspace,
      "review",
      "Review a PR using the project checklist.",
      "Read references/checklist.md before deciding what to test.",
    );
    await mkdir(join(workspace, ".agents", "skills", "review", "references"), {
      recursive: true,
    });
    await mkdir(
      join(workspace, ".agents", "skills", "review", "references", "deep"),
      {
        recursive: true,
      },
    );
    await mkdir(join(workspace, ".agents", "skills", "review", "scripts"), {
      recursive: true,
    });
    await mkdir(join(workspace, ".agents", "skills", "review", "assets"), {
      recursive: true,
    });
    await writeFile(
      join(
        workspace,
        ".agents",
        "skills",
        "review",
        "references",
        "checklist.md",
      ),
      "Hidden checklist body.",
    );
    await writeFile(
      join(
        workspace,
        ".agents",
        "skills",
        "review",
        "references",
        "deep",
        "guide.md",
      ),
      "Hidden nested guide body.",
    );
    await writeFile(
      join(
        workspace,
        ".agents",
        "skills",
        "review",
        "references",
        "bad\\name.md",
      ),
      "Hidden invalid resource path body.",
    );
    await writeFile(
      join(workspace, ".agents", "skills", "review", "scripts", "verify.ts"),
      "console.log('hidden script body');",
    );
    await writeFile(
      join(workspace, ".agents", "skills", "review", "assets", "template.txt"),
      "Hidden asset body.",
    );
    await writeFile(
      join(workspace, ".agents", "skills", "review", "notes.md"),
      "Do not list top-level scratch files.",
    );
    await writeFile(join(workspace, "outside.md"), "outside");
    await symlink(
      join(workspace, "outside.md"),
      join(
        workspace,
        ".agents",
        "skills",
        "review",
        "references",
        "outside.md",
      ),
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
      const [header] = (await readFile(transcriptPath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(header.systemPrompt).toContain(
        "Skill base directory: .agents/skills/review",
      );
      expect(header.systemPrompt).toContain(
        "Relative paths in this workflow skill resolve from that directory.",
      );
      expect(header.systemPrompt).toContain("- references/checklist.md");
      expect(header.systemPrompt).toContain("- references/deep/guide.md");
      expect(header.systemPrompt).toContain("- scripts/verify.ts");
      expect(header.systemPrompt).toContain("- assets/template.txt");
      expect(
        header.systemPrompt.indexOf("- references/checklist.md"),
      ).toBeLessThan(header.systemPrompt.indexOf("- scripts/verify.ts"));
      expect(header.systemPrompt.indexOf("- scripts/verify.ts")).toBeLessThan(
        header.systemPrompt.indexOf("- assets/template.txt"),
      );
      expect(header.systemPrompt).not.toContain("Hidden checklist body.");
      expect(header.systemPrompt).not.toContain("Hidden nested guide body.");
      expect(header.systemPrompt).not.toContain("bad\\name.md");
      expect(header.systemPrompt).not.toContain(
        "Hidden invalid resource path body.",
      );
      expect(header.systemPrompt).not.toContain("hidden script body");
      expect(header.systemPrompt).not.toContain("Hidden asset body.");
      expect(header.systemPrompt).not.toContain("notes.md");
      expect(header.systemPrompt).not.toContain("outside.md");
      expect(fixture.stderr()).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a selected workflow skill has more resource files than the prompt cap,
    When the CLI starts a one-shot run,
    Then the provider-visible system prompt advertises no more than the bounded resource path limit`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-skill-resource-cap-"),
    );
    const transcriptPath = join(workspace, "run.jsonl");
    await writeSkill(
      workspace,
      "review",
      "Review a PR using the project checklist.",
      "Use relevant files under references/.",
    );
    const referencesDir = join(
      workspace,
      ".agents",
      "skills",
      "review",
      "references",
    );
    await mkdir(referencesDir, { recursive: true });
    for (let index = 0; index < 55; index++) {
      await writeFile(
        join(referencesDir, `resource-${String(index).padStart(2, "0")}.md`),
        `Resource ${index}`,
      );
    }
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
      const [header] = (await readFile(transcriptPath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      const resourcePathLines = header.systemPrompt
        .split("\n")
        .filter((line: string) => line.startsWith("- references/resource-"));
      expect(resourcePathLines).toHaveLength(50);
      expect(new Set(resourcePathLines).size).toBe(50);
      expect(resourcePathLines).toEqual(resourcePathLines.toSorted());
      expect(header.systemPrompt).not.toContain("Resource 0");
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

  test(`Given a workflow skill is selected for an interactive run,
    When the user asks for the active skill,
    Then the CLI prints the selected skill without resolving a provider`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-skill-status-"));
    await writeSkill(
      workspace,
      "review",
      "Review a PR using the project checklist.",
      "Read PR comments first.",
    );
    const input = new PassThrough();
    input.end("/skill\n");
    const fixture = createRuntime(["--skill", "review"], {
      cwd: workspace,
      env: {
        KEEL_FORCE_INTERACTIVE: "1",
        KEEL_PROVIDER: "deepseek",
        DEEPSEEK_API_KEY: "",
      },
      input,
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toBe(
        "Workflow skill: review (.agents/skills/review/SKILL.md)\n",
      );
      expect(fixture.stderr()).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given no workflow skill is selected for an interactive run,
    When the user asks for the active skill,
    Then the CLI reports that no workflow skill is bound without resolving a provider`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-no-skill-status-"),
    );
    const input = new PassThrough();
    input.end("/skill\n");
    const fixture = createRuntime([], {
      cwd: workspace,
      env: {
        KEEL_FORCE_INTERACTIVE: "1",
        KEEL_PROVIDER: "deepseek",
        DEEPSEEK_API_KEY: "",
      },
      input,
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toBe("No workflow skill selected.\n");
      expect(fixture.stderr()).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the user passes arguments to the interactive skill status command,
    When the command is read,
    Then the CLI rejects the arguments without resolving a provider`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-skill-status-args-"),
    );
    const input = new PassThrough();
    input.end("/skill review\n");
    const fixture = createRuntime([], {
      cwd: workspace,
      env: {
        KEEL_FORCE_INTERACTIVE: "1",
        KEEL_PROVIDER: "deepseek",
        DEEPSEEK_API_KEY: "",
      },
      input,
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toBe("");
      expect(fixture.stderr()).toBe(
        "Error: /skill does not accept arguments.\n",
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

  test(`Given a missing local workflow skill is selected,
    When the CLI starts an interactive run,
    Then it reports the missing skill before contacting a provider`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-skill-interactive-missing-"),
    );
    const fixture = createRuntime(["--skill", "missing"], {
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

  test(`Given a workflow skill is selected for an interactive run,
    When the user sends an interactive prompt,
    Then the provider-visible system prompt includes that skill body`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-skill-interactive-"),
    );
    await writeSkill(
      workspace,
      "review",
      "Review a PR using the project checklist.",
      "Read PR comments first.\nRun coverage before declaring ready.",
    );
    const capturedBodies: unknown[] = [];
    const server = createServer((req, res) => {
      if (req.url !== "/chat/completions") {
        res.writeHead(404);
        res.end();
        return;
      }

      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        capturedBodies.push(JSON.parse(body));
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.end(sseTextReplyWithUsage("Done."));
      });
    });
    await listen(server);
    const input = new PassThrough();
    input.end("review PR 123\n");
    const fixture = createRuntime(["--skill", "review"], {
      cwd: workspace,
      env: {
        KEEL_FORCE_INTERACTIVE: "1",
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
      },
      input,
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toBe("Done.\n");
      expect(fixture.stderr()).toBe("");
      const request = requestWithMessagesSchema.parse(capturedBodies[0]);
      const system = request.messages?.find(
        (message) => message.role === "system",
      );
      if (system === undefined) {
        throw new Error("provider request had no system message");
      }
      expect(system.content).toContain(
        "Workflow skill review from .agents/skills/review/SKILL.md",
      );
      expect(system.content).toContain("> Read PR comments first.");
      expect(system.content).toContain(
        "> Run coverage before declaring ready.",
      );
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a named interactive session starts with a workflow skill,
    When the session is resumed after the skill file changes,
    Then the resumed provider-visible system prompt reuses the persisted skill body`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-skill-resume-workspace-"),
    );
    const home = await mkdtemp(join(tmpdir(), "keel-cli-skill-resume-home-"));
    await writeSkill(
      workspace,
      "review",
      "Review a PR using the project checklist.",
      "Original review workflow body.",
    );
    const capturedBodies: unknown[] = [];
    const server = createServer((req, res) => {
      if (req.url !== "/chat/completions") {
        res.writeHead(404);
        res.end();
        return;
      }

      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        capturedBodies.push(JSON.parse(body));
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.end(sseTextReplyWithUsage("Done."));
      });
    });
    await listen(server);
    const firstInput = new PassThrough();
    firstInput.end("review PR 123\n");
    const firstRun = createRuntime(["--session", "demo", "--skill", "review"], {
      cwd: workspace,
      env: {
        KEEL_FORCE_INTERACTIVE: "1",
        KEEL_HOME: home,
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
      },
      input: firstInput,
    });

    try {
      const firstExitCode = await runCliMain(firstRun.runtime);
      await writeSkill(
        workspace,
        "review",
        "Review a PR using the project checklist.",
        "Changed review workflow body.",
      );
      const secondInput = new PassThrough();
      secondInput.end("continue\n");
      const secondRun = createRuntime(["--resume", "demo"], {
        cwd: workspace,
        env: {
          KEEL_FORCE_INTERACTIVE: "1",
          KEEL_HOME: home,
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        },
        input: secondInput,
      });

      // When
      const secondExitCode = await runCliMain(secondRun.runtime);

      // Then
      expect(firstExitCode).toBe(0);
      expect(secondExitCode).toBe(0);
      expect(firstRun.stderr()).toBe("");
      expect(secondRun.stderr()).toBe("");
      const resumedRequest = requestWithMessagesSchema.parse(capturedBodies[1]);
      const system = resumedRequest.messages?.find(
        (message) => message.role === "system",
      );
      if (system === undefined) {
        throw new Error("provider request had no system message");
      }
      expect(system.content).toContain("> Original review workflow body.");
      expect(system.content).not.toContain("Changed review workflow body.");
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a named interactive session already has a workflow skill,
    When the user resumes it with a different workflow skill,
    Then the CLI rejects the conflicting skill before contacting a provider`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-skill-conflict-workspace-"),
    );
    const home = await mkdtemp(join(tmpdir(), "keel-cli-skill-conflict-home-"));
    await writeSkill(
      workspace,
      "review",
      "Review a PR using the project checklist.",
      "Review workflow body.",
    );
    await writeSkill(
      workspace,
      "merge-pr",
      "Merge a reviewed PR.",
      "Merge workflow body.",
    );
    const firstInput = new PassThrough();
    firstInput.end("review PR 123\n");
    const firstRun = createRuntime(["--session", "demo", "--skill", "review"], {
      cwd: workspace,
      env: {
        KEEL_PROVIDER: "fake",
        KEEL_FORCE_INTERACTIVE: "1",
        KEEL_HOME: home,
      },
      input: firstInput,
    });

    try {
      const firstExitCode = await runCliMain(firstRun.runtime);
      const secondInput = new PassThrough();
      secondInput.end("continue\n");
      const secondRun = createRuntime(
        ["--resume", "demo", "--skill", "merge-pr"],
        {
          cwd: workspace,
          env: {
            KEEL_PROVIDER: "fake",
            KEEL_FORCE_INTERACTIVE: "1",
            KEEL_HOME: home,
          },
          input: secondInput,
        },
      );

      // When
      const secondExitCode = await runCliMain(secondRun.runtime);

      // Then
      expect(firstExitCode).toBe(0);
      expect(secondExitCode).toBe(1);
      expect(secondRun.stdout()).toBe("");
      expect(secondRun.stderr()).toBe(
        'Error: session "demo" already uses workflow skill "review"; cannot resume it with workflow skill "merge-pr".\n',
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a named interactive session already has a workflow skill,
    When the user lists fork points with a different workflow skill,
    Then the CLI rejects the conflicting skill before formatting fork points`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-skill-fork-points-conflict-workspace-"),
    );
    const home = await mkdtemp(
      join(tmpdir(), "keel-cli-skill-fork-points-conflict-home-"),
    );
    await writeSkill(
      workspace,
      "review",
      "Review a PR using the project checklist.",
      "Review workflow body.",
    );
    const firstInput = new PassThrough();
    firstInput.end("review PR 123\n");
    const firstRun = createRuntime(["--session", "demo", "--skill", "review"], {
      cwd: workspace,
      env: {
        KEEL_PROVIDER: "fake",
        KEEL_FORCE_INTERACTIVE: "1",
        KEEL_HOME: home,
      },
      input: firstInput,
    });

    try {
      const firstExitCode = await runCliMain(firstRun.runtime);
      const secondRun = createRuntime(
        ["--resume", "demo", "--fork-points", "--skill", "merge-pr"],
        {
          cwd: workspace,
          env: {
            KEEL_PROVIDER: "fake",
            KEEL_HOME: home,
          },
        },
      );

      // When
      const secondExitCode = await runCliMain(secondRun.runtime);

      // Then
      expect(firstExitCode).toBe(0);
      expect(secondExitCode).toBe(1);
      expect(secondRun.stdout()).toBe("");
      expect(secondRun.stderr()).toBe(
        'Error: session "demo" already uses workflow skill "review"; cannot resume it with workflow skill "merge-pr".\n',
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a named interactive session was created without a workflow skill,
    When the user resumes it with a workflow skill,
    Then the CLI rejects adding new workflow guidance to the restored session`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-skill-missing-session-workspace-"),
    );
    const home = await mkdtemp(
      join(tmpdir(), "keel-cli-skill-missing-session-home-"),
    );
    await writeSkill(
      workspace,
      "review",
      "Review a PR using the project checklist.",
      "Review workflow body.",
    );
    const firstInput = new PassThrough();
    firstInput.end("remember alpha\n");
    const firstRun = createRuntime(["--session", "demo"], {
      cwd: workspace,
      env: {
        KEEL_PROVIDER: "fake",
        KEEL_FORCE_INTERACTIVE: "1",
        KEEL_HOME: home,
      },
      input: firstInput,
    });

    try {
      const firstExitCode = await runCliMain(firstRun.runtime);
      const secondInput = new PassThrough();
      secondInput.end("continue\n");
      const secondRun = createRuntime(
        ["--resume", "demo", "--skill", "review"],
        {
          cwd: workspace,
          env: {
            KEEL_PROVIDER: "fake",
            KEEL_FORCE_INTERACTIVE: "1",
            KEEL_HOME: home,
          },
          input: secondInput,
        },
      );

      // When
      const secondExitCode = await runCliMain(secondRun.runtime);

      // Then
      expect(firstExitCode).toBe(0);
      expect(secondExitCode).toBe(1);
      expect(secondRun.stdout()).toBe("");
      expect(secondRun.stderr()).toBe(
        'Error: session "demo" has no workflow skill; cannot resume it with workflow skill "review".\n',
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a named interactive session already has a workflow skill,
    When the user resumes it with the same workflow skill name,
    Then the CLI continues the session without reloading a new workflow skill`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-skill-same-workspace-"),
    );
    const home = await mkdtemp(join(tmpdir(), "keel-cli-skill-same-home-"));
    await writeSkill(
      workspace,
      "review",
      "Review a PR using the project checklist.",
      "Review workflow body.",
    );
    const firstInput = new PassThrough();
    firstInput.end("remember alpha\n");
    const firstRun = createRuntime(["--session", "demo", "--skill", "review"], {
      cwd: workspace,
      env: {
        KEEL_PROVIDER: "fake",
        KEEL_FORCE_INTERACTIVE: "1",
        KEEL_HOME: home,
      },
      input: firstInput,
    });

    try {
      const firstExitCode = await runCliMain(firstRun.runtime);
      const secondInput = new PassThrough();
      secondInput.end("what did I ask you to remember?\n");
      const secondRun = createRuntime(
        ["--resume", "demo", "--skill", "review"],
        {
          cwd: workspace,
          env: {
            KEEL_PROVIDER: "fake",
            KEEL_FORCE_INTERACTIVE: "1",
            KEEL_HOME: home,
          },
          input: secondInput,
        },
      );

      // When
      const secondExitCode = await runCliMain(secondRun.runtime);

      // Then
      expect(firstExitCode).toBe(0);
      expect(secondExitCode).toBe(0);
      expect(secondRun.stdout()).toBe("Earlier you said: remember alpha\n");
      expect(secondRun.stderr()).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
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
