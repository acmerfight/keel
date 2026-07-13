import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { runCliMain } from "../../../src/cli/index.ts";
import {
  requestWithMessagesSchema,
  requestWithToolsSchema,
} from "../../../src/testing/cli-main-schemas.ts";
import { createRuntime } from "../../../src/testing/cli-runtime-fixtures.ts";
import {
  close,
  getPort,
  listen,
  sseTextReplyWithUsage,
  sseToolCall,
  sseToolFinish,
} from "../../../src/testing/provider-sse-fixtures.ts";

async function writeSkill(
  workspace: string,
  name: string,
  description: string,
  body: string,
): Promise<void> {
  const directory = join(workspace, ".agents", "skills", name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    [
      "---",
      `name: ${name}`,
      `description: ${description}`,
      "---",
      "",
      body,
      "",
    ].join("\n"),
  );
}

function occurrences(text: string, value: string): number {
  return text.split(value).length - 1;
}

const requestControlSchema = z
  .object({
    tool_choice: z.unknown().optional(),
    tools: z.unknown().optional(),
  })
  .passthrough();

function isSummaryRequest(body: unknown): boolean {
  const request = requestControlSchema.parse(body);
  return request.tool_choice === "none" || request.tools === undefined;
}

describe("CLI Main - Skill Lifecycle", () => {
  test(`Given a named session has an active Skill,
    When one resume uses --no-skills and a later resume does not,
    Then the middle run exposes no Skill surface without erasing the persisted activation`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-skill-temporary-disable-workspace-"),
    );
    const home = await mkdtemp(
      join(tmpdir(), "keel-skill-temporary-disable-home-"),
    );
    await writeSkill(
      workspace,
      "review",
      "Review a pull request.",
      "TEMPORARY_DISABLE_REVIEW_SNAPSHOT",
    );
    const capturedBodies: unknown[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        capturedBodies.push(JSON.parse(body));
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(sseTextReplyWithUsage("Done."));
      });
    });
    await listen(server);
    const runtimeOptions = {
      cwd: workspace,
      env: {
        KEEL_FORCE_INTERACTIVE: "1",
        KEEL_HOME: home,
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
      },
    } as const;
    const firstInput = new PassThrough();
    firstInput.end("start review\n");
    const firstRun = createRuntime(
      ["--session", "temporary-disable", "--skill", "review"],
      { ...runtimeOptions, input: firstInput },
    );
    const disabledInput = new PassThrough();
    disabledInput.end(
      "/skills active\n/skill review\n$review forbidden\ncontinue without skills\n",
    );
    const disabledRun = createRuntime(
      ["--resume", "temporary-disable", "--no-skills"],
      { ...runtimeOptions, input: disabledInput },
    );
    const restoredInput = new PassThrough();
    restoredInput.end("continue normally\n");
    const restoredRun = createRuntime(["--resume", "temporary-disable"], {
      ...runtimeOptions,
      input: restoredInput,
    });
    const disabledForkInput = new PassThrough();
    disabledForkInput.end("continue in a disabled fork\n");
    const disabledForkRun = createRuntime(
      [
        "--resume",
        "temporary-disable",
        "--fork",
        "temporary-disable-fork",
        "--no-skills",
      ],
      { ...runtimeOptions, input: disabledForkInput },
    );
    const restoredForkInput = new PassThrough();
    restoredForkInput.end("continue in the restored fork\n");
    const restoredForkRun = createRuntime(
      ["--resume", "temporary-disable-fork"],
      { ...runtimeOptions, input: restoredForkInput },
    );

    try {
      expect(await runCliMain(firstRun.runtime)).toBe(0);

      // When
      const disabledExitCode = await runCliMain(disabledRun.runtime);
      const restoredExitCode = await runCliMain(restoredRun.runtime);
      const disabledForkExitCode = await runCliMain(disabledForkRun.runtime);
      const restoredForkExitCode = await runCliMain(restoredForkRun.runtime);

      // Then
      expect(disabledExitCode).toBe(0);
      expect(restoredExitCode).toBe(0);
      expect(disabledForkExitCode).toBe(0);
      expect(restoredForkExitCode).toBe(0);
      expect(capturedBodies).toHaveLength(5);
      expect(disabledRun.stdout()).toContain("No active workflow skills.");
      expect(
        occurrences(
          disabledRun.stderr(),
          "Error: workflow skills are disabled for this run by --no-skills.",
        ),
      ).toBe(2);
      expect(disabledRun.stderr()).not.toContain(
        "explicit skill activation is unavailable",
      );
      const disabledRequest = requestWithMessagesSchema.parse(
        capturedBodies[1],
      );
      const disabledSystem = disabledRequest.messages?.find(
        (message) => message.role === "system",
      )?.content;
      expect(disabledSystem).not.toContain("Available workflow skills:");
      expect(disabledSystem).not.toContain("repo:review");
      expect(disabledSystem).not.toContain("TEMPORARY_DISABLE_REVIEW_SNAPSHOT");
      const disabledTools =
        requestWithToolsSchema
          .parse(capturedBodies[1])
          .tools?.map((tool) => tool.function?.name) ?? [];
      expect(disabledTools).not.toContain("skill");
      expect(disabledTools).not.toContain("skill_search");
      expect(disabledTools).not.toContain("skill_resource");
      const restoredRequest = requestWithMessagesSchema.parse(
        capturedBodies[2],
      );
      const restoredSystem = restoredRequest.messages?.find(
        (message) => message.role === "system",
      )?.content;
      expect(restoredSystem).toContain("TEMPORARY_DISABLE_REVIEW_SNAPSHOT");
      const disabledForkRequest = requestWithMessagesSchema.parse(
        capturedBodies[3],
      );
      const disabledForkSystem = disabledForkRequest.messages?.find(
        (message) => message.role === "system",
      )?.content;
      expect(disabledForkSystem).not.toContain("Available workflow skills:");
      expect(disabledForkSystem).not.toContain("repo:review");
      expect(disabledForkSystem).not.toContain(
        "TEMPORARY_DISABLE_REVIEW_SNAPSHOT",
      );
      const disabledForkTools =
        requestWithToolsSchema
          .parse(capturedBodies[3])
          .tools?.map((tool) => tool.function?.name) ?? [];
      expect(disabledForkTools).not.toContain("skill");
      expect(disabledForkTools).not.toContain("skill_search");
      expect(disabledForkTools).not.toContain("skill_resource");
      const restoredForkRequest = requestWithMessagesSchema.parse(
        capturedBodies[4],
      );
      const restoredForkSystem = restoredForkRequest.messages?.find(
        (message) => message.role === "system",
      )?.content;
      expect(restoredForkSystem).toContain("TEMPORARY_DISABLE_REVIEW_SNAPSHOT");
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given an ephemeral interactive run has a local Skill,
    When the user activates and lists it without naming a saved session,
    Then lifecycle controls work without creating persistence`, async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-skill-ephemeral-workspace-"),
    );
    await writeSkill(
      workspace,
      "review",
      "Review a pull request.",
      "EPHEMERAL REVIEW SNAPSHOT",
    );
    const input = new PassThrough();
    input.end("/skill review\n/skills active\n");
    const fixture = createRuntime([], {
      cwd: workspace,
      env: { KEEL_FORCE_INTERACTIVE: "1", KEEL_PROVIDER: "fake" },
      input,
    });

    try {
      expect(await runCliMain(fixture.runtime)).toBe(0);
      expect(fixture.stdout()).toContain(
        "Activated workflow skill repo:review.",
      );
      expect(fixture.stdout()).toContain("Active workflow skills:");
      expect(fixture.stdout()).toContain("repo:review");
      expect(fixture.stderr()).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a named session activates multiple Skills and one file later changes,
    When the user resumes and lists active Skills,
    Then every original snapshot remains active once and the disk change is visible`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-skill-lifecycle-workspace-"),
    );
    const home = await mkdtemp(join(tmpdir(), "keel-skill-lifecycle-home-"));
    const resumeReportPath = join(workspace, "resume-report.json");
    await writeSkill(
      workspace,
      "review",
      "Review a pull request.",
      "ORIGINAL REVIEW SNAPSHOT",
    );
    await writeSkill(
      workspace,
      "qa",
      "Run comprehensive quality assurance.",
      "ORIGINAL QA SNAPSHOT",
    );
    const capturedBodies: unknown[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        capturedBodies.push(JSON.parse(body));
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(sseTextReplyWithUsage("Done."));
      });
    });
    await listen(server);
    const firstInput = new PassThrough();
    firstInput.end("start review\n");
    const firstRun = createRuntime(
      ["--session", "durable", "--skill", "review", "--skill", "qa"],
      {
        cwd: workspace,
        env: {
          KEEL_FORCE_INTERACTIVE: "1",
          KEEL_HOME: home,
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        },
        input: firstInput,
      },
    );

    try {
      const firstExitCode = await runCliMain(firstRun.runtime);
      await writeSkill(
        workspace,
        "qa",
        "Run comprehensive quality assurance.",
        "CHANGED QA BODY",
      );
      const secondInput = new PassThrough();
      secondInput.end("$repo:qa retry\n/skills active\ncontinue\n");
      const secondRun = createRuntime(
        ["--resume", "durable", "--report", resumeReportPath],
        {
          cwd: workspace,
          env: {
            KEEL_FORCE_INTERACTIVE: "1",
            KEEL_HOME: home,
            DEEPSEEK_API_KEY: "test-key",
            DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
          },
          input: secondInput,
        },
      );

      // When
      const secondExitCode = await runCliMain(secondRun.runtime);

      // Then
      expect(firstExitCode).toBe(0);
      expect(secondExitCode).toBe(0);
      expect(capturedBodies).toHaveLength(2);
      expect(secondRun.stdout()).toContain("Active workflow skills:");
      expect(secondRun.stdout()).toContain("repo:review");
      expect(secondRun.stdout()).toContain("repo:qa");
      expect(secondRun.stdout()).toContain("changed_on_disk");
      expect(secondRun.stderr()).toContain("repo:qa changed_on_disk");
      const resumed = requestWithMessagesSchema.parse(capturedBodies[1]);
      const system = resumed.messages?.find(
        (message) => message.role === "system",
      )?.content;
      if (system === undefined || system === null) {
        throw new Error("resumed request had no system message");
      }
      expect(occurrences(system, "ORIGINAL REVIEW SNAPSHOT")).toBe(1);
      expect(occurrences(system, "ORIGINAL QA SNAPSHOT")).toBe(1);
      expect(system).not.toContain("CHANGED QA BODY");
      expect(
        JSON.parse(await readFile(resumeReportPath, "utf8")),
      ).toMatchObject({
        skillActivations: [],
        activeSkills: [
          { name: "repo:review", trigger: "user_explicit" },
          {
            name: "repo:qa",
            trigger: "user_explicit",
            diskStatus: "changed_on_disk",
          },
        ],
      });
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a persisted Skill changes on disk,
    When the user reloads it and later deactivates it,
    Then the new snapshot and inactive state persist across resume`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-skill-control-workspace-"),
    );
    const home = await mkdtemp(join(tmpdir(), "keel-skill-control-home-"));
    await writeSkill(
      workspace,
      "review",
      "Review a pull request.",
      "REVIEW VERSION ONE",
    );
    const firstInput = new PassThrough();
    firstInput.end("remember setup\n");
    const firstRun = createRuntime(
      ["--session", "controls", "--skill", "review"],
      {
        cwd: workspace,
        env: {
          KEEL_FORCE_INTERACTIVE: "1",
          KEEL_HOME: home,
          KEEL_PROVIDER: "fake",
        },
        input: firstInput,
      },
    );

    try {
      const firstExitCode = await runCliMain(firstRun.runtime);
      await writeSkill(
        workspace,
        "review",
        "Review a pull request.",
        "REVIEW VERSION TWO",
      );
      const controlInput = new PassThrough();
      controlInput.end(
        "/skill reload repo:review\n/skills active\n/skill deactivate repo:review\n/skills active\n",
      );
      const controlRun = createRuntime(["--resume", "controls"], {
        cwd: workspace,
        env: {
          KEEL_FORCE_INTERACTIVE: "1",
          KEEL_HOME: home,
          KEEL_PROVIDER: "deepseek",
          DEEPSEEK_API_KEY: "",
        },
        input: controlInput,
      });
      const controlExitCode = await runCliMain(controlRun.runtime);
      const resumedInput = new PassThrough();
      resumedInput.end("/skills active\n");
      const resumedRun = createRuntime(["--resume", "controls"], {
        cwd: workspace,
        env: {
          KEEL_FORCE_INTERACTIVE: "1",
          KEEL_HOME: home,
          KEEL_PROVIDER: "deepseek",
          DEEPSEEK_API_KEY: "",
        },
        input: resumedInput,
      });

      // When
      const resumedExitCode = await runCliMain(resumedRun.runtime);

      // Then
      expect(firstExitCode).toBe(0);
      expect(controlExitCode).toBe(0);
      expect(controlRun.stdout()).toContain(
        "Reloaded workflow skill repo:review.",
      );
      expect(controlRun.stdout()).toContain(
        "Deactivated workflow skill repo:review.",
      );
      expect(resumedExitCode).toBe(0);
      expect(resumedRun.stdout()).toBe("No active workflow skills.\n");
      expect(resumedRun.stderr()).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a model-selected Skill leaves an activation acknowledgment in history,
    When the user reloads and then deactivates it on later turns,
    Then provider requests contain only the current active snapshot and no stale body`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-skill-provider-lifecycle-workspace-"),
    );
    const home = await mkdtemp(
      join(tmpdir(), "keel-skill-provider-lifecycle-home-"),
    );
    await writeSkill(
      workspace,
      "review",
      "Review changes when asked.",
      "PROVIDER LIFECYCLE VERSION ONE",
    );
    const capturedBodies: unknown[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        capturedBodies.push(JSON.parse(body));
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        if (capturedBodies.length === 1) {
          res.write(
            sseToolCall("activate_review", "skill", { name: "repo:review" }),
          );
          res.write(sseToolFinish());
          res.end("data: [DONE]\n\n");
          return;
        }
        res.end(sseTextReplyWithUsage("Done."));
      });
    });
    await listen(server);

    try {
      const firstInput = new PassThrough();
      firstInput.end("review now\n");
      const firstRun = createRuntime(["--session", "provider-lifecycle"], {
        cwd: workspace,
        env: {
          KEEL_FORCE_INTERACTIVE: "1",
          KEEL_HOME: home,
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        },
        input: firstInput,
      });
      const firstExitCode = await runCliMain(firstRun.runtime);
      await writeSkill(
        workspace,
        "review",
        "Review changes when asked.",
        "PROVIDER LIFECYCLE VERSION TWO",
      );
      const reloadInput = new PassThrough();
      reloadInput.end("/skill reload repo:review\ncontinue after reload\n");
      const reloadRun = createRuntime(["--resume", "provider-lifecycle"], {
        cwd: workspace,
        env: {
          KEEL_FORCE_INTERACTIVE: "1",
          KEEL_HOME: home,
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        },
        input: reloadInput,
      });
      const reloadExitCode = await runCliMain(reloadRun.runtime);
      const deactivateInput = new PassThrough();
      deactivateInput.end(
        "/skill deactivate repo:review\ncontinue after deactivate\n",
      );
      const deactivateRun = createRuntime(["--resume", "provider-lifecycle"], {
        cwd: workspace,
        env: {
          KEEL_FORCE_INTERACTIVE: "1",
          KEEL_HOME: home,
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        },
        input: deactivateInput,
      });

      // When
      const deactivateExitCode = await runCliMain(deactivateRun.runtime);

      // Then
      expect(firstExitCode).toBe(0);
      expect(reloadExitCode).toBe(0);
      expect(deactivateExitCode).toBe(0);
      expect(capturedBodies).toHaveLength(4);
      const afterActivation = JSON.stringify(capturedBodies[1]);
      expect(
        occurrences(afterActivation, "PROVIDER LIFECYCLE VERSION ONE"),
      ).toBe(1);
      const afterReload = JSON.stringify(capturedBodies[2]);
      expect(afterReload).not.toContain("PROVIDER LIFECYCLE VERSION ONE");
      expect(occurrences(afterReload, "PROVIDER LIFECYCLE VERSION TWO")).toBe(
        1,
      );
      const afterDeactivate = JSON.stringify(capturedBodies[3]);
      expect(afterDeactivate).not.toContain("PROVIDER LIFECYCLE VERSION ONE");
      expect(afterDeactivate).not.toContain("PROVIDER LIFECYCLE VERSION TWO");
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given the first line of a named session arrives through an active input waiter,
    When the model selects a Skill before the lazy session is created,
    Then transcript and activation state appear only in the same append record`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-skill-lazy-atomic-workspace-"),
    );
    const home = await mkdtemp(join(tmpdir(), "keel-skill-lazy-atomic-home-"));
    await writeSkill(
      workspace,
      "review",
      "Review changes when asked.",
      "LAZY ATOMIC SKILL BODY",
    );
    const input = new PassThrough();
    let requests = 0;
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        JSON.parse(body);
        requests += 1;
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        if (requests === 1) {
          res.write(
            sseToolCall("activate_review", "skill", { name: "repo:review" }),
          );
          res.write(sseToolFinish());
          res.end("data: [DONE]\n\n");
          return;
        }
        res.end(sseTextReplyWithUsage("Done."));
        setTimeout(() => input.end(), 0);
      });
    });
    await listen(server);
    const run = createRuntime(["--session", "lazy-atomic"], {
      cwd: workspace,
      env: {
        KEEL_FORCE_INTERACTIVE: "1",
        KEEL_HOME: home,
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
      },
      input,
    });

    try {
      // When
      const runPromise = runCliMain(run.runtime);
      setTimeout(() => input.write("review now\n"), 0);
      const exitCode = await runPromise;

      // Then
      expect(exitCode).toBe(0);
      const ledger = await readFile(
        join(home, "sessions", "lazy-atomic", "ledger.jsonl"),
        "utf8",
      );
      const records = ledger
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(records.map((record) => record.type)).toEqual([
        "session",
        "append",
      ]);
      expect(records[1]).toMatchObject({
        type: "append",
        skillState: {
          skillActivations: [{ qualifiedName: "repo:review" }],
          activeSkillIds: [expect.any(String)],
        },
      });
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given the model activates a Skill in a named session,
    When the user compacts, continues, and later resumes,
    Then the exact Skill body survives once and remains active`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-skill-compact-workspace-"),
    );
    const home = await mkdtemp(join(tmpdir(), "keel-skill-compact-home-"));
    const reportPath = join(workspace, "report.json");
    await writeSkill(
      workspace,
      "review",
      "Review a pull request when asked to inspect changes.",
      "MODEL SELECTED DURABLE BODY",
    );
    const input = new PassThrough();
    const mainBodies: unknown[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const requestBody = JSON.parse(body);
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        if (isSummaryRequest(requestBody)) {
          res.end(
            sseTextReplyWithUsage(
              "Checkpoint intentionally omits Skill instructions.",
            ),
          );
          return;
        }
        mainBodies.push(requestBody);
        if (mainBodies.length === 1) {
          res.write(
            sseToolCall("activate_review", "skill", { name: "repo:review" }),
          );
          res.write(sseToolFinish());
          res.end("data: [DONE]\n\n");
          return;
        }
        res.end(
          sseTextReplyWithUsage(
            mainBodies.length === 2 ? "Activated." : "Continued.",
          ),
        );
        if (mainBodies.length === 2) {
          setTimeout(() => input.end("/compact\ncontinue after compact\n"), 0);
        }
      });
    });
    await listen(server);
    input.write("inspect the pull request\n");
    const run = createRuntime(
      ["--session", "model-selected", "--report", reportPath],
      {
        cwd: workspace,
        env: {
          KEEL_FORCE_INTERACTIVE: "1",
          KEEL_HOME: home,
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        },
        input,
      },
    );

    try {
      // When
      const exitCode = await runCliMain(run.runtime);
      const directForkRun = createRuntime(
        ["sessions", "fork", "model-selected", "compact-direct"],
        { cwd: workspace, env: { KEEL_HOME: home } },
      );
      const directForkExitCode = await runCliMain(directForkRun.runtime);
      const directForkInput = new PassThrough();
      directForkInput.end("/skills active\n");
      const directForkResume = createRuntime(["--resume", "compact-direct"], {
        cwd: workspace,
        env: {
          KEEL_FORCE_INTERACTIVE: "1",
          KEEL_HOME: home,
          KEEL_PROVIDER: "deepseek",
          DEEPSEEK_API_KEY: "",
        },
        input: directForkInput,
      });
      const directForkResumeExitCode = await runCliMain(
        directForkResume.runtime,
      );
      const resumeInput = new PassThrough();
      resumeInput.end("/skills active\n");
      const resumeRun = createRuntime(["--resume", "model-selected"], {
        cwd: workspace,
        env: {
          KEEL_FORCE_INTERACTIVE: "1",
          KEEL_HOME: home,
          KEEL_PROVIDER: "deepseek",
          DEEPSEEK_API_KEY: "",
        },
        input: resumeInput,
      });
      const resumeExitCode = await runCliMain(resumeRun.runtime);
      const restoredForkRun = createRuntime(
        ["sessions", "fork", "model-selected", "compact-restored"],
        { cwd: workspace, env: { KEEL_HOME: home } },
      );
      const restoredForkExitCode = await runCliMain(restoredForkRun.runtime);
      const restoredForkInput = new PassThrough();
      restoredForkInput.end("/skills active\n");
      const restoredForkResume = createRuntime(
        ["--resume", "compact-restored"],
        {
          cwd: workspace,
          env: {
            KEEL_FORCE_INTERACTIVE: "1",
            KEEL_HOME: home,
            KEEL_PROVIDER: "deepseek",
            DEEPSEEK_API_KEY: "",
          },
          input: restoredForkInput,
        },
      );
      const restoredForkResumeExitCode = await runCliMain(
        restoredForkResume.runtime,
      );

      // Then
      expect(exitCode).toBe(0);
      expect(directForkExitCode).toBe(0);
      expect(directForkResumeExitCode).toBe(0);
      expect(directForkResume.stdout()).toContain("repo:review");
      expect(mainBodies).toHaveLength(3);
      const afterCompact = requestWithMessagesSchema.parse(mainBodies[2]);
      const requestText = JSON.stringify(afterCompact);
      expect(occurrences(requestText, "MODEL SELECTED DURABLE BODY")).toBe(1);
      expect(resumeExitCode).toBe(0);
      expect(resumeRun.stdout()).toContain("repo:review");
      expect(resumeRun.stdout()).toContain("model_selected");
      expect(restoredForkExitCode).toBe(0);
      expect(restoredForkResumeExitCode).toBe(0);
      expect(restoredForkResume.stdout()).toContain("repo:review");
      expect(JSON.parse(await readFile(reportPath, "utf8"))).toMatchObject({
        activeSkills: [
          {
            name: "repo:review",
            trigger: "model_selected",
            diskStatus: "current",
          },
        ],
      });
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given two implicit Skills match successive tasks in one session,
    When the model activates one Skill on each user turn,
    Then the remaining catalog stays routable and both bodies become active once`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-skill-compose-workspace-"),
    );
    const home = await mkdtemp(join(tmpdir(), "keel-skill-compose-home-"));
    const reportPath = join(workspace, "report.json");
    await writeSkill(
      workspace,
      "review",
      "Review source changes when the user asks for review.",
      "COMPOSE REVIEW BODY",
    );
    await writeSkill(
      workspace,
      "qa",
      "Run quality assurance when the user asks to test changes.",
      "COMPOSE QA BODY",
    );
    const input = new PassThrough();
    const capturedBodies: unknown[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        capturedBodies.push(JSON.parse(body));
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        if (capturedBodies.length === 1) {
          res.write(
            sseToolCall("activate_review", "skill", { name: "repo:review" }),
          );
          res.write(sseToolFinish());
          res.end("data: [DONE]\n\n");
          return;
        }
        if (capturedBodies.length === 2) {
          res.end(sseTextReplyWithUsage("Review complete."));
          setTimeout(() => input.write("now run quality assurance\n"), 0);
          return;
        }
        if (capturedBodies.length === 3) {
          res.write(sseToolCall("activate_qa", "skill", { name: "repo:qa" }));
          res.write(sseToolFinish());
          res.end("data: [DONE]\n\n");
          return;
        }
        res.end(sseTextReplyWithUsage("QA complete."));
        input.end();
      });
    });
    await listen(server);
    input.write("review these changes\n");
    const run = createRuntime(
      ["--session", "composed", "--report", reportPath],
      {
        cwd: workspace,
        env: {
          KEEL_FORCE_INTERACTIVE: "1",
          KEEL_HOME: home,
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        },
        input,
      },
    );

    try {
      // When
      const exitCode = await runCliMain(run.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(capturedBodies).toHaveLength(4);
      const secondTurn = requestWithMessagesSchema.parse(capturedBodies[2]);
      const secondTurnSystem = secondTurn.messages?.find(
        (message) => message.role === "system",
      )?.content;
      if (secondTurnSystem === undefined || secondTurnSystem === null) {
        throw new Error("second turn request had no system message");
      }
      expect(secondTurnSystem).toContain("repo:qa");
      expect(occurrences(secondTurnSystem, "COMPOSE REVIEW BODY")).toBe(1);
      expect(secondTurnSystem).not.toContain("COMPOSE QA BODY");
      const afterSecondActivation = requestWithMessagesSchema.parse(
        capturedBodies[3],
      );
      const finalSystem = afterSecondActivation.messages?.find(
        (message) => message.role === "system",
      )?.content;
      if (finalSystem === undefined || finalSystem === null) {
        throw new Error("post-activation request had no system message");
      }
      expect(occurrences(finalSystem, "COMPOSE REVIEW BODY")).toBe(1);
      expect(occurrences(finalSystem, "COMPOSE QA BODY")).toBe(1);
      expect(JSON.parse(await readFile(reportPath, "utf8"))).toMatchObject({
        activeSkills: [
          { name: "repo:review", trigger: "model_selected" },
          { name: "repo:qa", trigger: "model_selected" },
        ],
      });
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a named session has multiple active Skill snapshots,
    When the user forks and resumes the target session,
    Then the fork inherits the same active identities and bodies`, async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-skill-fork-workspace-"),
    );
    const home = await mkdtemp(join(tmpdir(), "keel-skill-fork-home-"));
    await writeSkill(
      workspace,
      "review",
      "Review changes.",
      "FORK REVIEW BODY",
    );
    await writeSkill(workspace, "qa", "Test changes.", "FORK QA BODY");
    const input = new PassThrough();
    input.end("prepare fork\n");
    const sourceRun = createRuntime(
      ["--session", "source", "--skill", "review", "--skill", "qa"],
      {
        cwd: workspace,
        env: {
          KEEL_FORCE_INTERACTIVE: "1",
          KEEL_HOME: home,
          KEEL_PROVIDER: "fake",
        },
        input,
      },
    );

    try {
      const sourceExitCode = await runCliMain(sourceRun.runtime);
      const forkRun = createRuntime(["sessions", "fork", "source", "target"], {
        cwd: workspace,
        env: { KEEL_HOME: home },
      });

      // When
      const forkExitCode = await runCliMain(forkRun.runtime);
      const resumeInput = new PassThrough();
      resumeInput.end("/skills active\n");
      const resumeRun = createRuntime(["--resume", "target"], {
        cwd: workspace,
        env: {
          KEEL_FORCE_INTERACTIVE: "1",
          KEEL_HOME: home,
          KEEL_PROVIDER: "deepseek",
          DEEPSEEK_API_KEY: "",
        },
        input: resumeInput,
      });
      const resumeExitCode = await runCliMain(resumeRun.runtime);

      // Then
      expect(sourceExitCode).toBe(0);
      expect(forkExitCode).toBe(0);
      expect(resumeExitCode).toBe(0);
      expect(resumeRun.stdout()).toContain("repo:review");
      expect(resumeRun.stdout()).toContain("repo:qa");
      expect(resumeRun.stderr()).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
});
