import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
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
import { createRuntime } from "../../../src/testing/cli-runtime-fixtures.ts";
import {
  close,
  getPort,
  listen,
  sseTextReplyWithUsage,
  sseToolCall,
  sseToolFinish,
} from "../../../src/testing/provider-sse-fixtures.ts";

const SESSION_ID = "agent-history";
const requestSchema = requestWithMessagesSchema.and(requestWithToolsSchema);

function toolNames(request: unknown): readonly string[] {
  return (
    requestSchema
      .parse(request)
      .tools?.flatMap((tool) =>
        tool.function?.name === undefined ? [] : [tool.function.name],
      ) ?? []
  );
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

describe("CLI Main - Durable Subagent History", () => {
  test(`Given an explicit foreground child delegates one read-only grandchild in a saved session,
    When the session is reopened through the agent history commands,
    Then both runs are durable and the grandchild points to its parent child run`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-nested-history-"));
    const keelHome = join(workspace, ".keel-home");
    const sessionId = "nested-agent-history";
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
                  task: "Coordinate the read-only module.ts review.",
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
                sseToolCall("nested_read", "read", { path: "module.ts" }),
                sseToolFinish(),
                "data: [DONE]\n\n",
              ].join(""),
            );
            return;
          case 4:
            response.end(
              sseTextReplyWithUsage("module.ts exports nestedAnswer = 42."),
            );
            return;
          case 5:
            response.end(
              sseTextReplyWithUsage("The nested review confirmed 42."),
            );
            return;
          case 6:
            response.end(sseTextReplyWithUsage("The review is complete."));
            return;
          default:
            response.writeHead(500);
            response.end("unexpected request");
        }
      });
    });
    await listen(server);
    const input = new PassThrough();
    input.end("Use a subagent and let it delegate the module.ts check.\n");
    const run = createRuntime(
      [
        "--session",
        sessionId,
        "--agent-policy",
        "explicit",
        "--max-cost",
        "0.05",
        "--no-skills",
      ],
      {
        cwd: workspace,
        input,
        env: {
          KEEL_HOME: keelHome,
          KEEL_FORCE_INTERACTIVE: "1",
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        },
      },
    );

    try {
      expect(await runCliMain(run.runtime), run.stderr()).toBe(0);

      // When
      const inspectInput = new PassThrough();
      inspectInput.end("/agents\n/agents show 1\n/agents show 2\n");
      const inspect = createRuntime(
        ["--resume", sessionId, "--provider", "fake", "--no-skills"],
        {
          cwd: workspace,
          input: inspectInput,
          env: { KEEL_HOME: keelHome, KEEL_FORCE_INTERACTIVE: "1" },
        },
      );
      const exitCode = await runCliMain(inspect.runtime);

      // Then
      expect(exitCode, inspect.stderr()).toBe(0);
      expect(requests).toHaveLength(6);
      const parentSection = inspect.stdout().split(/^Agent /mu)[1];
      const nestedSection = inspect.stdout().split(/^Agent /mu)[2];
      expect(parentSection).toBeDefined();
      expect(nestedSection).toBeDefined();
      const parentRunId = /^run: (subagent-[a-f0-9-]+)$/mu.exec(
        parentSection ?? "",
      )?.[1];
      expect(parentRunId).toBeDefined();
      expect(nestedSection).toContain(`parent run: ${parentRunId}`);
      expect(inspect.stdout()).toContain(
        "Read module.ts and report the exported value.",
      );
      expect(toolNames(requests[1])).toContain("delegate");
      expect(toolNames(requests[2])).not.toContain("delegate");

      const eventRecords = (
        await readFile(
          join(keelHome, "sessions", sessionId, "agents", "events.jsonl"),
          "utf8",
        )
      )
        .trim()
        .split("\n")
        .map((line) =>
          z.object({ type: z.string() }).passthrough().parse(JSON.parse(line)),
        );
      const accepted = eventRecords.filter(
        (record) => record.type === "agent_run_accepted",
      );
      expect(accepted).toHaveLength(2);
      expect(accepted[1]).toMatchObject({ parentRunId });
      const results = eventRecords
        .filter((record) => record.type === "agent_result")
        .map(
          (record) =>
            z
              .object({
                result: z.object({
                  childRunId: z.string(),
                  usage: z.object({
                    inputTokens: z.number(),
                    outputTokens: z.number(),
                  }),
                }),
              })
              .passthrough()
              .parse(record).result,
        );
      expect(results).toHaveLength(2);
      expect(
        results.find((result) => result.childRunId === parentRunId)?.usage,
      ).toMatchObject({ inputTokens: 40, outputTokens: 12 });
      expect(
        results.find((result) => result.childRunId !== parentRunId)?.usage,
      ).toMatchObject({ inputTokens: 20, outputTokens: 6 });
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a completed writer Thread preserves an isolated patch,
    When the user explicitly resumes that writer with one follow-up,
    Then the same Agent creates a new foreground Run on the same worktree while the old Run and parent stay unchanged`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-writer-resume-"));
    const keelHome = await mkdtemp(join(tmpdir(), "keel-writer-resume-home-"));
    const sessionId = "writer-resume";
    await writeFile(join(workspace, "message.txt"), "before\n", "utf8");
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
                  task: "Change message.txt from before to first.",
                }),
                sseToolFinish(),
                "data: [DONE]\n\n",
              ].join(""),
            );
            return;
          case 2:
          case 6:
            response.end(
              [
                sseToolCall(`writer_read_${requests.length}`, "read", {
                  path: "message.txt",
                }),
                sseToolFinish(),
                "data: [DONE]\n\n",
              ].join(""),
            );
            return;
          case 3:
            response.end(
              [
                sseToolCall("writer_first_edit", "edit", {
                  path: "message.txt",
                  edits: [{ oldText: "before", newText: "first" }],
                }),
                sseToolFinish(),
                "data: [DONE]\n\n",
              ].join(""),
            );
            return;
          case 4:
            response.end(sseTextReplyWithUsage("Made the first change."));
            return;
          case 5:
            response.end(sseTextReplyWithUsage("The first patch is ready."));
            return;
          case 7:
            response.end(
              [
                sseToolCall("writer_follow_up_edit", "edit", {
                  path: "message.txt",
                  edits: [{ oldText: "first", newText: "second" }],
                }),
                sseToolFinish(),
                "data: [DONE]\n\n",
              ].join(""),
            );
            return;
          case 8:
            response.end(sseTextReplyWithUsage("Made the follow-up change."));
            return;
          default:
            response.writeHead(500);
            response.end("unexpected request");
        }
      });
    });
    await listen(server);

    try {
      const firstInput = new PassThrough();
      firstInput.end("Use a writer subagent to update message.txt.\n");
      const first = createRuntime(
        [
          "--session",
          sessionId,
          "--agent-policy",
          "explicit",
          "--max-cost",
          "0.05",
          "--no-skills",
        ],
        {
          cwd: workspace,
          input: firstInput,
          env: {
            KEEL_HOME: keelHome,
            KEEL_FORCE_INTERACTIVE: "1",
            DEEPSEEK_API_KEY: "test-key",
            DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
          },
        },
      );
      expect(await runCliMain(first.runtime), first.stderr()).toBe(0);
      const firstMainContinuation = requestSchema.parse(requests[4]);
      const firstResult = z
        .object({
          workspace: z.object({
            branch: z.string(),
            worktreePath: z.string(),
            patchSha256: z.string(),
          }),
        })
        .passthrough()
        .parse(
          JSON.parse(
            firstMainContinuation.messages?.findLast(
              (message) => message.role === "tool",
            )?.content ?? "null",
          ),
        );
      const inspectInput = new PassThrough();
      inspectInput.end("/agents show 1\n");
      const inspect = createRuntime(
        [
          "--resume",
          sessionId,
          "--provider",
          "fake",
          "--agent-policy",
          "explicit",
          "--max-cost",
          "0.05",
          "--no-skills",
        ],
        {
          cwd: workspace,
          input: inspectInput,
          env: { KEEL_HOME: keelHome, KEEL_FORCE_INTERACTIVE: "1" },
        },
      );
      expect(await runCliMain(inspect.runtime), inspect.stderr()).toBe(0);
      const firstIdentity = z
        .object({ agentId: z.string(), runId: z.string() })
        .parse({
          agentId: /^Agent 1: (agent-[a-f0-9-]+)$/mu.exec(
            inspect.stdout(),
          )?.[1],
          runId: /^run: (subagent-[a-f0-9-]+)$/mu.exec(inspect.stdout())?.[1],
        });

      // When
      const followUpInput = new PassThrough();
      followUpInput.end(
        `/agents resume 1 Change message.txt from first to second.\n/agents show 1\n/agents show ${firstIdentity.runId}\n`,
      );
      const followUp = createRuntime(
        [
          "--resume",
          sessionId,
          "--agent-policy",
          "explicit",
          "--max-cost",
          "0.05",
          "--no-skills",
        ],
        {
          cwd: workspace,
          input: followUpInput,
          env: {
            KEEL_HOME: keelHome,
            KEEL_FORCE_INTERACTIVE: "1",
            DEEPSEEK_API_KEY: "test-key",
            DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
          },
        },
      );
      expect(await runCliMain(followUp.runtime), followUp.stderr()).toBe(0);

      // Then
      expect(requests).toHaveLength(8);
      const resumedResult = z
        .object({
          agentId: z.literal(firstIdentity.agentId),
          runId: z.string().refine((value) => value !== firstIdentity.runId),
          workspace: z.object({
            branch: z.literal(firstResult.workspace.branch),
            worktreePath: z.literal(firstResult.workspace.worktreePath),
            patchSha256: z
              .string()
              .refine((value) => value !== firstResult.workspace.patchSha256),
          }),
        })
        .passthrough()
        .parse(
          JSON.parse(
            followUp
              .stdout()
              .split("\n")
              .find((line) => line.startsWith("{")) ?? "null",
          ),
        );
      expect(JSON.stringify(requests[5])).toContain("Made the first change.");
      expect(JSON.stringify(requests[5])).toContain(
        "Change message.txt from first to second.",
      );
      expect(await readFile(join(workspace, "message.txt"), "utf8")).toBe(
        "before\n",
      );
      expect(
        execFileSync("git", ["status", "--porcelain"], {
          cwd: workspace,
          encoding: "utf8",
        }),
      ).toBe("");
      expect(
        await readFile(
          join(firstResult.workspace.worktreePath, "message.txt"),
          "utf8",
        ),
      ).toBe("second\n");
      expect(
        execFileSync("git", ["worktree", "list", "--porcelain"], {
          cwd: workspace,
          encoding: "utf8",
        }).match(/^worktree /gmu),
      ).toHaveLength(2);
      expect(followUp.stdout()).toContain(`Agent 1: ${firstIdentity.agentId}`);
      expect(followUp.stdout()).toContain(
        `continuation of: ${firstIdentity.runId}`,
      );
      expect(followUp.stdout()).toContain(
        `workspace branch: ${firstResult.workspace.branch}`,
      );
      expect(followUp.stdout()).toContain(
        `workspace worktree: ${firstResult.workspace.worktreePath}`,
      );
      expect(followUp.stdout()).toContain(`run: ${resumedResult.runId}`);
      expect(followUp.stdout()).toContain("result: Made the first change.");
      expect(followUp.stderr()).not.toContain("Background subagent");
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(keelHome, { recursive: true, force: true });
    }
  });

  test(`Given a project defines a narrower reviewer profile with a Skill ceiling, registered model, and effort,
    When main delegates it and the user resumes the thread after removing the profile and changing the Skill,
    Then execution stays stable while the changed Skill authority is removed from the resumed Run`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-repo-profile-"));
    const keelHome = join(workspace, ".keel-home");
    const sessionId = "repo-agent-profile";
    await mkdir(join(workspace, ".git"));
    await mkdir(
      join(workspace, ".agents", "skills", "review-guide", "references"),
      { recursive: true },
    );
    await writeFile(
      join(workspace, ".agents", "skills", "review-guide", "SKILL.md"),
      "---\nname: review-guide\ndescription: Review with the stable checklist.\n---\nDURABLE_REVIEW_SKILL\n",
      "utf8",
    );
    await mkdir(join(workspace, ".agents", "skills", "future-guide"), {
      recursive: true,
    });
    await writeFile(
      join(workspace, ".agents", "skills", "future-guide", "SKILL.md"),
      "---\nname: future-guide\ndescription: A second profile-approved workflow.\n---\nFUTURE_REVIEW_SKILL\n",
      "utf8",
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
      "Review exported values.\n",
      "utf8",
    );
    await writeFile(
      join(workspace, ".agents", "subagents.json"),
      JSON.stringify({
        schemaVersion: 1,
        profiles: {
          "focused-review": {
            base: "reviewer",
            model: "deepseek-v4-pro",
            effort: "max",
            tools: ["read", "grep", "git_diff"],
            skills: ["repo:review-guide", "repo:future-guide"],
            maxTurns: 4,
            deadlineMs: 30_000,
            maxResultChars: 1_200,
          },
        },
      }),
      "utf8",
    );
    await writeFile(
      join(workspace, "module.ts"),
      "export const answer = 42;\n",
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
                sseToolCall("delegate_repo_review", "delegate", {
                  profile: "repo:focused-review",
                  skills: ["repo:review-guide"],
                  task: "Review module.ts using the focused project profile.",
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
                sseToolCall("activate_focused_skill", "skill", {
                  name: "repo:review-guide",
                }),
                sseToolFinish(),
                "data: [DONE]\n\n",
              ].join(""),
            );
            return;
          case 3:
            response.end(
              [
                sseToolCall("focused_checklist", "skill_resource", {
                  skill: "repo:review-guide",
                  path: "references/checklist.md",
                }),
                sseToolFinish(),
                "data: [DONE]\n\n",
              ].join(""),
            );
            return;
          case 4:
            response.end(sseTextReplyWithUsage("R".repeat(2_000)));
            return;
          case 5:
            response.end(sseTextReplyWithUsage("Focused review completed."));
            return;
          case 6:
            response.end(
              [
                sseToolCall("reactivate_focused_skill", "skill", {
                  name: "repo:review-guide",
                }),
                sseToolFinish(),
                "data: [DONE]\n\n",
              ].join(""),
            );
            return;
          case 7:
            response.end(
              [
                sseToolCall("continued_checklist", "skill_resource", {
                  skill: "repo:review-guide",
                  path: "references/checklist.md",
                }),
                sseToolFinish(),
                "data: [DONE]\n\n",
              ].join(""),
            );
            return;
          case 8:
            response.end(
              sseTextReplyWithUsage("The retained Skill review is complete."),
            );
            return;
          case 9:
            response.end(
              [
                sseToolCall("continued_read", "read", { path: "module.ts" }),
                sseToolFinish(),
                "data: [DONE]\n\n",
              ].join(""),
            );
            return;
          case 10:
            response.end(
              sseTextReplyWithUsage("The focused review remains complete."),
            );
            return;
          default:
            response.writeHead(500);
            response.end("unexpected request");
        }
      });
    });
    await listen(server);
    const input = new PassThrough();
    input.end("Use the repo:focused-review subagent profile.\n");
    const run = createRuntime(
      [
        "--session",
        sessionId,
        "--agent-policy",
        "explicit",
        "--max-cost",
        "0.05",
      ],
      {
        cwd: workspace,
        input,
        env: {
          KEEL_HOME: keelHome,
          KEEL_FORCE_INTERACTIVE: "1",
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        },
      },
    );

    try {
      // When
      expect(await runCliMain(run.runtime), run.stderr()).toBe(0);
      const inspectInput = new PassThrough();
      inspectInput.end("/agents show 1\n");
      const inspect = createRuntime(
        [
          "--resume",
          sessionId,
          "--provider",
          "fake",
          "--agent-policy",
          "explicit",
          "--max-cost",
          "0.05",
        ],
        {
          cwd: workspace,
          input: inspectInput,
          env: {
            KEEL_HOME: keelHome,
            KEEL_FORCE_INTERACTIVE: "1",
          },
        },
      );
      const exitCode = await runCliMain(inspect.runtime);

      // Then
      expect(exitCode, inspect.stderr()).toBe(0);
      expect(requests).toHaveLength(5);
      expect(JSON.stringify(requests[0])).toContain("repo:focused-review");
      expect(requests[1]).toMatchObject({
        model: "deepseek-v4-pro",
        reasoning_effort: "max",
      });
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
      expect(JSON.stringify(requests[1])).not.toContain("DURABLE_REVIEW_SKILL");
      expect(JSON.stringify(requests[1])).not.toContain("repo:future-guide");
      expect(JSON.stringify(requests[2])).toContain("DURABLE_REVIEW_SKILL");
      expect(inspect.stdout()).toContain("profile: repo:focused-review");
      expect(inspect.stdout()).toContain("base profile: reviewer");
      expect(inspect.stdout()).toContain(
        "provider/model/effort: deepseek/deepseek-v4-pro/max",
      );
      expect(inspect.stdout()).toContain("tools: read, grep, git_diff");
      expect(inspect.stdout()).toContain("skills: repo:review-guide");
      expect(inspect.stdout()).toContain(
        "thread skill ceiling: repo:review-guide, repo:future-guide",
      );
      expect(inspect.stdout()).toContain(
        "limits: turns=4 deadlineMs=30000 resultChars=1200",
      );
      expect(inspect.stdout()).toContain(`result: ${"R".repeat(1_197)}...`);
      expect(inspect.stdout()).not.toContain("R".repeat(1_201));
      expect(inspect.stdout()).toContain("status: completed");

      const retainedInput = new PassThrough();
      retainedInput.end(
        "/agents resume 1 --skill repo:review-guide -- Re-check with the same guide.\n/agents wait 1\n/agents show 1\n",
      );
      const retained = createRuntime(
        [
          "--resume",
          sessionId,
          "--provider",
          "deepseek",
          "--agent-policy",
          "explicit",
          "--max-cost",
          "0.05",
        ],
        {
          cwd: workspace,
          input: retainedInput,
          env: {
            KEEL_HOME: keelHome,
            KEEL_FORCE_INTERACTIVE: "1",
            DEEPSEEK_API_KEY: "test-key",
            DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
          },
        },
      );
      expect(await runCliMain(retained.runtime), retained.stderr()).toBe(0);
      expect(requests).toHaveLength(8);
      expect(requests[5]).toMatchObject({
        model: "deepseek-v4-pro",
        reasoning_effort: "max",
      });
      expect(toolNames(requests[5])).toContain("skill");
      expect(JSON.stringify(requests[5])).not.toContain("DURABLE_REVIEW_SKILL");
      expect(JSON.stringify(requests[6])).toContain("DURABLE_REVIEW_SKILL");
      expect(retained.stdout()).toContain("skills: repo:review-guide");

      await writeFile(
        join(workspace, ".agents", "skills", "review-guide", "SKILL.md"),
        "---\nname: review-guide\ndescription: Changed review workflow.\n---\nCHANGED_REVIEW_SKILL\n",
        "utf8",
      );
      await rm(join(workspace, ".agents", "subagents.json"));
      const resumeInput = new PassThrough();
      resumeInput.end(
        "/agents resume 1 Re-check module.ts.\n/agents wait 1\n/agents show 1\n",
      );
      const resume = createRuntime(
        [
          "--resume",
          sessionId,
          "--provider",
          "fake",
          "--agent-policy",
          "explicit",
          "--max-cost",
          "0.05",
        ],
        {
          cwd: workspace,
          input: resumeInput,
          env: {
            KEEL_HOME: keelHome,
            KEEL_FORCE_INTERACTIVE: "1",
            DEEPSEEK_API_KEY: "test-key",
            DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
          },
        },
      );

      expect(await runCliMain(resume.runtime), resume.stderr()).toBe(0);
      expect(requests).toHaveLength(10);
      expect(requests[8]).toMatchObject({
        model: "deepseek-v4-pro",
        reasoning_effort: "max",
      });
      expect(toolNames(requests[8]).toSorted()).toEqual(
        ["read", "grep", "git_diff"].toSorted(),
      );
      expect(JSON.stringify(requests[8])).not.toContain("DURABLE_REVIEW_SKILL");
      expect(JSON.stringify(requests[8])).not.toContain("CHANGED_REVIEW_SKILL");
      expect(resume.stdout()).toContain("profile: repo:focused-review");
      expect(resume.stdout()).toContain(
        "provider/model/effort: deepseek/deepseek-v4-pro/max",
      );
      expect(resume.stdout()).toContain(
        "limits: turns=4 deadlineMs=30000 resultChars=1200",
      );
      expect(resume.stdout()).toContain("skills: none");
      expect(resume.stdout()).toContain(
        "thread skill ceiling: repo:review-guide, repo:future-guide",
      );
      expect(resume.stdout()).toContain("The focused review remains complete.");
      expect(resume.stdout()).toContain("continuation of:");
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a project profile tries to add a tool outside its built-in base,
    When Keel loads the enabled subagent runtime,
    Then it fails closed before making any provider request`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-repo-expansion-"));
    const keelHome = join(workspace, ".keel-home");
    await mkdir(join(workspace, ".git"));
    await mkdir(join(workspace, ".agents"));
    await writeFile(
      join(workspace, ".agents", "subagents.json"),
      JSON.stringify({
        schemaVersion: 1,
        profiles: {
          unsafe: {
            base: "explorer",
            tools: ["read", "git_diff"],
          },
        },
      }),
      "utf8",
    );
    let providerRequests = 0;
    const server = createServer((request, response) => {
      providerRequests++;
      request.resume();
      response.writeHead(500);
      response.end("must not be called");
    });
    await listen(server);
    const run = createRuntime(
      [
        "--agent-policy",
        "explicit",
        "--max-cost",
        "0.05",
        "--no-skills",
        "Inspect module.ts",
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
      const exitCode = await runCliMain(run.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(providerRequests).toBe(0);
      expect(run.stderr()).toContain(
        'project subagent profile "repo:unsafe" expands explorer builtinTools',
      );
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a project profile names an explicit-only workflow Skill,
    When Keel loads the enabled subagent runtime,
    Then it fails closed before the Skill can become model-selectable or any provider request starts`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-repo-skill-policy-"));
    const keelHome = join(workspace, ".keel-home");
    await mkdir(join(workspace, ".git"));
    await mkdir(join(workspace, ".agents", "skills", "manual-guide"), {
      recursive: true,
    });
    await writeFile(
      join(workspace, ".agents", "skills", "manual-guide", "SKILL.md"),
      "---\nname: manual-guide\ndescription: Run only after direct user activation.\nmetadata:\n  keel.activation: explicit\n---\nMANUAL_ONLY_BODY\n",
      "utf8",
    );
    await writeFile(
      join(workspace, ".agents", "subagents.json"),
      JSON.stringify({
        schemaVersion: 1,
        profiles: {
          unsafe: {
            base: "explorer",
            skills: ["repo:manual-guide"],
          },
        },
      }),
      "utf8",
    );
    let providerRequests = 0;
    const server = createServer((request, response) => {
      providerRequests++;
      request.resume();
      response.writeHead(500);
      response.end("must not be called");
    });
    await listen(server);
    const run = createRuntime(
      ["--agent-policy", "explicit", "--max-cost", "0.05", "Inspect module.ts"],
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
      expect(await runCliMain(run.runtime)).toBe(1);
      expect(providerRequests).toBe(0);
      expect(run.stderr()).toContain(
        'references unavailable or non-model-activatable workflow Skill "repo:manual-guide"',
      );
      expect(run.stderr()).not.toContain("MANUAL_ONLY_BODY");
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a project profile requests an effort its selected model does not support,
    When Keel loads the enabled subagent runtime,
    Then it rejects the profile instead of silently ignoring the effort`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-repo-effort-"));
    const keelHome = join(workspace, ".keel-home");
    await mkdir(join(workspace, ".git"));
    await mkdir(join(workspace, ".agents"));
    await writeFile(
      join(workspace, ".agents", "subagents.json"),
      JSON.stringify({
        schemaVersion: 1,
        profiles: {
          unsupported: {
            base: "explorer",
            effort: "max",
          },
        },
      }),
      "utf8",
    );
    const run = createRuntime(
      [
        "--provider",
        "fake",
        "--agent-policy",
        "explicit",
        "--max-cost",
        "0.05",
        "Inspect module.ts",
      ],
      { cwd: workspace, env: { KEEL_HOME: keelHome } },
    );

    try {
      // When
      const exitCode = await runCliMain(run.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(run.stderr()).toContain(
        'project subagent effort "max" is unsupported by fake/fake',
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a saved session asks for a reviewer subagent,
    When main delegates the review and the user later inspects that agent,
    Then the child has reviewer-only tools and /agents shows its durable capability snapshot`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-agent-profile-"));
    const keelHome = join(workspace, ".keel-home");
    const sessionId = "reviewer-agent-profile";
    await writeFile(
      join(workspace, "module.ts"),
      "export const answer = 42;\n",
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
                sseToolCall("delegate_review", "delegate", {
                  profile: "reviewer",
                  task: "Review module.ts and report one evidence-based finding.",
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
                sseToolCall("reviewer_read", "read", {
                  path: "module.ts",
                }),
                sseToolFinish(),
                "data: [DONE]\n\n",
              ].join(""),
            );
            return;
          case 3:
            response.end(
              sseTextReplyWithUsage(
                "module.ts:1 exports a constant without tests.",
              ),
            );
            return;
          case 4:
            response.end(
              sseTextReplyWithUsage("The reviewer found missing coverage."),
            );
            return;
          default:
            response.writeHead(500);
            response.end("unexpected request");
        }
      });
    });
    await listen(server);
    const input = new PassThrough();
    input.end("Use a reviewer subagent to review module.ts.\n");
    const run = createRuntime(
      [
        "--session",
        sessionId,
        "--agent-policy",
        "explicit",
        "--max-cost",
        "0.05",
        "--no-skills",
      ],
      {
        cwd: workspace,
        input,
        env: {
          KEEL_HOME: keelHome,
          KEEL_FORCE_INTERACTIVE: "1",
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        },
      },
    );

    try {
      // When
      expect(await runCliMain(run.runtime), run.stderr()).toBe(0);
      const inspectInput = new PassThrough();
      inspectInput.end("/agents show 1\n");
      const inspect = createRuntime(
        [
          "--resume",
          sessionId,
          "--provider",
          "fake",
          "--agent-policy",
          "explicit",
          "--max-cost",
          "0.05",
          "--no-skills",
        ],
        {
          cwd: workspace,
          input: inspectInput,
          env: {
            KEEL_HOME: keelHome,
            KEEL_FORCE_INTERACTIVE: "1",
          },
        },
      );
      const exitCode = await runCliMain(inspect.runtime);

      // Then
      expect(exitCode, inspect.stderr()).toBe(0);
      expect(requests).toHaveLength(4);
      expect(toolNames(requests[1]).toSorted()).toEqual(
        [
          "delegate",
          "read",
          "ls",
          "glob",
          "grep",
          "git_status",
          "git_diff",
        ].toSorted(),
      );
      expect(inspect.stdout()).toContain("profile: reviewer");
      expect(inspect.stdout()).toContain(
        "capability snapshot: builtin-reviewer-v1",
      );
      expect(inspect.stdout()).toContain("status: completed");
      expect(inspect.stdout()).toContain(
        "result: module.ts:1 exports a constant without tests.",
      );
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a saved-session delegation has an invalid focus path,
    When admission rejects it before creating a child run,
    Then only the durable rejection receipt remains and main can continue`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "keel-agent-rejection-"));
    const keelHome = join(workspace, ".keel-home");
    const sessionId = "rejected-agent-history";
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
        if (requests.length === 1) {
          response.end(
            [
              sseToolCall("delegate_outside", "delegate", {
                task: "Inspect a path outside the workspace.",
                focusPaths: ["../outside"],
              }),
              sseToolFinish(),
              "data: [DONE]\n\n",
            ].join(""),
          );
          return;
        }
        response.end(
          sseTextReplyWithUsage("The unsafe delegation was rejected."),
        );
      });
    });
    await listen(server);
    const input = new PassThrough();
    input.end("Use a subagent to inspect an unsafe path.\n");
    const fixture = createRuntime(
      [
        "--session",
        sessionId,
        "--agent-policy",
        "explicit",
        "--max-cost",
        "0.05",
        "--no-skills",
      ],
      {
        cwd: workspace,
        input,
        env: {
          KEEL_HOME: keelHome,
          KEEL_FORCE_INTERACTIVE: "1",
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        },
      },
    );

    try {
      expect(await runCliMain(fixture.runtime), fixture.stderr()).toBe(0);
      expect(requests).toHaveLength(2);
      const recoveryRequest = requestWithMessagesSchema.parse(requests[1]);
      expect(recoveryRequest.messages).toContainEqual(
        expect.objectContaining({
          role: "tool",
          content: expect.stringMatching(
            /Tool failed:.*invalid focus path[\s\S]*Recovery:.*Correct or omit/u,
          ),
        }),
      );
      expect(fixture.stdout()).toContain("The unsafe delegation was rejected.");
      const agentsDirectory = join(keelHome, "sessions", sessionId, "agents");
      const events = await readFile(
        join(agentsDirectory, "events.jsonl"),
        "utf8",
      );
      expect(events).toContain('"type":"delegation_rejected"');
      expect(events).not.toContain('"type":"agent_run_accepted"');
      expect(events).not.toContain('"type":"agent_result"');
      await expect(
        readdir(join(agentsDirectory, "transcripts")),
      ).resolves.toEqual([]);
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a saved interactive session completed a foreground child,
    When the user restarts Keel, inspects its agents, and forks the parent session,
    Then terminal facts survive restart while the parent ledger and fork stay free of copied child history`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-agent-history-"));
    const keelHome = join(workspace, ".keel-home");
    await writeFile(
      join(workspace, "module.ts"),
      "export const answer = 42;\n",
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
                sseToolCall("delegate_module", "delegate", {
                  task: "Read module.ts and report its exported value.",
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
                sseToolCall("child_read_module", "read", {
                  path: "module.ts",
                }),
                sseToolFinish(),
                "data: [DONE]\n\n",
              ].join(""),
            );
            return;
          case 3:
            response.end(
              sseTextReplyWithUsage("module.ts:1 exports answer = 42."),
            );
            return;
          case 4:
            response.end(
              sseTextReplyWithUsage(
                "The child confirmed that module.ts exports answer = 42.",
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
    const firstInput = new PassThrough();
    firstInput.end("Use a subagent to investigate module.ts.\n");
    const first = createRuntime(
      [
        "--session",
        SESSION_ID,
        "--agent-policy",
        "explicit",
        "--max-cost",
        "0.05",
        "--no-skills",
      ],
      {
        cwd: workspace,
        input: firstInput,
        env: {
          KEEL_HOME: keelHome,
          KEEL_FORCE_INTERACTIVE: "1",
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        },
      },
    );

    try {
      expect(await runCliMain(first.runtime)).toBe(0);
      expect(requests).toHaveLength(4);
      expect(first.stdout()).toContain(
        "The child confirmed that module.ts exports answer = 42.",
      );

      // When
      const resumedInput = new PassThrough();
      resumedInput.end(
        ["/agents", "/agents show 1", "/agents transcript 1", ""].join("\n"),
      );
      const resumed = createRuntime(
        [
          "--resume",
          SESSION_ID,
          "--provider",
          "fake",
          "--agent-policy",
          "explicit",
          "--max-cost",
          "0.05",
          "--no-skills",
        ],
        {
          cwd: workspace,
          input: resumedInput,
          env: {
            KEEL_HOME: keelHome,
            KEEL_FORCE_INTERACTIVE: "1",
          },
        },
      );
      const exitCode = await runCliMain(resumed.runtime);

      // Then
      expect(exitCode, resumed.stderr()).toBe(0);
      expect(requests).toHaveLength(4);
      expect(resumed.stdout()).toContain(`Agents for session: ${SESSION_ID}`);
      expect(resumed.stdout()).toContain("status: completed");
      expect(resumed.stdout()).toContain(
        "task: Read module.ts and report its exported value.",
      );
      expect(resumed.stdout()).toContain("turns: 2");
      expect(resumed.stdout()).toContain("cost: $");
      expect(resumed.stdout()).toContain(
        "result: module.ts:1 exports answer = 42.",
      );
      expect(resumed.stdout()).toContain("Child transcript");
      expect(resumed.stdout()).toContain('"type":"transcript"');
      expect(resumed.stdout()).toContain("child_read_module");

      const parentLedger = await readFile(
        join(keelHome, "sessions", SESSION_ID, "ledger.jsonl"),
        "utf8",
      );
      expect(parentLedger).not.toContain("child_read_module");
      expect(
        requestWithMessagesSchema.parse(requests.at(-1)).messages,
      ).toBeDefined();

      const forkSessionId = "agent-history-fork";
      const forked = createRuntime(
        ["sessions", "fork", SESSION_ID, forkSessionId],
        {
          cwd: workspace,
          env: { KEEL_HOME: keelHome },
        },
      );
      expect(await runCliMain(forked.runtime), forked.stderr()).toBe(0);

      const forkInput = new PassThrough();
      forkInput.end("/agents\n");
      const inspectFork = createRuntime(
        ["--resume", forkSessionId, "--provider", "fake", "--no-skills"],
        {
          cwd: workspace,
          input: forkInput,
          env: {
            KEEL_HOME: keelHome,
            KEEL_FORCE_INTERACTIVE: "1",
          },
        },
      );
      expect(await runCliMain(inspectFork.runtime), inspectFork.stderr()).toBe(
        0,
      );
      expect(inspectFork.stdout()).toContain("No subagents recorded.");
      const forkEvents = await readFile(
        join(keelHome, "sessions", forkSessionId, "agents", "events.jsonl"),
        "utf8",
      );
      expect(forkEvents).toContain('"type":"agent_tree"');
      expect(forkEvents).not.toContain('"type":"agent_run_accepted"');
      expect(requests).toHaveLength(4);
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a foreground child is running when the real saved-session process dies,
    When another exclusive owner resumes the session and inspects its agents,
    Then the abandoned run becomes one interrupted terminal with an incomplete transcript`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-agent-crash-"));
    const keelHome = join(workspace, ".keel-home");
    const sessionId = "interrupted-agent-history";
    let requestCount = 0;
    const childStarted = Promise.withResolvers<string>();
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        requestCount++;
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        if (requestCount === 1) {
          response.end(
            [
              sseToolCall("delegate_crash", "delegate", {
                task: "Inspect the workspace until the owner exits.",
              }),
              sseToolFinish(),
              "data: [DONE]\n\n",
            ].join(""),
          );
          return;
        }
        if (requestCount === 2) {
          childStarted.resolve(body);
          response.write(
            `data: ${JSON.stringify({
              choices: [{ delta: { content: "partial child work" } }],
            })}\n\n`,
          );
          return;
        }
        response.end(sseTextReplyWithUsage("Recovered the parent Task."));
      });
    });
    await listen(server);
    const { child, result } = runCliProcess(
      [
        "--session",
        sessionId,
        "--agent-policy",
        "explicit",
        "--max-cost",
        "0.05",
        "--no-skills",
      ],
      {
        cwd: workspace,
        stdin: "pipe",
        env: {
          KEEL_HOME: keelHome,
          KEEL_FORCE_INTERACTIVE: "1",
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        },
      },
    );

    try {
      child.stdin?.end("Use a subagent to investigate this workspace.\n");
      const childRequest = await withTimeout(
        childStarted.promise,
        5_000,
        "child did not start",
      );
      expect(childRequest).toContain("Delegation ID:");

      // When
      child.kill("SIGKILL");
      const killed = await withTimeout(result, 5_000, "CLI did not exit");
      expect(killed.signal).toBe("SIGKILL");
      const resumedInput = new PassThrough();
      resumedInput.end("/agents show 1\n/agents transcript 1\n");
      const resumed = createRuntime(
        ["--resume", sessionId, "--provider", "fake", "--no-skills"],
        {
          cwd: workspace,
          input: resumedInput,
          env: {
            KEEL_HOME: keelHome,
            KEEL_FORCE_INTERACTIVE: "1",
            DEEPSEEK_API_KEY: "test-key",
            DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
          },
        },
      );
      const exitCode = await runCliMain(resumed.runtime);

      // Then
      expect(
        exitCode,
        [killed.stdout, killed.stderr, resumed.stderr()].join("\n"),
      ).toBe(0);
      expect(resumed.stdout()).toContain("status: interrupted");
      expect(resumed.stdout()).toContain(
        "error: Child was interrupted when its foreground session owner exited.",
      );
      expect(resumed.stdout()).toContain(
        '"type":"transcript_terminal","status":"interrupted","pendingInputCount":0,"complete":false',
      );
      const events = await readFile(
        join(keelHome, "sessions", sessionId, "agents", "events.jsonl"),
        "utf8",
      );
      expect(events.match(/"type":"agent_result"/gu)).toHaveLength(1);
      expect(events.match(/"type":"agent_run_terminal"/gu)).toHaveLength(1);
      expect(requestCount).toBe(3);
    } finally {
      child.kill("SIGKILL");
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
