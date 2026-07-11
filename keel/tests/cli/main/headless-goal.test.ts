import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

describe("CLI Main - Headless Goal", () => {
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
        "Resume with: keel --resume headless-limited\n",
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

  test(`Given a headless Goal reaches the session cost budget,
    When Keel writes its stable limited outcome,
    Then the report preserves cost as the stopping authority`, async () => {
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
      expect(providerCalls).toBe(1);
      expect(fixture.stdout()).toContain(
        "Headless goal outcome: budget_limited; session: headless-cost\n",
      );
      expect(JSON.parse(await readFile(reportPath, "utf8"))).toMatchObject({
        stopReason: "cost_budget",
        goalOutcome: {
          sessionId: "headless-cost",
          status: "budget_limited",
          reason:
            "Session cost budget was reached before the active goal completed.",
        },
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
        "Resume with: keel --resume headless-blocked\n",
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
