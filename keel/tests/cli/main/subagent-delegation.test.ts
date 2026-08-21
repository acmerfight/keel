import { execFileSync } from "node:child_process";
import { symlinkSync, unlinkSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { runCliMain } from "../../../src/cli/index.ts";
import { runCliProcess } from "../../../src/testing/cli-harness.ts";
import {
  requestWithMessagesSchema,
  requestWithToolsSchema,
} from "../../../src/testing/cli-main-schemas.ts";
import {
  createRuntime,
  type SigintCapture,
} from "../../../src/testing/cli-runtime-fixtures.ts";
import {
  close,
  getPort,
  listen,
  sseTextReplyWithUsage,
  sseToolCall,
  sseToolFinish,
} from "../../../src/testing/provider-sse-fixtures.ts";

const requestSchema = requestWithMessagesSchema.and(requestWithToolsSchema);
const artifactRefSchema = z
  .string()
  .regex(/^tool-output:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u);

function toolNames(request: unknown): readonly string[] {
  return (
    requestSchema
      .parse(request)
      .tools?.flatMap((tool) =>
        tool.function?.name === undefined ? [] : [tool.function.name],
      ) ?? []
  );
}

function requestText(request: unknown): string {
  return JSON.stringify(requestSchema.parse(request));
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (result) => {
        clearTimeout(timeout);
        resolve(result);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

describe("CLI Main - Subagent Delegation", () => {
  test(`Given a clean Git checkout and an explicit writer delegation,
    When the child edits a tracked file,
    Then Main receives an inspectable patch while the user checkout stays unchanged`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-subagent-writer-"));
    const keelHome = await mkdtemp(
      join(tmpdir(), "keel-subagent-writer-home-"),
    );
    await writeFile(join(workspace, "message.txt"), "before\n");
    execFileSync("git", ["init", "--quiet", "--initial-branch=main"], {
      cwd: workspace,
    });
    execFileSync("git", ["config", "user.name", "Keel Test"], {
      cwd: workspace,
    });
    execFileSync("git", ["config", "user.email", "keel@example.test"], {
      cwd: workspace,
    });
    execFileSync("git", ["add", "message.txt"], { cwd: workspace });
    execFileSync("git", ["commit", "--quiet", "-m", "initial"], {
      cwd: workspace,
    });
    const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: workspace,
      encoding: "utf8",
    }).trim();
    const requests: unknown[] = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        requests.push(JSON.parse(body));
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        switch (requests.length) {
          case 1:
            response.end(
              [
                sseToolCall("delegate_writer", "delegate", {
                  profile: "writer",
                  task: "Change message.txt from before to after.",
                }),
                sseToolFinish(),
                "data: [DONE]\n\n",
              ].join(""),
            );
            return;
          case 2:
            response.end(
              [
                sseToolCall("writer_read", "read", { path: "message.txt" }),
                sseToolFinish(),
                "data: [DONE]\n\n",
              ].join(""),
            );
            return;
          case 3:
            response.end(
              [
                sseToolCall("writer_edit", "edit", {
                  path: "message.txt",
                  edits: [{ oldText: "before", newText: "after" }],
                }),
                sseToolFinish(),
                "data: [DONE]\n\n",
              ].join(""),
            );
            return;
          case 4:
            response.end(
              sseTextReplyWithUsage(
                "Changed message.txt in my isolated workspace.",
              ),
            );
            return;
          case 5:
            response.end(
              sseTextReplyWithUsage(
                "The writer patch is ready for inspection.",
              ),
            );
            return;
          default:
            response.writeHead(500);
            response.end("unexpected request");
        }
      });
    });
    await listen(server);
    const fixture = createRuntime(
      [
        "--agent-policy",
        "explicit",
        "--max-cost",
        "0.05",
        "Use a writer subagent to update message.txt.",
      ],
      {
        cwd: workspace,
        env: {
          KEEL_HOME: keelHome,
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        },
      },
    );

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode, fixture.stderr()).toBe(0);
      expect(requests).toHaveLength(5);
      expect(await readFile(join(workspace, "message.txt"), "utf8")).toBe(
        "before\n",
      );
      expect(
        execFileSync("git", ["status", "--porcelain"], {
          cwd: workspace,
          encoding: "utf8",
        }),
      ).toBe("");
      expect(toolNames(requests[1])).toEqual(
        expect.arrayContaining([
          "read",
          "edit",
          "write",
          "apply_patch",
          "git_status",
          "git_diff",
        ]),
      );
      expect(toolNames(requests[1])).not.toContain("bash");
      const mainContinuation = requestSchema.parse(requests[4]);
      const resultMessage = mainContinuation.messages?.findLast(
        (message) => message.role === "tool",
      );
      const projectedResult = z
        .object({
          status: z.literal("completed"),
          workspace: z.object({
            kind: z.literal("isolated_write"),
            baseCommit: z.literal(baseCommit),
            branch: z.string().regex(/^keel\/subagent\/[a-f0-9-]+$/u),
            disposition: z.literal("preserved"),
            worktreePath: z.string(),
            patchRef: artifactRefSchema,
            patchSha256: z.string().regex(/^[a-f0-9]{64}$/u),
          }),
        })
        .passthrough()
        .parse(JSON.parse(resultMessage?.content ?? "null"));
      const childSystemPrompt = requestSchema
        .parse(requests[1])
        .messages?.find((message) => message.role === "system")?.content;
      expect(childSystemPrompt).toContain(
        projectedResult.workspace.worktreePath,
      );
      expect(childSystemPrompt).not.toContain(
        "<isolated child worktree assigned at admission>",
      );
      expect(
        await readFile(
          join(projectedResult.workspace.worktreePath, "message.txt"),
          "utf8",
        ),
      ).toBe("after\n");
      expect(
        execFileSync("git", ["worktree", "list", "--porcelain"], {
          cwd: workspace,
          encoding: "utf8",
        }),
      ).toContain(projectedResult.workspace.worktreePath);
      expect(fixture.stdout()).toBe(
        "The writer patch is ready for inspection.\n",
      );
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(keelHome, { recursive: true, force: true });
    }
  });

  test(`Given the user checkout contains an uncommitted change,
    When Main requests a writer child,
    Then delegation fails before a worktree or child provider request is created`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-subagent-writer-dirty-"),
    );
    const keelHome = await mkdtemp(
      join(tmpdir(), "keel-subagent-writer-dirty-home-"),
    );
    await writeFile(join(workspace, "message.txt"), "committed\n");
    execFileSync("git", ["init", "--quiet", "--initial-branch=main"], {
      cwd: workspace,
    });
    execFileSync("git", ["config", "user.name", "Keel Test"], {
      cwd: workspace,
    });
    execFileSync("git", ["config", "user.email", "keel@example.test"], {
      cwd: workspace,
    });
    execFileSync("git", ["add", "message.txt"], { cwd: workspace });
    execFileSync("git", ["commit", "--quiet", "-m", "initial"], {
      cwd: workspace,
    });
    await writeFile(join(workspace, "message.txt"), "user change\n");
    const requests: unknown[] = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        requests.push(JSON.parse(body));
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        response.end(
          requests.length === 1
            ? [
                sseToolCall("delegate_dirty_writer", "delegate", {
                  profile: "writer",
                  task: "Replace the content of message.txt.",
                }),
                sseToolFinish(),
                "data: [DONE]\n\n",
              ].join("")
            : sseTextReplyWithUsage(
                "The writer was not started because the checkout is dirty.",
              ),
        );
      });
    });
    await listen(server);
    const fixture = createRuntime(
      [
        "--agent-policy",
        "explicit",
        "--max-cost",
        "0.05",
        "Use a writer subagent for message.txt.",
      ],
      {
        cwd: workspace,
        env: {
          KEEL_HOME: keelHome,
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        },
      },
    );

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode, fixture.stderr()).toBe(0);
      expect(requests).toHaveLength(2);
      expect(requestText(requests[1])).toContain(
        "parent checkout has staged, unstaged, untracked, or unmerged changes",
      );
      expect(await readFile(join(workspace, "message.txt"), "utf8")).toBe(
        "user change\n",
      );
      expect(
        execFileSync("git", ["worktree", "list", "--porcelain"], {
          cwd: workspace,
          encoding: "utf8",
        }).match(/^worktree /gmu),
      ).toHaveLength(1);
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(keelHome, { recursive: true, force: true });
    }
  });

  test(`Given automatic delegation has no explicit writer authority,
    When a provider attempts to forge a writer delegation,
    Then writer is absent from the model contract and no worktree is created`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-subagent-auto-"));
    const keelHome = await mkdtemp(join(tmpdir(), "keel-subagent-auto-home-"));
    await writeFile(join(workspace, "message.txt"), "before\n");
    execFileSync("git", ["init", "--quiet", "--initial-branch=main"], {
      cwd: workspace,
    });
    execFileSync("git", ["config", "user.name", "Keel Test"], {
      cwd: workspace,
    });
    execFileSync("git", ["config", "user.email", "keel@example.test"], {
      cwd: workspace,
    });
    execFileSync("git", ["add", "message.txt"], { cwd: workspace });
    execFileSync("git", ["commit", "--quiet", "-m", "initial"], {
      cwd: workspace,
    });
    const requests: unknown[] = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        requests.push(JSON.parse(body));
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.end(
          requests.length === 1
            ? [
                sseToolCall("forged_writer", "delegate", {
                  profile: "writer",
                  task: "Change message.txt.",
                }),
                sseToolFinish(),
                "data: [DONE]\n\n",
              ].join("")
            : sseTextReplyWithUsage("No writer was admitted."),
        );
      });
    });
    await listen(server);
    const fixture = createRuntime(
      [
        "--agent-policy",
        "auto",
        "--max-cost",
        "0.05",
        "Inspect whether message.txt needs work.",
      ],
      {
        cwd: workspace,
        env: {
          KEEL_HOME: keelHome,
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        },
      },
    );

    try {
      expect(await runCliMain(fixture.runtime), fixture.stderr()).toBe(0);
      expect(requests).toHaveLength(2);
      expect(requestText(requests[0])).not.toContain('"writer"');
      expect(requestText(requests[1])).toContain("invalid arguments");
      expect(
        execFileSync("git", ["worktree", "list", "--porcelain"], {
          cwd: workspace,
          encoding: "utf8",
        }).match(/^worktree /gmu),
      ).toHaveLength(1);
      expect(await readFile(join(workspace, "message.txt"), "utf8")).toBe(
        "before\n",
      );
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(keelHome, { recursive: true, force: true });
    }
  });

  test(`Given repository Skills live above a nested workspace,
    When the user explicitly delegates a read-only investigation,
    Then the child completes without requiring Skills to be disabled`, async () => {
    // Given
    const repository = await mkdtemp(
      join(tmpdir(), "keel-subagent-parent-skills-"),
    );
    const workspace = join(repository, "packages", "app");
    const keelHome = await mkdtemp(
      join(tmpdir(), "keel-subagent-parent-skills-home-"),
    );
    await mkdir(join(repository, ".git"));
    await mkdir(join(repository, ".agents", "skills", "review"), {
      recursive: true,
    });
    await mkdir(workspace, { recursive: true });
    await writeFile(
      join(repository, ".agents", "skills", "review", "SKILL.md"),
      [
        "---",
        "name: review",
        "description: Review repository changes.",
        "---",
        "Inspect relevant source before reporting findings.",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(workspace, "module.ts"),
      "export const answer = 42;\n",
    );
    const requests: unknown[] = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        requests.push(JSON.parse(body));
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        switch (requests.length) {
          case 1:
            response.end(
              [
                sseToolCall("delegate_nested_workspace", "delegate", {
                  profile: "explorer",
                  task: "Read module.ts and report the exported answer.",
                }),
                sseToolFinish(),
                "data: [DONE]\n\n",
              ].join(""),
            );
            return;
          case 2:
            response.end(
              [
                sseToolCall("read_nested_module", "read", {
                  path: "module.ts",
                }),
                sseToolFinish(),
                "data: [DONE]\n\n",
              ].join(""),
            );
            return;
          case 3:
            response.end(
              sseTextReplyWithUsage("module.ts exports answer with value 42."),
            );
            return;
          case 4:
            response.end(
              sseTextReplyWithUsage(
                "The delegated investigation confirmed answer equals 42.",
              ),
            );
            return;
          default:
            response.writeHead(500);
            response.end("unexpected request");
        }
      });
    });
    await listen(server);
    const fixture = createRuntime(
      [
        "--agent-policy",
        "explicit",
        "--max-cost",
        "0.05",
        "Use a read-only subagent to inspect module.ts.",
      ],
      {
        cwd: workspace,
        env: {
          KEEL_HOME: keelHome,
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        },
      },
    );

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode, fixture.stderr()).toBe(0);
      expect(requests).toHaveLength(4);
      expect(requestText(requests[2])).toContain("export const answer = 42;");
      expect(fixture.stderr()).toContain(
        "Tool: delegate Read module.ts and report the exported answer.",
      );
      expect(fixture.stdout()).toBe(
        "The delegated investigation confirmed answer equals 42.\n",
      );
    } finally {
      await close(server);
      await rm(repository, { recursive: true, force: true });
      await rm(keelHome, { recursive: true, force: true });
    }
  });

  test(`Given an in-workspace Skill changes canonical target after Main starts,
    When Main delegates a read-only investigation,
    Then the stale package authority fails closed before the child provider is called`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-subagent-skill-admission-race-"),
    );
    const keelHome = await mkdtemp(
      join(tmpdir(), "keel-subagent-skill-admission-race-home-"),
    );
    const skillRoot = join(workspace, ".agents", "skills");
    const firstPackage = join(skillRoot, ".review-first");
    const secondPackage = join(skillRoot, ".review-second");
    const requestedPackage = join(skillRoot, "review");
    await mkdir(firstPackage, { recursive: true });
    await mkdir(secondPackage, { recursive: true });
    for (const packagePath of [firstPackage, secondPackage]) {
      await writeFile(
        join(packagePath, "SKILL.md"),
        "---\nname: review\ndescription: Review repository changes.\n---\nReview the diff.\n",
      );
    }
    symlinkSync(firstPackage, requestedPackage, "dir");
    await writeFile(
      join(workspace, "module.ts"),
      "export const answer = 42;\n",
    );
    const requests: unknown[] = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        requests.push(JSON.parse(body));
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        switch (requests.length) {
          case 1:
            unlinkSync(requestedPackage);
            symlinkSync(secondPackage, requestedPackage, "dir");
            response.end(
              [
                sseToolCall("delegate_skill_race", "delegate", {
                  profile: "explorer",
                  task: "Read module.ts and report the exported answer.",
                }),
                sseToolFinish(),
                "data: [DONE]\n\n",
              ].join(""),
            );
            return;
          case 2:
            response.end(
              sseTextReplyWithUsage("Delegation was rejected safely."),
            );
            return;
          default:
            response.end(
              sseTextReplyWithUsage("Unexpected child provider request."),
            );
        }
      });
    });
    await listen(server);
    const fixture = createRuntime(
      [
        "--agent-policy",
        "explicit",
        "--max-cost",
        "0.05",
        "Use a read-only subagent to inspect module.ts.",
      ],
      {
        cwd: workspace,
        env: {
          KEEL_HOME: keelHome,
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        },
      },
    );

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode, fixture.stderr()).toBe(0);
      expect(requests).toHaveLength(2);
      const recoveryRequest = requestText(requests[1]);
      expect(recoveryRequest).toContain(
        "cannot enforce the workflow skill workspace boundary",
      );
      expect(recoveryRequest).toContain("repo:review");
      expect(recoveryRequest).toContain(
        "because its canonical package path is unavailable",
      );
      expect(fixture.stdout()).toBe("Delegation was rejected safely.\n");
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(keelHome, { recursive: true, force: true });
    }
  });

  test(`Given a project profile allows one workflow Skill while Main has another active,
    When one child uses the leased Skill and another child invents the unleased Skill name,
    Then only the leased instruction and resource load without gaining Main's Skill or write authority`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-subagent-skill-"));
    const keelHome = join(workspace, ".keel-home");
    await mkdir(join(workspace, ".git"));
    await mkdir(
      join(workspace, ".agents", "skills", "review-guide", "references"),
      {
        recursive: true,
      },
    );
    await mkdir(join(workspace, ".agents", "skills", "main-only"), {
      recursive: true,
    });
    await writeFile(
      join(workspace, ".agents", "skills", "review-guide", "SKILL.md"),
      [
        "---",
        "name: review-guide",
        "description: Apply the repository review checklist.",
        "---",
        "CHILD_REVIEW_GUIDE: read references/checklist.md before concluding.",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(
        workspace,
        ".agents",
        "skills",
        "review-guide",
        "references",
        "checklist.md",
      ),
      "CHECKLIST_FACT: exported values must remain stable.\n",
    );
    await writeFile(
      join(workspace, ".agents", "skills", "main-only", "SKILL.md"),
      [
        "---",
        "name: main-only",
        "description: Main-only workflow guidance.",
        "---",
        "MAIN_ONLY_SKILL_BODY: never copy this into a child.",
        "",
      ].join("\n"),
    );
    await mkdir(join(workspace, ".agents"), { recursive: true });
    await writeFile(
      join(workspace, ".agents", "subagents.json"),
      JSON.stringify({
        schemaVersion: 1,
        profiles: {
          "skilled-review": {
            base: "reviewer",
            tools: ["read", "grep", "git_diff"],
            skills: ["repo:review-guide"],
            maxTurns: 6,
          },
        },
      }),
    );
    const requests: unknown[] = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        requests.push(JSON.parse(body));
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        switch (requests.length) {
          case 1:
            response.end(
              [
                sseToolCall("delegate_skilled_review", "delegate", {
                  profile: "repo:skilled-review",
                  skills: ["repo:review-guide"],
                  task: "Use the allowed review guide to inspect the repository policy.",
                }),
                sseToolFinish(),
                "data: [DONE]\n\n",
              ].join(""),
            );
            return;
          case 2:
            response.end(
              [
                sseToolCall("read_leased_skill_directly", "read", {
                  path: ".agents/skills/review-guide/SKILL.md",
                }),
                sseToolFinish(),
                "data: [DONE]\n\n",
              ].join(""),
            );
            return;
          case 3:
            response.end(
              [
                sseToolCall("read_unleased_skill_directly", "read", {
                  path: ".agents/skills/main-only/SKILL.md",
                }),
                sseToolFinish(),
                "data: [DONE]\n\n",
              ].join(""),
            );
            return;
          case 4:
            response.end(
              [
                sseToolCall("activate_review_guide", "skill", {
                  name: "repo:review-guide",
                }),
                sseToolFinish(),
                "data: [DONE]\n\n",
              ].join(""),
            );
            return;
          case 5:
            response.end(
              [
                sseToolCall("read_review_checklist", "skill_resource", {
                  skill: "repo:review-guide",
                  path: "references/checklist.md",
                }),
                sseToolFinish(),
                "data: [DONE]\n\n",
              ].join(""),
            );
            return;
          case 6:
            response.end(
              sseTextReplyWithUsage(
                "The allowed checklist says exported values must remain stable.",
              ),
            );
            return;
          case 7:
            response.end(
              sseTextReplyWithUsage(
                "The child used the task-approved review guide only.",
              ),
            );
            return;
          case 8:
            response.end(
              [
                sseToolCall("delegate_unleased_attempt", "delegate", {
                  profile: "repo:skilled-review",
                  skills: ["repo:review-guide"],
                  task: "Confirm that only the task-leased review guide is usable.",
                }),
                sseToolFinish(),
                "data: [DONE]\n\n",
              ].join(""),
            );
            return;
          case 9:
            response.end(
              [
                sseToolCall("invent_unleased_skill", "skill", {
                  name: "repo:main-only",
                }),
                sseToolFinish(),
                "data: [DONE]\n\n",
              ].join(""),
            );
            return;
          case 10:
            response.end(
              sseTextReplyWithUsage(
                "The unleased Skill was denied by the child dispatcher.",
              ),
            );
            return;
          case 11:
            response.end(
              sseTextReplyWithUsage("The unleased Skill was denied."),
            );
            return;
          default:
            response.writeHead(500);
            response.end("unexpected request");
        }
      });
    });
    await listen(server);
    const fixture = createRuntime(
      [
        "--agent-policy",
        "explicit",
        "--skill",
        "repo:main-only",
        "--max-cost",
        "0.05",
        "Use a subagent with the project-approved review guide.",
      ],
      {
        cwd: workspace,
        env: {
          KEEL_HOME: keelHome,
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        },
      },
    );

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode, fixture.stderr()).toBe(0);
      expect(requests).toHaveLength(7);
      const childInitial = requestText(requests[1]);
      expect(childInitial).toContain("repo:review-guide");
      expect(childInitial).not.toContain("CHILD_REVIEW_GUIDE");
      expect(childInitial).not.toContain("repo:main-only");
      expect(childInitial).not.toContain("MAIN_ONLY_SKILL_BODY");
      expect(toolNames(requests[1]).toSorted()).toEqual(
        [
          "delegate",
          "read",
          "grep",
          "git_diff",
          "skill",
          "skill_search",
          "skill_resource",
        ].toSorted(),
      );
      expect(toolNames(requests[1])).not.toContain("write");
      expect(toolNames(requests[1])).not.toContain("bash");
      expect(requestText(requests[2])).toContain(
        "read failed: ignored path: .agents/skills/review-guide/SKILL.md",
      );
      expect(requestText(requests[2])).not.toContain("CHILD_REVIEW_GUIDE");
      expect(requestText(requests[3])).toContain(
        "read failed: ignored path: .agents/skills/main-only/SKILL.md",
      );
      expect(requestText(requests[3])).not.toContain("MAIN_ONLY_SKILL_BODY");
      expect(requestText(requests[4])).toContain("CHILD_REVIEW_GUIDE");
      expect(requestText(requests[4])).not.toContain("MAIN_ONLY_SKILL_BODY");
      expect(toolNames(requests[4]).toSorted()).toEqual(
        toolNames(requests[1]).toSorted(),
      );
      expect(requestText(requests[5])).toContain(
        "CHECKLIST_FACT: exported values must remain stable.",
      );
      expect(fixture.stdout()).toBe(
        "The child used the task-approved review guide only.\n",
      );

      const unauthorizedFixture = createRuntime(
        [
          "--agent-policy",
          "explicit",
          "--max-cost",
          "0.05",
          "Use a subagent to verify the Skill boundary.",
        ],
        {
          cwd: workspace,
          env: {
            KEEL_HOME: keelHome,
            DEEPSEEK_API_KEY: "test-key",
            DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
          },
        },
      );
      expect(
        await runCliMain(unauthorizedFixture.runtime),
        unauthorizedFixture.stderr(),
      ).toBe(0);
      expect(requests).toHaveLength(11);
      expect(requestText(requests[8])).toContain("repo:review-guide");
      expect(requestText(requests[8])).not.toContain("repo:main-only");
      expect(requestText(requests[9])).toContain(
        "outside this child Run's task lease",
      );
      expect(requestText(requests[9])).not.toContain("MAIN_ONLY_SKILL_BODY");
      expect(unauthorizedFixture.stdout()).toBe(
        "The unleased Skill was denied.\n",
      );
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given two child profiles allow different Skills,
    When Main asks one profile to use the other profile's Skill,
    Then the shared tool boundary rejects the profile and lease combination before starting a child request`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-subagent-skill-deny-"),
    );
    const keelHome = join(workspace, ".keel-home");
    await mkdir(join(workspace, ".git"));
    for (const name of ["alpha-guide", "beta-guide"]) {
      await mkdir(join(workspace, ".agents", "skills", name), {
        recursive: true,
      });
      await writeFile(
        join(workspace, ".agents", "skills", name, "SKILL.md"),
        `---\nname: ${name}\ndescription: Apply ${name}.\n---\n${name.toUpperCase()}_BODY\n`,
      );
    }
    await writeFile(
      join(workspace, ".agents", "subagents.json"),
      JSON.stringify({
        schemaVersion: 1,
        profiles: {
          alpha: { base: "explorer", skills: ["repo:alpha-guide"] },
          beta: { base: "explorer", skills: ["repo:beta-guide"] },
        },
      }),
    );
    const requests: unknown[] = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        requests.push(JSON.parse(body));
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        response.end(
          requests.length === 1
            ? [
                sseToolCall("cross_profile_skill", "delegate", {
                  profile: "repo:alpha",
                  skills: ["repo:beta-guide"],
                  task: "Use the beta guide.",
                }),
                sseToolFinish(),
                "data: [DONE]\n\n",
              ].join("")
            : sseTextReplyWithUsage("The unauthorized Skill was rejected."),
        );
      });
    });
    await listen(server);
    const fixture = createRuntime(
      ["--agent-policy", "explicit", "--max-cost", "0.05", "Use a subagent."],
      {
        cwd: workspace,
        env: {
          KEEL_HOME: keelHome,
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        },
      },
    );

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode, fixture.stderr()).toBe(0);
      expect(requests).toHaveLength(2);
      expect(requestText(requests[1])).toContain(
        "skills must be allowed by selected profile",
      );
      expect(requestText(requests[1])).not.toContain("BETA-GUIDE_BODY");
      expect(fixture.stdout()).toBe("The unauthorized Skill was rejected.\n");
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given auto agent policy is enabled with a minimal provider configuration,
    When main answers without delegating or writing a report,
    Then optional child metadata remains absent without changing one-shot behavior`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-subagent-minimal-"));
    const keelHome = await mkdtemp(join(tmpdir(), "keel-subagent-home-"));
    const fixture = createRuntime(
      ["--agent-policy", "auto", "--max-cost", "1", "Say hello."],
      {
        cwd: workspace,
        env: { KEEL_PROVIDER: "fake", KEEL_HOME: keelHome },
      },
    );

    try {
      expect(await runCliMain(fixture.runtime)).toBe(0);
      expect(fixture.stdout()).toBe("Hello from fake provider.\n");
      expect(fixture.stderr()).toBe("Cost: $0.000000 (budget $1.0000)\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(keelHome, { recursive: true, force: true });
    }
  });

  test(`Given agent policy is off by default,
    When the provider fabricates a delegate tool call,
    Then delegate is absent from the schema and dispatch fails closed without a child run`, async () => {
    // Given
    const requests: unknown[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        requests.push(JSON.parse(body));
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        if (requests.length === 1) {
          res.end(
            [
              sseToolCall("forged_delegate", "delegate", {
                task: "Inspect the workspace.",
              }),
              sseToolFinish(),
              "data: [DONE]\n\n",
            ].join(""),
          );
          return;
        }
        res.end(sseTextReplyWithUsage("Recovered without delegation."));
      });
    });
    await listen(server);
    const fixture = createRuntime(["Inspect the workspace."], {
      env: {
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
      },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(toolNames(requests[0])).not.toContain("delegate");
      expect(requestText(requests[0])).not.toContain("subagent");
      expect(
        requests,
        JSON.stringify({ stdout: fixture.stdout(), stderr: fixture.stderr() }),
      ).toHaveLength(2);
      expect(fixture.stdout()).toBe("Recovered without delegation.\n");
      expect(fixture.stderr()).toContain("Tool failed: delegate");
    } finally {
      await close(server);
    }
  });

  test(`Given the user requests two independent read-only investigations,
    When main delegates both in one tool round and the second child finishes first,
    Then the children overlap while main receives both settled results in source order`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-subagent-parallel-"));
    const reportPath = join(workspace, "report.json");
    await writeFile(join(workspace, "alpha.ts"), "export const alpha = 1;\n");
    await writeFile(join(workspace, "beta.ts"), "export const beta = 2;\n");
    const requests: unknown[] = [];
    const childResponses = new Map<string, ServerResponse>();
    const completionOrder: string[] = [];
    let activeChildRequests = 0;
    let maxActiveChildRequests = 0;
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const request: unknown = JSON.parse(body);
        requests.push(request);
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        if (requests.length === 1) {
          res.end(
            [
              sseToolCall(
                "delegate_alpha",
                "delegate",
                {
                  task: "Inspect alpha.ts only and report its exported value.",
                  focusPaths: ["alpha.ts"],
                },
                { index: 0 },
              ),
              sseToolCall(
                "delegate_beta",
                "delegate",
                {
                  task: "Inspect beta.ts only and report its exported value.",
                  focusPaths: ["beta.ts"],
                },
                { index: 1 },
              ),
              sseToolFinish(),
              "data: [DONE]\n\n",
            ].join(""),
          );
          return;
        }

        const parsed = requestSchema.parse(request);
        const requestMessages = JSON.stringify(parsed.messages);
        const isChildRequest = requestMessages.includes(
          "You are a fresh Keel explorer child agent",
        );
        const childName = isChildRequest
          ? requestMessages.includes("Inspect alpha.ts only")
            ? "alpha"
            : requestMessages.includes("Inspect beta.ts only")
              ? "beta"
              : null
          : null;
        if (childName !== null) {
          activeChildRequests++;
          maxActiveChildRequests = Math.max(
            maxActiveChildRequests,
            activeChildRequests,
          );
          res.on("close", () => {
            activeChildRequests--;
          });
          childResponses.set(childName, res);
          const alphaResponse = childResponses.get("alpha");
          const betaResponse = childResponses.get("beta");
          if (alphaResponse !== undefined && betaResponse !== undefined) {
            completionOrder.push("beta");
            betaResponse.end(
              sseTextReplyWithUsage("beta.ts:1 exports beta = 2."),
            );
            completionOrder.push("alpha");
            alphaResponse.end(
              sseTextReplyWithUsage("alpha.ts:1 exports alpha = 1."),
            );
          }
          return;
        }

        res.end(sseTextReplyWithUsage("Synthesized alpha then beta."));
      });
    });
    await listen(server);
    const fixture = createRuntime(
      [
        "--agent-policy",
        "explicit",
        "--no-skills",
        "--max-cost",
        "0.05",
        "--report",
        reportPath,
        "Use subagents to investigate alpha.ts and beta.ts independently in parallel.",
      ],
      {
        cwd: workspace,
        env: {
          KEEL_HOME: join(workspace, ".keel-home"),
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        },
      },
    );

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(
        maxActiveChildRequests,
        JSON.stringify({
          stderr: fixture.stderr(),
          stdout: fixture.stdout(),
          requestCount: requests.length,
          toolNames: requests.map(toolNames),
          toolResults: requests.map((request) =>
            requestSchema
              .parse(request)
              .messages?.filter((message) => message.role === "tool")
              .map((message) => ({
                id: message.tool_call_id,
                content: message.content,
              })),
          ),
        }),
      ).toBe(2);
      expect(completionOrder).toEqual(["beta", "alpha"]);
      const mainSynthesis = requestSchema.parse(requests.at(-1));
      const toolResults =
        mainSynthesis.messages?.filter((message) => message.role === "tool") ??
        [];
      expect(toolResults.map((message) => message.tool_call_id)).toEqual([
        "delegate_alpha",
        "delegate_beta",
      ]);
      expect(toolResults[0]?.content).toContain(
        "alpha.ts:1 exports alpha = 1.",
      );
      expect(toolResults[1]?.content).toContain("beta.ts:1 exports beta = 2.");
      expect(fixture.stdout()).toBe("Synthesized alpha then beta.\n");

      const report = z
        .object({
          subagents: z.object({
            status: z.literal("observed"),
            runs: z.array(
              z.object({
                delegationId: z.string(),
                childRunId: z.string(),
                status: z.string(),
              }),
            ),
          }),
          modelOperations: z.array(
            z
              .object({
                purpose: z.string(),
                attribution: z
                  .object({
                    type: z.literal("subagent"),
                    delegationId: z.string(),
                    childRunId: z.string(),
                    profile: z.string(),
                    effort: z.enum(["high", "max"]).nullable(),
                  })
                  .optional(),
              })
              .passthrough(),
          ),
        })
        .passthrough()
        .parse(JSON.parse(await readFile(reportPath, "utf8")));
      expect(report.subagents.runs).toHaveLength(2);
      expect(report.subagents.runs.map((run) => run.status)).toEqual([
        "completed",
        "completed",
      ]);
      expect(
        new Set(report.subagents.runs.map((run) => run.childRunId)).size,
      ).toBe(2);
      const childOperations = report.modelOperations.filter(
        (operation) => operation.purpose === "subagent_turn",
      );
      expect(childOperations).toHaveLength(2);
      expect(
        new Set(
          childOperations.map((operation) => operation.attribution?.childRunId),
        ).size,
      ).toBe(2);
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given experimental agents are enabled and the model first supplies an overlong delegation task,
    When main retries with valid arguments and the child finishes normally,
    Then the invalid call is recoverable, consumes no child slot, and the valid child runs once`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-subagent-retry-"));
    const reportPath = join(workspace, "report.json");
    const requests: unknown[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        requests.push(JSON.parse(body));
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        switch (requests.length) {
          case 1:
            res.end(
              [
                sseToolCall("delegate_too_long", "delegate", {
                  task: "x".repeat(4_001),
                }),
                sseToolFinish(),
                "data: [DONE]\n\n",
              ].join(""),
            );
            return;
          case 2:
            res.end(
              [
                sseToolCall("delegate_retry", "delegate", {
                  task: "Inspect the workspace and return a concise evidence summary.",
                }),
                sseToolFinish(),
                "data: [DONE]\n\n",
              ].join(""),
            );
            return;
          case 3:
            res.end(
              sseTextReplyWithUsage(
                "The delegated read-only investigation completed with no findings.",
              ),
            );
            return;
          case 4:
            res.end(
              sseTextReplyWithUsage(
                "Completed after one recovered delegation attempt.",
              ),
            );
            return;
          default:
            res.writeHead(500);
            res.end("unexpected request");
        }
      });
    });
    await listen(server);
    const fixture = createRuntime(
      [
        "--agent-policy",
        "explicit",
        "--no-skills",
        "--max-cost",
        "0.05",
        "--report",
        reportPath,
        "Use a subagent to inspect this workspace.",
      ],
      {
        cwd: workspace,
        env: {
          KEEL_HOME: join(workspace, ".keel-home"),
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        },
      },
    );

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(requests).toHaveLength(4);
      expect(toolNames(requests[0])).toContain("delegate");
      expect(toolNames(requests[1])).toContain("delegate");
      expect(toolNames(requests[2])).toContain("delegate");
      expect(toolNames(requests[3])).toContain("delegate");
      expect(requestText(requests[1])).toContain(
        "delegate failed: invalid arguments",
      );
      expect(requestText(requests[1])).toContain(
        "no longer than 4,000 characters",
      );
      expect(requestText(requests[3])).toContain(
        "The delegated read-only investigation completed with no findings.",
      );
      expect(fixture.stdout()).toBe(
        "Completed after one recovered delegation attempt.\n",
      );
      expect(fixture.stderr()).toContain("Tool failed: delegate");

      const report = z
        .object({
          modelOperations: z.array(
            z.object({ purpose: z.string() }).passthrough(),
          ),
        })
        .passthrough()
        .parse(JSON.parse(await readFile(reportPath, "utf8")));
      expect(
        report.modelOperations.filter(
          (operation) => operation.purpose === "subagent_turn",
        ),
      ).toHaveLength(1);
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given explicit delegation and a foreground read-only child with one focused subtask,
    When that child delegates the investigation to a grandchild,
    Then the nested result returns through the child while depth two cannot delegate again`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-subagent-nesting-"));
    await writeFile(
      join(workspace, "module.ts"),
      "export const nestedAnswer = 42;\n",
      "utf8",
    );
    const requests: unknown[] = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        requests.push(JSON.parse(body));
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        switch (requests.length) {
          case 1:
            response.end(
              [
                sseToolCall("delegate_parent", "delegate", {
                  profile: "reviewer",
                  task: "Coordinate a focused read-only review of module.ts.",
                  focusPaths: ["module.ts"],
                }),
                sseToolFinish(),
                "data: [DONE]\n\n",
              ].join(""),
            );
            return;
          case 2:
            response.end(
              [
                sseToolCall("delegate_nested", "delegate", {
                  profile: "reviewer",
                  task: "Read module.ts and report the exported value.",
                  focusPaths: ["module.ts"],
                }),
                sseToolFinish(),
                "data: [DONE]\n\n",
              ].join(""),
            );
            return;
          case 3:
            response.end(
              [
                sseToolCall("forged_third_level", "delegate", {
                  task: "Try to create an unsupported third-level child.",
                }),
                sseToolFinish(),
                "data: [DONE]\n\n",
              ].join(""),
            );
            return;
          case 4:
            response.end(
              [
                sseToolCall("nested_read", "read", { path: "module.ts" }),
                sseToolFinish(),
                "data: [DONE]\n\n",
              ].join(""),
            );
            return;
          case 5:
            response.end(
              sseTextReplyWithUsage(
                "module.ts:1 exports nestedAnswer with value 42.",
              ),
            );
            return;
          case 6:
            response.end(
              sseTextReplyWithUsage(
                "The nested investigation confirmed nestedAnswer equals 42.",
              ),
            );
            return;
          case 7:
            response.end(
              sseTextReplyWithUsage(
                "The delegated review confirmed nestedAnswer equals 42.",
              ),
            );
            return;
          default:
            response.writeHead(500);
            response.end("unexpected request");
        }
      });
    });
    await listen(server);
    const fixture = createRuntime(
      [
        "--agent-policy",
        "explicit",
        "--no-skills",
        "--max-cost",
        "0.05",
        "Use a subagent and let it delegate the focused module.ts investigation.",
      ],
      {
        cwd: workspace,
        env: {
          KEEL_HOME: join(workspace, ".keel-home"),
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        },
      },
    );

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode, fixture.stderr()).toBe(0);
      expect(requests).toHaveLength(7);
      expect(toolNames(requests[1])).toContain("delegate");
      expect(toolNames(requests[1])).not.toEqual(
        expect.arrayContaining(["write", "edit", "apply_patch", "bash"]),
      );
      const nestedDelegateSchema = z
        .object({
          function: z.object({
            parameters: z.object({
              properties: z.object({
                profile: z.object({ enum: z.array(z.string()) }),
                mode: z.object({ enum: z.array(z.string()) }),
              }),
            }),
          }),
        })
        .parse(
          requestSchema
            .parse(requests[1])
            .tools?.find((tool) => tool.function?.name === "delegate"),
        );
      expect(
        nestedDelegateSchema.function.parameters.properties.profile.enum,
      ).toEqual(["reviewer"]);
      expect(
        nestedDelegateSchema.function.parameters.properties.mode.enum,
      ).toEqual(["foreground"]);
      expect(toolNames(requests[2])).not.toContain("delegate");
      expect(toolNames(requests[2])).not.toEqual(
        expect.arrayContaining(["write", "edit", "apply_patch", "bash"]),
      );
      expect(requestText(requests[3])).toContain("Tool failed: delegate");
      expect(requestText(requests[5])).toContain(
        "module.ts:1 exports nestedAnswer with value 42.",
      );
      expect(requestText(requests[6])).toContain(
        "The nested investigation confirmed nestedAnswer equals 42.",
      );
      expect(fixture.stdout()).toBe(
        "The delegated review confirmed nestedAnswer equals 42.\n",
      );
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the user explicitly requests a subagent and a root cost budget is enabled,
    When one read-only child finishes with a normal evidence-based answer,
    Then host hands its bounded final to main without tool-specific evidence and main writes the result`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-subagent-"));
    const keelHome = join(workspace, ".keel-home");
    const reportPath = join(workspace, "report.json");
    await writeFile(
      join(workspace, "module.ts"),
      "export const answer = 42;\n",
      "utf8",
    );
    await writeFile(
      join(workspace, "AGENTS.md"),
      "DELEGATED_FIXTURE_RULE: report exact workspace evidence.\n",
      "utf8",
    );
    const requests: unknown[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        requests.push(JSON.parse(body));
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        switch (requests.length) {
          case 1:
            res.end(
              [
                sseToolCall("delegate_once", "delegate", {
                  task: "Inspect module.ts and report the exported value with exact file evidence.",
                  focusPaths: ["module.ts"],
                }),
                sseToolFinish(),
                "data: [DONE]\n\n",
              ].join(""),
            );
            return;
          case 2:
            res.end(
              [
                sseToolCall("child_read", "read", { path: "module.ts" }),
                sseToolFinish(),
                "data: [DONE]\n\n",
              ].join(""),
            );
            return;
          case 3:
            res.end(
              sseTextReplyWithUsage(
                "module.ts:1 exports answer with value 42. I observed it with the read tool.",
              ),
            );
            return;
          case 4:
            res.end(
              [
                sseToolCall("main_write", "write", {
                  path: "delegated-result.md",
                  content: "module.ts:1 exports answer = 42.\n",
                }),
                sseToolFinish(),
                "data: [DONE]\n\n",
              ].join(""),
            );
            return;
          case 5:
            res.end(
              sseTextReplyWithUsage(
                "Wrote delegated-result.md from the child handoff.",
              ),
            );
            return;
          default:
            res.writeHead(500);
            res.end("unexpected request");
        }
      });
    });
    await listen(server);
    const fixture = createRuntime(
      [
        "--agent-policy",
        "explicit",
        "--no-skills",
        "--max-cost",
        "0.05",
        "--report",
        reportPath,
        "使用 subagent 调研这个任务。\n\nPRIVATE PARENT CONTEXT: do not copy this. Analyze module.ts.",
      ],
      {
        cwd: workspace,
        env: {
          KEEL_HOME: keelHome,
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        },
      },
    );

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(
        requests,
        JSON.stringify({
          stdout: fixture.stdout(),
          stderr: fixture.stderr(),
          tools: requests.map(toolNames),
        }),
      ).toHaveLength(5);
      expect(toolNames(requests[0])).toContain("delegate");

      const childInitial = requestText(requests[1]);
      expect(childInitial).toContain(
        "Inspect module.ts and report the exported value with exact file evidence.",
      );
      expect(childInitial).toMatch(/Delegation ID: main-[^:]+:delegate_once/u);
      expect(childInitial).toContain("DELEGATED_FIXTURE_RULE");
      expect(childInitial).not.toContain("PRIVATE PARENT CONTEXT");
      expect(toolNames(requests[1]).toSorted()).toEqual(
        ["delegate", "glob", "grep", "ls", "read"].toSorted(),
      );
      expect(toolNames(requests[1])).not.toContain("write");
      expect(toolNames(requests[1])).not.toContain("edit");
      expect(toolNames(requests[1])).not.toContain("apply_patch");
      expect(toolNames(requests[1])).not.toContain("bash");
      expect(toolNames(requests[1])).toContain("delegate");

      const resumedMainRequest = requestSchema.parse(requests[3]);
      expect(toolNames(requests[3])).toContain("delegate");
      const delegatedToolResult = resumedMainRequest.messages?.find(
        (message) => message.tool_call_id === "delegate_once",
      )?.content;
      expect(delegatedToolResult).toContain(
        "module.ts:1 exports answer with value 42.",
      );
      expect(delegatedToolResult).not.toContain("observedResources");
      const artifactRef = artifactRefSchema.parse(
        delegatedToolResult?.match(
          /tool-output:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+/u,
        )?.[0],
      );
      expect(fixture.stdout()).toBe(
        "Wrote delegated-result.md from the child handoff.\n",
      );
      expect(
        await readFile(join(workspace, "delegated-result.md"), "utf8"),
      ).toBe("module.ts:1 exports answer = 42.\n");
      expect(fixture.stderr()).toMatch(/Subagent .*: queued .*deadline/u);
      expect(fixture.stderr()).toMatch(/Subagent .*: running/u);
      expect(fixture.stderr()).toMatch(/Subagent .*: turn 1 .*deadline/u);
      expect(fixture.stderr()).toMatch(/Subagent .*: tool read .*elapsed/u);
      expect(fixture.stderr()).toMatch(/Subagent .*: turn 2 .*deadline/u);
      expect(fixture.stderr()).not.toContain("submit_agent_result");
      expect(fixture.stderr()).toMatch(/Subagent .*: completed .*elapsed/u);

      const report = z
        .object({
          modelOperationCount: z.number(),
          providerRequestAttemptCount: z.number(),
          usage: z.object({
            inputTokens: z.number(),
            outputTokens: z.number(),
          }),
          costUsd: z.number(),
          modelOperations: z.array(
            z
              .object({
                purpose: z.string(),
                attribution: z
                  .object({
                    type: z.literal("subagent"),
                    delegationId: z.string(),
                    childRunId: z.string(),
                    profile: z.string(),
                    effort: z.enum(["high", "max"]).nullable(),
                  })
                  .optional(),
              })
              .passthrough(),
          ),
        })
        .passthrough()
        .parse(JSON.parse(await readFile(reportPath, "utf8")));
      expect(report.modelOperationCount).toBe(5);
      expect(report.providerRequestAttemptCount).toBe(5);
      expect(report.usage.inputTokens).toBe(50);
      expect(report.usage.outputTokens).toBe(15);
      expect(report.costUsd).toBeGreaterThan(0);
      const childOperations = report.modelOperations.filter(
        (operation) => operation.purpose === "subagent_turn",
      );
      expect(childOperations).toHaveLength(2);
      expect(childOperations.map((operation) => operation.attribution)).toEqual(
        [
          {
            type: "subagent",
            delegationId: expect.stringMatching(/^main-[^:]+:delegate_once$/u),
            childRunId: expect.stringMatching(/^subagent-/u),
            profile: "explorer",
            effort: null,
          },
          {
            type: "subagent",
            delegationId: expect.stringMatching(/^main-[^:]+:delegate_once$/u),
            childRunId: expect.stringMatching(/^subagent-/u),
            profile: "explorer",
            effort: null,
          },
        ],
      );
      expect(
        new Set(
          childOperations.map((operation) => operation.attribution?.childRunId),
        ).size,
      ).toBe(1);

      const inspectFixture = createRuntime(["artifacts", "show", artifactRef], {
        cwd: workspace,
        env: { KEEL_HOME: keelHome },
      });
      expect(await runCliMain(inspectFixture.runtime)).toBe(0);
      expect(inspectFixture.stdout()).toContain('"type":"transcript"');
      expect(inspectFixture.stdout()).toContain(
        '"origin":"runtime_subagent_delegation"',
      );
      expect(inspectFixture.stdout()).toContain(
        "module.ts:1 exports answer with value 42.",
      );
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an experimental interactive session and an explicit delegated investigation,
    When one read-only child returns evidence and the user sends a follow-up,
    Then main shows child progress, keeps the child transcript separate, and continues the same session`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-interactive-subagent-"),
    );
    const reportPath = join(workspace, "report.json");
    await writeFile(
      join(workspace, "module.ts"),
      "export const answer = 42;\n",
      "utf8",
    );
    const requests: unknown[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        requests.push(JSON.parse(body));
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        switch (requests.length) {
          case 1:
            res.end(
              [
                sseToolCall("interactive_delegate", "delegate", {
                  task: "Read module.ts and report the exported value.",
                  focusPaths: ["module.ts"],
                }),
                sseToolFinish(),
                "data: [DONE]\n\n",
              ].join(""),
            );
            return;
          case 2:
            res.end(
              [
                sseToolCall("interactive_child_read", "read", {
                  path: "module.ts",
                }),
                sseToolFinish(),
                "data: [DONE]\n\n",
              ].join(""),
            );
            return;
          case 3:
            res.end(sseTextReplyWithUsage("module.ts:1 exports answer = 42."));
            return;
          case 4:
            res.end(
              sseTextReplyWithUsage(
                "The subagent found that module.ts exports answer = 42.",
              ),
            );
            return;
          case 5:
            res.end(
              sseTextReplyWithUsage(
                "Follow-up confirmed from the existing main conversation.",
              ),
            );
            return;
          default:
            res.writeHead(500);
            res.end("unexpected request");
        }
      });
    });
    await listen(server);
    const input = new PassThrough();
    let renderedOutput = "";
    let markFirstAnswer: () => void = () => {};
    const firstAnswer = new Promise<void>((resolve) => {
      markFirstAnswer = resolve;
    });
    const fixture = createRuntime(
      [
        "--agent-policy",
        "explicit",
        "--no-skills",
        "--max-cost",
        "0.05",
        "--report",
        reportPath,
        "--ephemeral",
      ],
      {
        cwd: workspace,
        input,
        env: {
          KEEL_HOME: join(workspace, ".keel-home"),
          KEEL_FORCE_INTERACTIVE: "1",
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        },
        onStdout: (text) => {
          renderedOutput += text;
          if (
            renderedOutput.includes(
              "The subagent found that module.ts exports answer = 42.",
            )
          ) {
            markFirstAnswer();
          }
        },
      },
    );

    try {
      // When
      const run = runCliMain(fixture.runtime);
      input.write("Use a subagent to investigate module.ts.\n");
      await withTimeout(
        firstAnswer,
        5_000,
        "interactive main did not answer after delegation",
      );
      input.end("What did we establish?\n");
      const exitCode = await run;

      // Then
      expect(exitCode).toBe(0);
      expect(requests).toHaveLength(5);
      expect(toolNames(requests[0])).toContain("delegate");
      expect(toolNames(requests[1])).toContain("delegate");
      expect(toolNames(requests[1])).not.toContain("write");
      expect(toolNames(requests[4])).toContain("delegate");
      const continuedMain = requestText(requests[4]);
      expect(continuedMain).toContain(
        "Use a subagent to investigate module.ts.",
      );
      expect(continuedMain).toContain(
        "The subagent found that module.ts exports answer = 42.",
      );
      expect(continuedMain).toContain("What did we establish?");
      expect(continuedMain).not.toContain("interactive_child_read");
      expect(fixture.stdout()).toBe(
        [
          "The subagent found that module.ts exports answer = 42.",
          "Follow-up confirmed from the existing main conversation.",
          "",
        ].join("\n"),
      );
      expect(fixture.stderr()).toMatch(/Subagent .*: queued/u);
      expect(fixture.stderr()).toMatch(/Subagent .*: running/u);
      expect(fixture.stderr()).toMatch(/Subagent .*: tool read/u);
      expect(fixture.stderr()).toMatch(/Subagent .*: completed/u);
      const report = z
        .object({
          modelOperationCount: z.number(),
          providerRequestAttemptCount: z.number(),
          usage: z.object({
            inputTokens: z.number(),
            outputTokens: z.number(),
          }),
          modelOperations: z.array(
            z.object({ purpose: z.string() }).passthrough(),
          ),
        })
        .passthrough()
        .parse(JSON.parse(await readFile(reportPath, "utf8")));
      expect(report.modelOperationCount).toBe(5);
      expect(report.providerRequestAttemptCount).toBe(5);
      expect(report.usage).toMatchObject({
        inputTokens: 50,
        outputTokens: 15,
      });
      expect(
        report.modelOperations.filter(
          (operation) => operation.purpose === "subagent_turn",
        ),
      ).toHaveLength(2);
    } finally {
      input.end();
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an interactive foreground grandchild has an active provider request,
    When the user presses Ctrl-C once,
    Then cancellation crosses both child levels, the request closes, and no child answer enters the session`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-interactive-subagent-abort-"),
    );
    let requestCount = 0;
    let markChildStarted: () => void = () => {};
    let markChildClosed: () => void = () => {};
    const childStarted = new Promise<void>((resolve) => {
      markChildStarted = resolve;
    });
    const childClosed = new Promise<void>((resolve) => {
      markChildClosed = resolve;
    });
    const server = createServer((req, res) => {
      requestCount++;
      req.resume();
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      if (requestCount === 1) {
        res.end(
          [
            sseToolCall("interactive_delegate_abort", "delegate", {
              task: "Delegate the focused investigation, then wait for it.",
            }),
            sseToolFinish(),
            "data: [DONE]\n\n",
          ].join(""),
        );
        return;
      }
      if (requestCount === 2) {
        res.end(
          [
            sseToolCall("interactive_nested_abort", "delegate", {
              task: "Inspect the workspace until cancelled.",
            }),
            sseToolFinish(),
            "data: [DONE]\n\n",
          ].join(""),
        );
        return;
      }
      markChildStarted();
      res.on("close", markChildClosed);
      res.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { content: "still investigating" } }],
        })}\n\n`,
      );
    });
    await listen(server);
    const input = new PassThrough();
    const interrupt: SigintCapture = { handler: null };
    const fixture = createRuntime(
      ["--agent-policy", "explicit", "--max-cost", "0.05", "--ephemeral"],
      {
        cwd: workspace,
        input,
        env: {
          KEEL_HOME: join(workspace, ".keel-home"),
          KEEL_FORCE_INTERACTIVE: "1",
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        },
        onSigint: (handler) => {
          interrupt.handler = handler;
        },
        offSigint: (handler) => {
          if (interrupt.handler === handler) interrupt.handler = null;
        },
      },
    );

    try {
      const run = runCliMain(fixture.runtime);
      input.write(
        "Use a subagent and let it delegate the investigation until I interrupt.\n",
      );
      await withTimeout(
        childStarted,
        5_000,
        "interactive grandchild did not start",
      );

      // When
      expect(interrupt.handler).not.toBeNull();
      interrupt.handler?.();

      // Then
      await withTimeout(
        childClosed,
        5_000,
        "interactive grandchild remained live",
      );
      input.end();
      expect(
        await withTimeout(run, 5_000, "interactive session did not stop"),
      ).toBe(0);
      expect(requestCount).toBe(3);
      expect(fixture.stderr()).toMatch(/Subagent .*: cancelled/u);
      expect(fixture.stdout()).not.toContain("still investigating");
    } finally {
      input.end();
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an interactive child has completed and main synthesis is still running,
    When the user presses Ctrl-C,
    Then the next turn's cumulative cost still includes the completed child`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-interactive-subagent-accounting-abort-"),
    );
    const reportPath = join(workspace, "report.json");
    let requestCount = 0;
    let markMainSynthesisStarted: () => void = () => {};
    let markMainSynthesisClosed: () => void = () => {};
    const mainSynthesisStarted = new Promise<void>((resolve) => {
      markMainSynthesisStarted = resolve;
    });
    const mainSynthesisClosed = new Promise<void>((resolve) => {
      markMainSynthesisClosed = resolve;
    });
    const server = createServer((req, res) => {
      requestCount++;
      req.resume();
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      if (requestCount === 1) {
        res.end(
          [
            sseToolCall("interactive_delegate_then_abort", "delegate", {
              task: "Return one concise read-only finding.",
            }),
            sseToolFinish(),
            "data: [DONE]\n\n",
          ].join(""),
        );
        return;
      }
      if (requestCount === 2) {
        res.end(sseTextReplyWithUsage("The child completed its finding."));
        return;
      }
      if (requestCount === 3) {
        markMainSynthesisStarted();
        res.on("close", markMainSynthesisClosed);
        res.write(
          `data: ${JSON.stringify({
            choices: [{ delta: { content: "main synthesis in progress" } }],
          })}\n\n`,
        );
        return;
      }
      res.end(sseTextReplyWithUsage("The next main turn completed."));
    });
    await listen(server);
    const input = new PassThrough();
    const interrupt: SigintCapture = { handler: null };
    const fixture = createRuntime(
      [
        "--agent-policy",
        "explicit",
        "--max-cost",
        "0.05",
        "--report",
        reportPath,
        "--ephemeral",
      ],
      {
        cwd: workspace,
        input,
        env: {
          KEEL_HOME: join(workspace, ".keel-home"),
          KEEL_FORCE_INTERACTIVE: "1",
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        },
        onSigint: (handler) => {
          interrupt.handler = handler;
        },
        offSigint: (handler) => {
          if (interrupt.handler === handler) interrupt.handler = null;
        },
      },
    );

    try {
      const run = runCliMain(fixture.runtime);
      input.write("Use a subagent, then summarize its finding.\n");
      await withTimeout(
        mainSynthesisStarted,
        5_000,
        "main synthesis did not start after child completion",
      );
      expect(fixture.stderr()).toMatch(/Subagent .*: completed/u);

      // When
      expect(interrupt.handler).not.toBeNull();
      interrupt.handler?.();

      // Then
      await withTimeout(
        mainSynthesisClosed,
        5_000,
        "aborted main synthesis request remained live",
      );
      input.end("Continue in main without delegating.\n");
      expect(
        await withTimeout(run, 5_000, "interactive session did not stop"),
      ).toBe(0);
      const report = z
        .object({
          usage: z.object({
            inputTokens: z.number(),
            outputTokens: z.number(),
          }),
          costUsd: z.number(),
          modelOperations: z.array(
            z.object({ purpose: z.string() }).passthrough(),
          ),
        })
        .passthrough()
        .parse(JSON.parse(await readFile(reportPath, "utf8")));
      expect(report.usage).toEqual({
        inputTokens: 30,
        outputTokens: 9,
      });
      expect(report.costUsd).toBeGreaterThan(0);
      expect(
        report.modelOperations.filter(
          (operation) => operation.purpose === "subagent_turn",
        ),
      ).toHaveLength(1);
      const displayedCosts = Array.from(
        fixture.stderr().matchAll(/^Cost: \$([0-9.]+)/gmu),
        (match) => Number(match[1]),
      );
      expect(displayedCosts).toHaveLength(1);
      expect(displayedCosts[0]).toBeCloseTo(report.costUsd, 6);
    } finally {
      input.end();
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a foreground child provider request is running,
    When the user sends Ctrl-C to the real CLI process,
    Then the child request closes and Keel exits 130 without an orphan`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-subagent-abort-"));
    let requestCount = 0;
    let markChildStarted: () => void = () => {};
    let markChildClosed: () => void = () => {};
    const childStarted = new Promise<void>((resolve) => {
      markChildStarted = resolve;
    });
    const childClosed = new Promise<void>((resolve) => {
      markChildClosed = resolve;
    });
    const server = createServer((req, res) => {
      requestCount++;
      req.resume();
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      if (requestCount === 1) {
        res.end(
          [
            sseToolCall("delegate_abort", "delegate", {
              task: "Inspect the workspace until cancelled.",
            }),
            sseToolFinish(),
            "data: [DONE]\n\n",
          ].join(""),
        );
        return;
      }
      markChildStarted();
      res.on("close", markChildClosed);
      res.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { content: "still investigating" } }],
        })}\n\n`,
      );
    });
    await listen(server);
    const { child, result } = runCliProcess(
      [
        "--agent-policy",
        "explicit",
        "--max-cost",
        "0.05",
        "Delegate a read-only investigation.",
      ],
      {
        cwd: workspace,
        env: {
          KEEL_HOME: join(workspace, ".keel-home"),
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        },
      },
    );

    try {
      // When
      await withTimeout(childStarted, 5_000, "child request did not start");
      child.kill("SIGINT");

      // Then
      await withTimeout(childClosed, 5_000, "child request remained live");
      const exit = await withTimeout(result, 5_000, "CLI did not exit");
      expect(exit.exitCode).toBe(130);
      expect(exit.signal).toBeNull();
      expect(exit.stderr).toContain(": cancelled —");
      expect(exit.stderr).not.toMatch(/AbortError|DOMException/u);
    } finally {
      child.kill("SIGKILL");
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
