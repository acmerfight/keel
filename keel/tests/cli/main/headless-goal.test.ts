import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runCliMain } from "../../../src/cli/index.ts";
import {
  SESSION_GOAL_COMPLETION_CRITERION_MAX_LENGTH,
  SESSION_GOAL_OBJECTIVE_MAX_LENGTH,
} from "../../../src/core/session-goal.ts";
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
import {
  sessionGoalRecordLine,
  writeSessionLedger,
} from "../../../src/testing/session-ledger-fixtures.ts";

describe("CLI Main - Headless Goal", () => {
  test(`Given an assertion-backed objective,
    When the acting model proposes completion and a fresh evaluator approves it,
    Then headless execution completes without Bash authorization and reports evaluator evidence`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-headless-assertion-"));
    const home = await mkdtemp(join(tmpdir(), "keel-headless-assertion-home-"));
    const reportPath = join(workspace, "assertion-report.json");
    let providerCalls = 0;
    const server = createServer((_req, res) => {
      providerCalls++;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      if (providerCalls === 1) {
        res.write(
          sseToolCall("complete_assertion_goal", "update_goal", {
            status: "completed",
          }),
        );
        res.write(sseToolFinish());
        res.end("data: [DONE]\n\n");
        return;
      }
      if (providerCalls === 2) {
        res.end(
          sseTextReplyWithUsage(
            JSON.stringify({
              completed: true,
              reason: "Fresh evaluator approved the quality bar.",
            }),
          ),
        );
        return;
      }
      res.end(sseTextReplyWithUsage("Assertion goal completed."));
    });
    await listen(server);
    const fixture = createRuntime(
      [
        "goal",
        "--objective",
        "Polish the release narrative",
        "--done-when",
        "the release notes are clear, complete, and internally consistent",
        "--session",
        "headless-assertion",
        "--provider",
        "deepseek",
        "--report",
        reportPath,
      ],
      {
        cwd: workspace,
        env: {
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
          KEEL_HOME: home,
        },
      },
    );

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(providerCalls).toBe(3);
      expect(fixture.stdout()).toContain(
        "Headless goal session: headless-assertion\n",
      );
      expect(fixture.stdout()).toContain(
        "Headless goal outcome: completed; session: headless-assertion\n",
      );
      const ledger = await readFile(
        join(home, "sessions", "headless-assertion", "ledger.jsonl"),
        "utf8",
      );
      expect(ledger).toContain('"criterionKind":"assertion"');
      expect(ledger).toContain(
        '"completionCriterion":"the release notes are clear, complete, and internally consistent"',
      );
      expect(ledger).toContain('"kind":"assertion_evaluator"');
      expect(JSON.parse(await readFile(reportPath, "utf8"))).toMatchObject({
        stopReason: "completed",
        goalOutcome: {
          sessionId: "headless-assertion",
          status: "completed",
          evidenceKind: "assertion_evaluator",
        },
      });
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given an assertion evaluator rejects the acting model's completion claim,
    When the durable turn budget is exhausted,
    Then the Goal remains uncompleted and exits with the stable limited outcome`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-headless-assertion-rejected-"),
    );
    const home = await mkdtemp(
      join(tmpdir(), "keel-headless-assertion-rejected-home-"),
    );
    let providerCalls = 0;
    const server = createServer((_req, res) => {
      providerCalls++;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      if (providerCalls === 1) {
        res.write(
          sseToolCall("reject_assertion_goal", "update_goal", {
            status: "completed",
          }),
        );
        res.write(sseToolFinish());
        res.end("data: [DONE]\n\n");
        return;
      }
      res.end(
        sseTextReplyWithUsage(
          JSON.stringify({
            completed: false,
            reason: "The quality bar is not yet demonstrated.",
          }),
        ),
      );
    });
    await listen(server);
    const fixture = createRuntime(
      [
        "goal",
        "--objective",
        "Demonstrate a strict quality bar",
        "--done-when",
        "the result is demonstrably production quality",
        "--turns",
        "1",
        "--session",
        "headless-assertion-rejected",
        "--provider",
        "deepseek",
      ],
      {
        cwd: workspace,
        env: {
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
          KEEL_HOME: home,
        },
      },
    );

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(4);
      expect(providerCalls).toBe(3);
      expect(fixture.stdout()).toContain(
        "Headless goal outcome: budget_limited; session: headless-assertion-rejected\n",
      );
      const ledger = await readFile(
        join(home, "sessions", "headless-assertion-rejected", "ledger.jsonl"),
        "utf8",
      );
      expect(ledger).toContain('"status":"budget_limited"');
      const goalRecords = ledger
        .split("\n")
        .filter((line) => line.includes('"type":"session_goal"'))
        .join("\n");
      expect(goalRecords).not.toContain('"status":"completed"');
      expect(goalRecords).not.toContain('"kind":"assertion_evaluator"');
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a headless assertion exceeds the durable criterion boundary,
    When launch validation fails,
    Then Keel creates no named session and spends no provider tokens`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-headless-assertion-invalid-"),
    );
    const home = await mkdtemp(
      join(tmpdir(), "keel-headless-assertion-invalid-home-"),
    );
    const fixture = createRuntime(
      [
        "goal",
        "--objective",
        "Reject an oversized assertion",
        "--done-when",
        "a".repeat(SESSION_GOAL_COMPLETION_CRITERION_MAX_LENGTH + 1),
        "--session",
        "invalid-assertion",
        "--provider",
        "deepseek",
      ],
      {
        cwd: workspace,
        env: {
          DEEPSEEK_API_KEY: "test-key",
          KEEL_HOME: home,
        },
      },
    );

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(fixture.stdout()).toBe("");
      expect(fixture.stderr()).toContain(
        `completion criterion must be ${SESSION_GOAL_COMPLETION_CRITERION_MAX_LENGTH} characters or fewer`,
      );
      await expect(
        readFile(
          join(home, "sessions", "invalid-assertion", "ledger.jsonl"),
          "utf8",
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a command-backed objective,
    When the user launches it without an interactive terminal,
    Then Keel runs to verified completion with stable process and report outcomes`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-headless-goal-"));
    const home = await mkdtemp(join(tmpdir(), "keel-headless-goal-home-"));
    const reportPath = join(workspace, "goal-report.json");
    const skillDirectory = join(workspace, ".agents", "skills", "headless");
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(
      join(skillDirectory, "SKILL.md"),
      "---\nname: headless\ndescription: Headless Goal guidance\n---\n\nComplete the verified Goal.\n",
    );
    let providerCalls = 0;
    let readStdout = () => "";
    let stdoutAtFirstProviderRequest = "";
    let ledgerAtFirstProviderRequest = "";
    const server = createServer(async (_req, res) => {
      providerCalls++;
      if (providerCalls === 1) {
        stdoutAtFirstProviderRequest = readStdout();
        ledgerAtFirstProviderRequest = await readFile(
          join(home, "sessions", "headless-checkout", "ledger.jsonl"),
          "utf8",
        );
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      if (providerCalls === 1) {
        res.write(
          sseToolCall("complete_goal", "update_goal", {
            status: "completed",
          }),
        );
        res.write(sseToolFinish());
        res.end("data: [DONE]\n\n");
        return;
      }
      res.end(sseTextReplyWithUsage("Headless goal completed."));
    });
    await listen(server);
    const fixture = createRuntime(
      [
        "goal",
        "--objective",
        "Ship headless checkout",
        "--verify",
        'node -e "process.exit(0)"',
        "--timeout",
        "2s",
        "--turns",
        "3",
        "--tokens",
        "10000",
        "--time",
        "1m",
        "--session",
        "headless-checkout",
        "--bash-policy",
        "trusted",
        "--provider",
        "deepseek",
        "--model",
        "deepseek-v4-flash",
        "--skill",
        "headless",
        "--report",
        reportPath,
      ],
      {
        cwd: workspace,
        env: {
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
          KEEL_HOME: home,
        },
      },
    );
    readStdout = fixture.stdout;

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(providerCalls).toBe(2);
      expect(stdoutAtFirstProviderRequest).toContain(
        "Headless goal session: headless-checkout\n",
      );
      expect(ledgerAtFirstProviderRequest).toContain('"status":"active"');
      expect(fixture.stdout()).toContain(
        "Headless goal outcome: completed; session: headless-checkout\n",
      );
      expect(fixture.stderr()).not.toContain("Keel interactive session");
      const ledger = await readFile(
        join(home, "sessions", "headless-checkout", "ledger.jsonl"),
        "utf8",
      );
      expect(ledger).toContain('"status":"completed"');
      expect(ledger).toContain('"freshness":"at_completion"');
      expect(JSON.parse(await readFile(reportPath, "utf8"))).toMatchObject({
        stopReason: "completed",
        goalOutcome: {
          sessionId: "headless-checkout",
          status: "completed",
          evidenceKind: "command",
        },
      });
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a headless Goal objective is invalid at the durable boundary,
    When the user corrects it and retries the same named session,
    Then the failed launch leaves no session and the retry starts normally`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-headless-invalid-goal-"),
    );
    const home = await mkdtemp(
      join(tmpdir(), "keel-headless-invalid-goal-home-"),
    );
    const invalid = createRuntime(
      [
        "goal",
        "--objective",
        "o".repeat(SESSION_GOAL_OBJECTIVE_MAX_LENGTH + 1),
        "--verify",
        "false",
        "--session",
        "atomic-retry",
        "--bash-policy",
        "trusted",
        "--provider",
        "fake",
      ],
      { cwd: workspace, env: { KEEL_HOME: home } },
    );

    try {
      // When
      const invalidExitCode = await runCliMain(invalid.runtime);
      const retry = createRuntime(
        [
          "goal",
          "--objective",
          "Retry a valid Goal",
          "--verify",
          "false",
          "--turns",
          "1",
          "--session",
          "atomic-retry",
          "--bash-policy",
          "trusted",
          "--provider",
          "fake",
        ],
        { cwd: workspace, env: { KEEL_HOME: home } },
      );
      const retryExitCode = await runCliMain(retry.runtime);

      // Then
      expect(invalidExitCode).toBe(1);
      expect(invalid.stdout()).toBe("");
      expect(invalid.stderr()).toContain(
        `objective must be ${SESSION_GOAL_OBJECTIVE_MAX_LENGTH} characters or fewer`,
      );
      expect(retryExitCode).toBe(4);
      expect(retry.stdout()).toContain("Headless goal session: atomic-retry\n");
      await expect(
        readFile(
          join(home, "sessions", "atomic-retry", "ledger.jsonl"),
          "utf8",
        ),
      ).resolves.toContain('"status":"budget_limited"');
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given an unnamed headless Goal verifier exceeds the durable limit,
    When launch validation fails,
    Then no invisible generated session appears in the workspace catalog`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-headless-invalid-auto-"),
    );
    const home = await mkdtemp(
      join(tmpdir(), "keel-headless-invalid-auto-home-"),
    );
    const invalid = createRuntime(
      [
        "goal",
        "--objective",
        "Reject an invalid verifier",
        "--verify",
        "v".repeat(SESSION_GOAL_COMPLETION_CRITERION_MAX_LENGTH + 1),
        "--bash-policy",
        "trusted",
        "--provider",
        "fake",
      ],
      { cwd: workspace, env: { KEEL_HOME: home } },
    );

    try {
      // When
      const invalidExitCode = await runCliMain(invalid.runtime);
      const catalog = createRuntime(["sessions"], {
        cwd: workspace,
        env: { KEEL_HOME: home },
      });
      const catalogExitCode = await runCliMain(catalog.runtime);

      // Then
      expect(invalidExitCode).toBe(1);
      expect(invalid.stdout()).toBe("");
      expect(invalid.stderr()).toContain(
        `completion criterion must be ${SESSION_GOAL_COMPLETION_CRITERION_MAX_LENGTH} characters or fewer`,
      );
      expect(catalogExitCode).toBe(0);
      expect(catalog.stdout()).toContain("No sessions for workspace ");
      expect(catalog.stderr()).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given project startup fails before a headless Goal can be persisted,
    When Keel rejects the project instructions,
    Then it does not print a session that cannot be resumed`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-headless-startup-"));
    const home = await mkdtemp(join(tmpdir(), "keel-headless-startup-home-"));
    await writeFile(join(workspace, "AGENTS.md"), Buffer.from([0xc3, 0x28]));
    const fixture = createRuntime(
      [
        "goal",
        "--objective",
        "Never start with invalid instructions",
        "--verify",
        "true",
        "--session",
        "headless-not-created",
        "--bash-policy",
        "trusted",
        "--provider",
        "fake",
      ],
      { cwd: workspace, env: { KEEL_HOME: home } },
    );

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(fixture.stdout()).not.toContain("Headless goal session:");
      expect(fixture.stderr()).toContain("binary or not valid UTF-8");
      await expect(
        readFile(
          join(home, "sessions", "headless-not-created", "ledger.jsonl"),
          "utf8",
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a headless Goal reaches its configured turn budget,
    When the objective remains incomplete,
    Then Keel returns the stable limited outcome and a resume command`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-headless-limited-"));
    const home = await mkdtemp(join(tmpdir(), "keel-headless-limited-home-"));
    const reportPath = join(workspace, "limited-report.json");
    const fixture = createRuntime(
      [
        "goal",
        "--objective",
        "Reach an unavailable result",
        "--verify",
        "false",
        "--turns",
        "1",
        "--session",
        "headless-limited",
        "--bash-policy",
        "trusted",
        "--report",
        reportPath,
      ],
      {
        cwd: workspace,
        env: { KEEL_HOME: home, KEEL_PROVIDER: "fake" },
      },
    );

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(4);
      expect(fixture.stdout()).toContain(
        "Headless goal outcome: budget_limited; session: headless-limited\n",
      );
      expect(fixture.stdout()).toContain(
        "Resume with: keel goal resume headless-limited\n",
      );
      expect(JSON.parse(await readFile(reportPath, "utf8"))).toMatchObject({
        stopReason: "goal_budget",
        goalOutcome: {
          sessionId: "headless-limited",
          status: "budget_limited",
          reason: "Session goal budget reached: turns 1/1.",
        },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a headless Goal budget cannot cover its first provider request,
    When Keel evaluates the request before sending it,
    Then no provider spend occurs and the report preserves the stable limited outcome`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-headless-cost-"));
    const home = await mkdtemp(join(tmpdir(), "keel-headless-cost-home-"));
    const reportPath = join(workspace, "cost-report.json");
    let providerCalls = 0;
    const server = createServer((_req, res) => {
      providerCalls++;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.end(sseTextReplyWithUsage("Cost budget reached."));
    });
    await listen(server);
    const fixture = createRuntime(
      [
        "goal",
        "--objective",
        "Stop at the configured cost budget",
        "--verify",
        "true",
        "--session",
        "headless-cost",
        "--bash-policy",
        "trusted",
        "--provider",
        "deepseek",
        "--max-cost",
        "0.000001",
        "--report",
        reportPath,
      ],
      {
        cwd: workspace,
        env: {
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
          KEEL_HOME: home,
        },
      },
    );

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(4);
      expect(providerCalls).toBe(0);
      expect(fixture.stdout()).toContain(
        "Headless goal outcome: budget_limited; session: headless-cost\n",
      );
      expect(JSON.parse(await readFile(reportPath, "utf8"))).toMatchObject({
        stopReason: "cost_budget",
        costBudgetUsd: 0.000001,
        costUsd: 0,
        costOvershootUsd: 0,
        goalOutcome: {
          sessionId: "headless-cost",
          status: "budget_limited",
          reason:
            "Session cost budget could not admit another provider request before the active goal completed.",
        },
      });
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test.each([
    ["by id", ["headless-resume"]],
    ["by latest", ["--last"]],
  ])(`Given a saved headless Goal stopped at an invocation cost boundary,
    When a later non-interactive invocation resumes it %s with enough cost budget,
    Then Keel preserves the durable contract and drives the same Goal to verified completion`, async (_selector, resumeTarget) => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-headless-resume-"));
    const home = await mkdtemp(join(tmpdir(), "keel-headless-resume-home-"));
    const reportPath = join(workspace, "resume-report.json");
    let providerCalls = 0;
    const server = createServer((_req, res) => {
      providerCalls++;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      if (providerCalls % 2 === 1) {
        res.write(
          sseToolCall("complete_resumed_goal", "update_goal", {
            status: "completed",
          }),
        );
        res.write(sseToolFinish());
        res.end("data: [DONE]\n\n");
        return;
      }
      res.end(sseTextReplyWithUsage("Resumed goal completed."));
    });
    await listen(server);
    const runtimeOptions = {
      cwd: workspace,
      env: {
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        KEEL_HOME: home,
      },
    } as const;
    const launch = createRuntime(
      [
        "goal",
        "--objective",
        "Resume the same durable Goal",
        "--verify",
        "true",
        "--timeout",
        "2s",
        "--turns",
        "3",
        "--tokens",
        "10000",
        "--time",
        "1m",
        "--session",
        "headless-resume",
        "--bash-policy",
        "trusted",
        "--provider",
        "deepseek",
        "--max-cost",
        "0.000001",
      ],
      runtimeOptions,
    );

    try {
      expect(await runCliMain(launch.runtime)).toBe(4);
      expect(providerCalls).toBe(0);
      expect(launch.stdout()).toContain(
        "Resume with: keel goal resume headless-resume\n",
      );
      if (_selector === "by latest") {
        const newerCompletedSession = createRuntime(
          [
            "goal",
            "--objective",
            "Complete a newer Goal that must not hide the resumable one",
            "--verify",
            "true",
            "--session",
            "headless-newer-completed",
            "--bash-policy",
            "trusted",
            "--provider",
            "deepseek",
            "--max-cost",
            "1",
          ],
          runtimeOptions,
        );
        expect(await runCliMain(newerCompletedSession.runtime)).toBe(0);
        const completedResume = createRuntime(
          [
            "goal",
            "resume",
            "headless-newer-completed",
            "--bash-policy",
            "trusted",
            "--provider",
            "deepseek",
          ],
          runtimeOptions,
        );
        expect(await runCliMain(completedResume.runtime)).toBe(1);
        expect(completedResume.stderr()).toContain(
          "Error: only paused, blocked, or limited session goals can be resumed.\n",
        );
        expect(providerCalls).toBe(2);
      }

      // When
      const resume = createRuntime(
        [
          "goal",
          "resume",
          ...resumeTarget,
          "--bash-policy",
          "trusted",
          "--provider",
          "deepseek",
          "--max-cost",
          "1",
          "--report",
          reportPath,
        ],
        runtimeOptions,
      );
      const exitCode = await runCliMain(resume.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(providerCalls).toBe(_selector === "by latest" ? 4 : 2);
      expect(resume.stdout()).toContain(
        "Headless goal session: headless-resume\n",
      );
      expect(resume.stdout()).toContain(
        "Headless goal outcome: completed; session: headless-resume\n",
      );
      const ledger = await readFile(
        join(home, "sessions", "headless-resume", "ledger.jsonl"),
        "utf8",
      );
      const latestGoalRecord = ledger
        .trim()
        .split("\n")
        .filter((line) => line.includes('"type":"session_goal"'))
        .at(-1);
      expect(latestGoalRecord).toContain(
        '"objective":"Resume the same durable Goal"',
      );
      expect(latestGoalRecord).toContain('"criterionKind":"command"');
      expect(latestGoalRecord).toContain('"completionCriterion":"true"');
      expect(latestGoalRecord).toContain('"verificationTimeoutMs":2000');
      expect(latestGoalRecord).toContain(
        '"budget":{"turns":3,"tokens":10000,"activeTimeMs":60000}',
      );
      expect(latestGoalRecord).toContain('"status":"completed"');
      expect(latestGoalRecord).not.toContain(
        '"usage":{"turns":0,"tokens":0,"activeTimeMs":0}',
      );
      expect(JSON.parse(await readFile(reportPath, "utf8"))).toMatchObject({
        stopReason: "completed",
        goalOutcome: {
          sessionId: "headless-resume",
          status: "completed",
          evidenceKind: "command",
        },
      });
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a saved command Goal requires shell authorization,
    When a headless resume has neither trusted Bash nor a matching saved approval,
    Then Keel fails closed before provider spend or durable session mutation`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-headless-resume-denied-"),
    );
    const home = await mkdtemp(
      join(tmpdir(), "keel-headless-resume-denied-home-"),
    );
    let providerCalls = 0;
    const server = createServer((_req, res) => {
      providerCalls++;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(sseTextReplyWithUsage("This request must not be sent."));
    });
    await listen(server);
    const runtimeOptions = {
      cwd: workspace,
      env: {
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        KEEL_HOME: home,
      },
    } as const;
    const launch = createRuntime(
      [
        "goal",
        "--objective",
        "Keep the command verifier authorized",
        "--verify",
        "true",
        "--session",
        "resume-denied",
        "--bash-policy",
        "trusted",
        "--provider",
        "deepseek",
        "--max-cost",
        "0.000001",
      ],
      runtimeOptions,
    );

    try {
      expect(await runCliMain(launch.runtime)).toBe(4);
      expect(providerCalls).toBe(0);
      const ledgerPath = join(
        home,
        "sessions",
        "resume-denied",
        "ledger.jsonl",
      );
      const ledgerBeforeResume = await readFile(ledgerPath, "utf8");
      const resume = createRuntime(
        ["goal", "resume", "resume-denied", "--provider", "deepseek"],
        runtimeOptions,
      );

      // When
      const exitCode = await runCliMain(resume.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(providerCalls).toBe(0);
      expect(resume.stdout()).toBe("");
      expect(resume.stderr()).toBe(
        "Error: headless command Goals require --bash-policy trusted or a matching saved project approval with --bash-policy ask.\n",
      );
      expect(await readFile(ledgerPath, "utf8")).toBe(ledgerBeforeResume);
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test.each([
    ["disabled Bash", []],
    ["saved-approval-only Bash", ["--bash-policy", "ask"]],
  ])(`Given an assertion Goal was configured interactively with %s,
    When automation resumes it without a command verifier,
    Then headless execution preserves the external assertion hard gate`, async (_label, bashArgs) => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-headless-resume-assertion-"),
    );
    const home = await mkdtemp(
      join(tmpdir(), "keel-headless-resume-assertion-home-"),
    );
    const reportPath = join(workspace, "assertion-resume-report.json");
    const attemptsUnapprovedBash = _label === "saved-approval-only Bash";
    await writeSessionLedger({
      home,
      id: "resume-assertion",
      workspace: await realpath(workspace),
      createdAt: "2026-07-11T00:00:00.000Z",
      records: [
        sessionGoalRecordLine({
          timestamp: "2026-07-11T00:00:01.000Z",
          goal: {
            objective: "Preserve assertion completion on resume",
            status: attemptsUnapprovedBash ? "paused" : "active",
            budget: {},
            usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
            criterionKind: "assertion",
            completionCriterion: "the saved assertion remains externally gated",
          },
        }),
      ],
    });
    let providerCalls = 0;
    const server = createServer((_req, res) => {
      providerCalls++;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      if (attemptsUnapprovedBash && providerCalls === 1) {
        res.write(
          sseToolCall("unapproved_assertion_bash", "bash", {
            command: "true",
          }),
        );
        res.write(sseToolFinish());
        res.end("data: [DONE]\n\n");
        return;
      }
      const completionRequest = attemptsUnapprovedBash ? 2 : 1;
      if (providerCalls === completionRequest) {
        res.write(
          sseToolCall("complete_resumed_assertion", "update_goal", {
            status: "completed",
          }),
        );
        res.write(sseToolFinish());
        res.end("data: [DONE]\n\n");
        return;
      }
      if (providerCalls === completionRequest + 1) {
        res.end(
          sseTextReplyWithUsage(
            JSON.stringify({
              completed: true,
              reason: "Fresh evaluator approved the saved assertion.",
            }),
          ),
        );
        return;
      }
      res.end(sseTextReplyWithUsage("Assertion Goal completed."));
    });
    await listen(server);
    const fixture = createRuntime(
      [
        "goal",
        "resume",
        ...(attemptsUnapprovedBash ? ["resume-assertion"] : ["--last"]),
        ...bashArgs,
        "--provider",
        "deepseek",
        "--report",
        reportPath,
      ],
      {
        cwd: workspace,
        env: {
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
          KEEL_HOME: home,
        },
      },
    );

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(providerCalls).toBe(attemptsUnapprovedBash ? 4 : 3);
      expect(fixture.stdout()).toContain(
        "Headless goal outcome: completed; session: resume-assertion\n",
      );
      expect(JSON.parse(await readFile(reportPath, "utf8"))).toMatchObject({
        stopReason: "completed",
        goalOutcome: {
          sessionId: "resume-assertion",
          status: "completed",
          evidenceKind: "assertion_evaluator",
        },
      });
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a saved headless Goal exhausted its durable turn budget,
    When automation resumes it with a larger absolute Goal budget,
    Then the budget update and resume happen under the same lock before work continues`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-headless-resume-budget-"),
    );
    const home = await mkdtemp(
      join(tmpdir(), "keel-headless-resume-budget-home-"),
    );
    const resumeReportPath = join(workspace, "resume-budget-report.json");
    let providerCalls = 0;
    const server = createServer((_req, res) => {
      providerCalls++;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      if (providerCalls === 1) {
        res.end(sseTextReplyWithUsage("Still working."));
        return;
      }
      if (providerCalls === 2) {
        res.write(
          sseToolCall("complete_budget_resumed_goal", "update_goal", {
            status: "completed",
          }),
        );
        res.write(sseToolFinish());
        res.end("data: [DONE]\n\n");
        return;
      }
      res.end(sseTextReplyWithUsage("Budget-resumed goal completed."));
    });
    await listen(server);
    const runtimeOptions = {
      cwd: workspace,
      env: {
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        KEEL_HOME: home,
      },
    } as const;
    const launch = createRuntime(
      [
        "goal",
        "--objective",
        "Continue after a durable turn limit",
        "--verify",
        "true",
        "--turns",
        "1",
        "--tokens",
        "10000",
        "--time",
        "1m",
        "--session",
        "resume-turn-budget",
        "--bash-policy",
        "trusted",
        "--provider",
        "deepseek",
      ],
      runtimeOptions,
    );

    try {
      expect(await runCliMain(launch.runtime)).toBe(4);
      expect(providerCalls).toBe(1);
      expect(launch.stdout()).toContain(
        "Headless goal outcome: budget_limited; session: resume-turn-budget\n",
      );
      const resume = createRuntime(
        [
          "goal",
          "resume",
          "resume-turn-budget",
          "--turns",
          "3",
          "--bash-policy",
          "trusted",
          "--provider",
          "deepseek",
          "--report",
          resumeReportPath,
        ],
        runtimeOptions,
      );

      // When
      const exitCode = await runCliMain(resume.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(providerCalls).toBe(3);
      expect(resume.stdout()).toContain(
        "Headless goal outcome: completed; session: resume-turn-budget\n",
      );
      const ledger = await readFile(
        join(home, "sessions", "resume-turn-budget", "ledger.jsonl"),
        "utf8",
      );
      const latestGoalRecord = ledger
        .trim()
        .split("\n")
        .filter((line) => line.includes('"type":"session_goal"'))
        .at(-1);
      expect(latestGoalRecord).toContain(
        '"budget":{"turns":3,"tokens":10000,"activeTimeMs":60000}',
      );
      expect(latestGoalRecord).toContain('"status":"completed"');
      expect(
        JSON.parse(await readFile(resumeReportPath, "utf8")),
      ).toMatchObject({
        stopReason: "completed",
        goalOutcome: {
          sessionId: "resume-turn-budget",
          status: "completed",
          evidenceKind: "command",
        },
      });
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given the latest saved Goal has a valid resume contract but exhausted its durable budget,
    When automation resumes the latest Goal without a budget override,
    Then Keel reports the actionable budget rejection without provider work`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-headless-resume-last-budget-"),
    );
    const home = await mkdtemp(
      join(tmpdir(), "keel-headless-resume-last-budget-home-"),
    );
    await writeSessionLedger({
      home,
      id: "latest-budget-limited",
      workspace: await realpath(workspace),
      createdAt: "2026-07-11T00:00:00.000Z",
      records: [
        sessionGoalRecordLine({
          timestamp: "2026-07-11T00:00:01.000Z",
          goal: {
            objective: "Continue after raising the durable turn budget",
            status: "budget_limited",
            statusReason: "Session goal budget reached: turns 1/1.",
            budget: { turns: 1 },
            usage: { turns: 1, tokens: 10, activeTimeMs: 100 },
            criterionKind: "command",
            completionCriterion: "true",
          },
        }),
      ],
    });
    const ledgerPath = join(
      home,
      "sessions",
      "latest-budget-limited",
      "ledger.jsonl",
    );
    const ledgerBeforeResume = await readFile(ledgerPath, "utf8");
    const fixture = createRuntime(
      [
        "goal",
        "resume",
        "--last",
        "--bash-policy",
        "trusted",
        "--provider",
        "fake",
      ],
      {
        cwd: workspace,
        env: { KEEL_HOME: home },
      },
    );

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(fixture.stdout()).toBe("");
      expect(fixture.stderr()).toBe(
        "Error: Session goal budget reached: turns 1/1. Raise or clear the goal budget before resuming.\n",
      );
      expect(await readFile(ledgerPath, "utf8")).toBe(ledgerBeforeResume);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a newer saved Goal is budget-rejected and an older saved Goal is ready to resume,
    When automation resumes the latest resumable Goal,
    Then Keel preserves ready-Goal selection instead of treating the newer budget rejection as selectable`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-headless-resume-last-ready-"),
    );
    const home = await mkdtemp(
      join(tmpdir(), "keel-headless-resume-last-ready-home-"),
    );
    const canonicalWorkspace = await realpath(workspace);
    await writeSessionLedger({
      home,
      id: "older-ready",
      workspace: canonicalWorkspace,
      createdAt: "2026-07-11T00:00:00.000Z",
      records: [
        sessionGoalRecordLine({
          timestamp: "2026-07-11T00:00:01.000Z",
          goal: {
            objective: "Resume the latest ready Goal",
            status: "paused",
            budget: {},
            usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
            criterionKind: "command",
            completionCriterion: "true",
          },
        }),
      ],
    });
    await writeSessionLedger({
      home,
      id: "newer-budget-limited",
      workspace: canonicalWorkspace,
      createdAt: "2026-07-11T00:00:02.000Z",
      records: [
        sessionGoalRecordLine({
          timestamp: "2026-07-11T00:00:03.000Z",
          goal: {
            objective: "Wait for a larger durable budget",
            status: "budget_limited",
            statusReason: "Session goal budget reached: turns 1/1.",
            budget: { turns: 1 },
            usage: { turns: 1, tokens: 10, activeTimeMs: 100 },
            criterionKind: "command",
            completionCriterion: "true",
          },
        }),
      ],
    });
    const fixture = createRuntime(
      ["goal", "resume", "--last", "--provider", "fake"],
      {
        cwd: workspace,
        env: { KEEL_HOME: home },
      },
    );

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(fixture.stdout()).toBe("");
      expect(fixture.stderr()).toBe(
        "Resuming latest session: older-ready\n" +
          "Error: headless command Goals require --bash-policy trusted or a matching saved project approval with --bash-policy ask.\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given the latest saved session has no Goal and no resumable Goal exists,
    When automation asks to resume the latest Goal,
    Then Keel fails before provider resolution with a Goal-specific error`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-headless-resume-last-empty-"),
    );
    const home = await mkdtemp(
      join(tmpdir(), "keel-headless-resume-last-empty-home-"),
    );
    await writeSessionLedger({
      home,
      id: "ordinary-session",
      workspace: await realpath(workspace),
      createdAt: "2026-07-11T00:00:00.000Z",
      records: [],
    });
    const fixture = createRuntime(
      ["goal", "resume", "--last", "--provider", "fake"],
      {
        cwd: workspace,
        env: { KEEL_HOME: home },
      },
    );

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(fixture.stdout()).toBe("");
      expect(fixture.stderr()).toBe(
        `Error: no resumable saved Goals for workspace ${await realpath(workspace)}.\n`,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given an admitted headless Goal request reports cost above its estimate,
    When Keel stops the active goal after the response,
    Then the report exposes the exact numeric overshoot`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-headless-overage-"));
    const home = await mkdtemp(join(tmpdir(), "keel-headless-overage-home-"));
    const reportPath = join(workspace, "overage-report.json");
    let providerCalls = 0;
    const server = createServer((_req, res) => {
      providerCalls++;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.end(
        sseTextReplyWithUsage("Cost budget reached.", {
          prompt_tokens: 1_000_000,
          completion_tokens: 0,
        }),
      );
    });
    await listen(server);
    const fixture = createRuntime(
      [
        "goal",
        "--objective",
        "Stop after an admitted request exceeds its estimate",
        "--verify",
        "true",
        "--session",
        "headless-overage",
        "--bash-policy",
        "trusted",
        "--provider",
        "deepseek",
        "--max-cost",
        "0.01",
        "--report",
        reportPath,
      ],
      {
        cwd: workspace,
        env: {
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
          KEEL_HOME: home,
        },
      },
    );

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(4);
      expect(providerCalls).toBe(1);
      expect(JSON.parse(await readFile(reportPath, "utf8"))).toMatchObject({
        schemaVersion: 7,
        stopReason: "cost_budget",
        costBudgetUsd: 0.01,
        costUsd: 0.14,
        costOvershootUsd: 0.13,
      });
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given the agent reports the same blocker across the required turns,
    When a headless Goal passes the blocker audit,
    Then Keel exits with the stable blocked outcome and preserves the session`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-headless-blocked-"));
    const home = await mkdtemp(join(tmpdir(), "keel-headless-blocked-home-"));
    const reportPath = join(workspace, "blocked-report.json");
    let providerCalls = 0;
    const server = createServer((_req, res) => {
      providerCalls++;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      if (providerCalls % 2 === 1) {
        res.write(
          sseToolCall(`blocked_${providerCalls}`, "update_goal", {
            status: "blocked",
            reason: "Production credentials are unavailable.",
          }),
        );
        res.write(sseToolFinish());
        res.end("data: [DONE]\n\n");
        return;
      }
      res.end(sseTextReplyWithUsage("Still blocked on credentials."));
    });
    await listen(server);
    const fixture = createRuntime(
      [
        "goal",
        "--objective",
        "Deploy the release",
        "--verify",
        "test -f deployed.txt",
        "--session",
        "headless-blocked",
        "--bash-policy",
        "trusted",
        "--provider",
        "deepseek",
        "--report",
        reportPath,
      ],
      {
        cwd: workspace,
        env: {
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
          KEEL_HOME: home,
        },
      },
    );

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(3);
      expect(providerCalls).toBe(6);
      expect(fixture.stdout()).toContain(
        "Headless goal outcome: blocked; session: headless-blocked\n",
      );
      expect(fixture.stdout()).toContain(
        "Resume with: keel goal resume headless-blocked\n",
      );
      expect(JSON.parse(await readFile(reportPath, "utf8"))).toMatchObject({
        stopReason: "goal_blocked",
        goalOutcome: {
          sessionId: "headless-blocked",
          status: "blocked",
          reason: "Production credentials are unavailable.",
        },
      });
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a headless verifier has no trusted or saved approval,
    When the user starts the Goal with ask policy,
    Then Keel fails closed before provider spend or session creation`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-headless-denied-"));
    const home = await mkdtemp(join(tmpdir(), "keel-headless-denied-home-"));
    let providerCalls = 0;
    const server = createServer((_req, res) => {
      providerCalls++;
      res.writeHead(500);
      res.end();
    });
    await listen(server);
    const fixture = createRuntime(
      [
        "goal",
        "--objective",
        "Run a protected verifier",
        "--verify",
        "pnpm test",
        "--session",
        "headless-denied",
        "--bash-policy",
        "ask",
        "--provider",
        "deepseek",
      ],
      {
        cwd: workspace,
        env: {
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
          KEEL_HOME: home,
        },
      },
    );

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(providerCalls).toBe(0);
      expect(fixture.stdout()).toBe("");
      expect(fixture.stderr()).toBe(
        "Error: Headless command approval is unavailable and no saved project approval matched.\n",
      );
      await expect(
        readFile(
          join(home, "sessions", "headless-denied", "ledger.jsonl"),
          "utf8",
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a project verification family was approved earlier,
    When an unnamed headless Goal uses ask policy,
    Then Keel runs without prompting and prints the generated resumable session id`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-headless-approved-"));
    const home = await mkdtemp(join(tmpdir(), "keel-headless-approved-home-"));
    await writeFile(
      join(workspace, "package.json"),
      JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }),
      "utf8",
    );
    await writeFile(
      join(home, "bash-project-approvals.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        grants: [
          {
            projectRoot: workspace,
            cwd: workspace,
            argvPrefix: ["pnpm", "test"],
          },
        ],
      })}\n`,
      "utf8",
    );
    let providerCalls = 0;
    const server = createServer((_req, res) => {
      providerCalls++;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      if (providerCalls === 1) {
        res.write(
          sseToolCall("unapproved_bash", "bash", {
            command: "git status",
          }),
        );
        res.write(sseToolFinish());
        res.end("data: [DONE]\n\n");
        return;
      }
      if (providerCalls === 2) {
        res.write(
          sseToolCall("complete_goal", "update_goal", {
            status: "completed",
          }),
        );
        res.write(sseToolFinish());
        res.end("data: [DONE]\n\n");
        return;
      }
      res.end(sseTextReplyWithUsage("Approved goal completed."));
    });
    await listen(server);
    const fixture = createRuntime(
      [
        "goal",
        "--objective",
        "Verify the project",
        "--verify",
        "pnpm test",
        "--bash-policy",
        "ask",
        "--provider",
        "deepseek",
      ],
      {
        cwd: workspace,
        env: {
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
          KEEL_HOME: home,
        },
      },
    );

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(providerCalls).toBe(3);
      expect(fixture.stderr()).not.toContain("Approve bash command?");
      const sessionId = /^Headless goal session: (session-[0-9a-f-]+)$/mu
        .exec(fixture.stdout())
        ?.at(1);
      expect(sessionId).toBeDefined();
      expect(fixture.stdout()).toContain(
        `Headless goal outcome: completed; session: ${sessionId}\n`,
      );
      await expect(
        readFile(
          join(home, "sessions", sessionId ?? "", "ledger.jsonl"),
          "utf8",
        ),
      ).resolves.toContain('"status":"completed"');
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a headless Goal is inside a provider turn,
    When the process receives SIGINT,
    Then Keel exits as interrupted and leaves the printed session resumable`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-headless-sigint-"));
    const home = await mkdtemp(join(tmpdir(), "keel-headless-sigint-home-"));
    let markRequestStarted: () => void = () => {};
    const requestStarted = new Promise<void>((resolve) => {
      markRequestStarted = resolve;
    });
    const server = createServer((req, res) => {
      markRequestStarted();
      req.once("close", () => res.end());
    });
    await listen(server);
    const sigint: SigintCapture = { handler: null };
    const fixture = createRuntime(
      [
        "goal",
        "--objective",
        "Keep the interrupted work resumable",
        "--verify",
        "test -f done.txt",
        "--session",
        "headless-interrupted",
        "--bash-policy",
        "trusted",
        "--provider",
        "deepseek",
      ],
      {
        cwd: workspace,
        env: {
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
          KEEL_HOME: home,
        },
        onSigint: (handler) => {
          sigint.handler = handler;
        },
        offSigint: (handler) => {
          if (sigint.handler === handler) sigint.handler = null;
        },
      },
    );

    try {
      // When
      const run = runCliMain(fixture.runtime);
      await requestStarted;
      const handler = sigint.handler;
      if (handler === null)
        throw new Error("SIGINT handler was not registered");
      handler();
      const exitCode = await run;

      // Then
      expect(exitCode).toBe(130);
      expect(fixture.stdout()).toContain(
        "Headless goal session: headless-interrupted\n",
      );
      expect(fixture.stdout()).not.toContain("Headless goal outcome:");
      expect(sigint.handler).toBeNull();
      await expect(
        readFile(
          join(home, "sessions", "headless-interrupted", "ledger.jsonl"),
          "utf8",
        ),
      ).resolves.toContain('"status":"active"');
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a headless Goal makes no progress and has no user budget,
    When it reaches the Runtime continuation cap,
    Then Keel returns the stable usage-limited outcome`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-headless-cap-"));
    const home = await mkdtemp(join(tmpdir(), "keel-headless-cap-home-"));
    const reportPath = join(workspace, "cap-report.json");
    const fixture = createRuntime(
      [
        "goal",
        "--objective",
        "Continue until the hard cap",
        "--verify",
        "false",
        "--session",
        "headless-cap",
        "--bash-policy",
        "trusted",
        "--provider",
        "fake",
        "--report",
        reportPath,
      ],
      {
        cwd: workspace,
        env: { KEEL_HOME: home, KEEL_PROVIDER: "fake" },
      },
    );

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(4);
      expect(fixture.stdout()).toContain(
        "Headless goal outcome: usage_limited; session: headless-cap\n",
      );
      expect(JSON.parse(await readFile(reportPath, "utf8"))).toMatchObject({
        turns: 100,
        stopReason: "goal_usage_limit",
        goalOutcome: {
          sessionId: "headless-cap",
          status: "usage_limited",
          reason:
            "Automatic goal continuation stopped after 100 continuation turns without completing the active goal.",
        },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given the saved project approval file is invalid,
    When a headless Goal requests ask policy,
    Then Keel reports the approval-store error before creating a session`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-headless-invalid-approval-"),
    );
    const home = await mkdtemp(
      join(tmpdir(), "keel-headless-invalid-approval-home-"),
    );
    const approvalPath = join(home, "bash-project-approvals.json");
    await writeFile(approvalPath, "{", "utf8");
    const fixture = createRuntime(
      [
        "goal",
        "--objective",
        "Verify the project",
        "--verify",
        "pnpm test",
        "--session",
        "invalid-approval",
        "--bash-policy",
        "ask",
        "--provider",
        "fake",
      ],
      { cwd: workspace, env: { KEEL_HOME: home } },
    );

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(fixture.stdout()).toBe("");
      expect(fixture.stderr()).toBe(
        `Error: cannot read bash project approvals ${approvalPath}: invalid JSON.\n`,
      );
      await expect(
        readFile(
          join(home, "sessions", "invalid-approval", "ledger.jsonl"),
          "utf8",
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
});
