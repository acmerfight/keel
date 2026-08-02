import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { runCliMain } from "../../../src/cli/index.ts";
import { requestWithMessagesSchema } from "../../../src/testing/cli-main-schemas.ts";
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
  appendSessionRecordLine,
  endForkGraph,
  inputAdmittedRecordLine,
  sessionGoalRecordLine,
  taskProgressRecordLine,
  writeSessionLedger,
} from "../../../src/testing/session-ledger-fixtures.ts";

const DEEPSEEK_MISSING_API_KEY_GUIDANCE = [
  "Error: missing API key for deepseek.",
  "Set DEEPSEEK_API_KEY for this run, or store it:",
  "  printf '%s\\n' \"$DEEPSEEK_API_KEY\" | keel auth login deepseek --with-api-key",
  "  keel config set-provider deepseek",
  "  keel --doctor",
];

async function waitForCondition(
  condition: () => boolean,
  message: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) {
      return;
    }
    await delay(5);
  }
  throw new Error(message);
}

function oversizedReadFixture(options: {
  readonly start: string;
  readonly end: string;
  readonly fill: string;
}): string {
  return [
    options.start,
    options.fill.repeat(51_000),
    options.end,
    "tail beyond the read tool byte budget ".repeat(200),
  ].join("\n");
}

function sessionIdFromResumeLine(output: string): string {
  const match = /^\s+resume: keel --resume ([^\n]+)$/mu.exec(output);
  const sessionId = match?.at(1);
  if (sessionId === undefined) {
    throw new Error(`No session resume line found in output:\n${output}`);
  }
  return sessionId;
}

async function sessionDirectoryNames(home: string): Promise<readonly string[]> {
  try {
    return await readdir(join(home, "sessions"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function writeWorkflowSkill(options: {
  readonly workspace: string;
  readonly name: string;
  readonly description: string;
  readonly body: string;
}): Promise<void> {
  const skillDir = join(options.workspace, ".agents", "skills", options.name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    [
      "---",
      `name: ${options.name}`,
      `description: ${options.description}`,
      "---",
      "",
      options.body,
      "",
    ].join("\n"),
  );
}

function savedSessionIntroFromStderr(stderr: string): string {
  const match =
    /^Keel interactive session\nsession: ([^\n]+)\nContinue the task here; send follow-ups or corrections until it is done\.\nAfter a completed turn, resume with: keel --resume \1\nCommands: \/status \/tasks \/diff \/undo \/help\n/u.exec(
      stderr,
    );
  if (match === null) {
    throw new Error(`No saved session intro found in stderr:\n${stderr}`);
  }
  return match[0];
}

function expectDefaultSavedSessionIntro(stderr: string): string {
  const intro = savedSessionIntroFromStderr(stderr);
  const sessionId = intro.match(/^session: ([^\n]+)$/mu)?.at(1);
  expect(sessionId).toMatch(/^session-[0-9a-f-]+$/u);
  return intro;
}

function jsonlRecords(text: string): readonly unknown[] {
  const trimmed = text.trimEnd();
  if (trimmed === "") {
    return [];
  }
  return trimmed.split("\n").map((line) => JSON.parse(line));
}

const sessionGoalLedgerRecordSchema = z.object({
  type: z.literal("session_goal"),
  goal: z.unknown(),
});

function sessionGoalLedgerRecords(
  records: readonly unknown[],
): readonly z.infer<typeof sessionGoalLedgerRecordSchema>[] {
  return records.flatMap((record) => {
    const parsed = sessionGoalLedgerRecordSchema.safeParse(record);
    return parsed.success ? [parsed.data] : [];
  });
}

const EPHEMERAL_INTERACTIVE_INTRO = [
  "Keel interactive session (ephemeral)",
  "Not saved. Start without --ephemeral to resume later.",
  "Continue the task here; send follow-ups or corrections until it is done.",
  "Commands: /status /tasks /diff /undo /help",
  "",
].join("\n");

describe("CLI Main - Interactive Entrypoint", () => {
  test(`Given provider and model flags are used for an interactive session,
    When the CLI main runs in-process,
    Then the selected interactive provider overrides provider env`, async () => {
    // Given
    const input = new PassThrough();
    const fixture = createRuntime(["--provider=fake", "--model=ignored"], {
      env: { KEEL_PROVIDER: "deepseek", KEEL_FORCE_INTERACTIVE: "1" },
      input,
    });

    // When
    const run = runCliMain(fixture.runtime);
    input.write("hello\n");
    input.end();
    const exitCode = await run;

    // Then
    expect(exitCode).toBe(0);
    expect(fixture.stdout()).toBe("Remembered: hello\n");
    expect(fixture.stderr()).toBe("");
  });

  test(`Given provider and model flags are used before the first prompt,
    When the user asks for status,
    Then the snapshot reports the configured model without starting a provider turn`, async () => {
    // Given
    const input = new PassThrough();
    input.end("/status\n");
    const fixture = createRuntime(
      ["--provider=fake", "--model=configured-model", "--bash-policy=deny"],
      {
        env: { KEEL_PROVIDER: "deepseek", KEEL_FORCE_INTERACTIVE: "1" },
        input,
      },
    );

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(0);
    expect(fixture.stdout()).toContain(
      "  active model: fake/configured-model\n",
    );
    expect(fixture.stdout()).not.toContain("Remembered:");
    expect(fixture.stderr()).toBe("");
  });

  test(`Given a saved interactive session has no completed turn yet,
    When the user asks for status,
    Then the snapshot does not show an unusable resume command`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-cli-status-fresh-home-"));
    const input = new PassThrough();
    input.end("/status\n");
    const fixture = createRuntime([], {
      env: {
        KEEL_PROVIDER: "fake",
        KEEL_FORCE_INTERACTIVE: "1",
        KEEL_HOME: home,
      },
      input,
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toContain("status:\n");
      expect(fixture.stdout()).toContain(
        "  continue: send follow-ups or corrections here until the task is done\n",
      );
      expect(fixture.stdout()).not.toContain("resume: keel --resume");
      expect(fixture.stdout()).toContain("  undo-list: /undo --list\n");
      expect(fixture.stderr()).toBe("");
      expect(await sessionDirectoryNames(home)).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a saved session stopped with an active goal,
    When the user resumes the session and explicitly resumes the goal,
    Then Keel first parks the goal without provider spend and then continues it`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-goal-resume-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-cli-goal-home-"));
    await writeSessionLedger({
      home,
      id: "goal-entrypoint",
      workspace: ledgerWorkspace,
      createdAt: "2026-03-05T00:00:00.000Z",
      records: [
        appendSessionRecordLine("2026-03-05T00:00:01.000Z", [
          {
            role: "user",
            content: "resume the durable goal",
            origin: { type: "user_prompt" },
          },
        ]),
        sessionGoalRecordLine({
          timestamp: "2026-03-05T00:00:02.000Z",
          goal: {
            objective: "Resume durable goal state",
            status: "active",
            budget: { turns: 1 },
            usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
            completion: {
              kind: "assertion",
              assertion: "The durable goal is complete",
            },
            blockedAudit: {
              consecutiveCount: 1,
              reason: "The previous process was still checking a blocker.",
            },
            latestRuntimeOutcome: {
              kind: "progress_observed",
              reason: "The previous process changed the workspace.",
            },
          },
        }),
      ],
    });
    const input = new PassThrough();
    input.write("/status\n");
    input.end("/goal resume\n");
    const fixture = createRuntime(
      ["--resume", "goal-entrypoint", "--provider=fake", "--bash-policy=deny"],
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
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toContain(
        "Goal paused after session resume. Run /goal resume to continue.\n",
      );
      expect(fixture.stdout()).toContain(
        "  goal: paused - Resume durable goal state; criterion(assertion): The durable goal is complete; usage: 0 turns, 0 tokens, 0ms active; budget: 1 turn\n",
      );
      expect(fixture.stdout()).toContain(
        "  goal outcome: progress observed - The previous process changed the workspace.\n",
      );
      expect(fixture.stdout()).toContain(
        "Goal resumed: Resume durable goal state\n",
      );
      expect(fixture.stdout()).toContain('source="goal_resumption"');
      expect(fixture.stderr()).toContain(
        "Session goal budget reached: turns 1/1",
      );
      const resumedLedger = await readFile(
        join(home, "sessions", "goal-entrypoint", "ledger.jsonl"),
        "utf8",
      );
      expect(resumedLedger).toContain('"status":"paused"');
      expect(resumedLedger).toContain('"status":"budget_limited"');
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a restored active command goal has a custom verifier timeout,
    When session resume parks it before any provider turn,
    Then the pause and zero-turn report preserve the complete command contract`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-goal-timeout-restore-"),
    );
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(
      join(tmpdir(), "keel-cli-goal-timeout-restore-home-"),
    );
    const reportPath = join(workspace, "report.json");
    await writeSessionLedger({
      home,
      id: "goal-timeout-restore",
      workspace: ledgerWorkspace,
      createdAt: "2026-03-05T00:00:00.000Z",
      records: [
        sessionGoalRecordLine({
          timestamp: "2026-03-05T00:00:01.000Z",
          goal: {
            objective: "Preserve the restored verifier timeout",
            status: "active",
            budget: {},
            usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
            completion: {
              kind: "command",
              command: "pnpm test",
              verificationTimeoutMs: 350,
            },
          },
        }),
      ],
    });
    const input = new PassThrough();
    input.end("/goal\n");
    const fixture = createRuntime(
      [
        "--resume",
        "goal-timeout-restore",
        "--provider=fake",
        `--report=${reportPath}`,
      ],
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
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toContain(
        "Goal paused after session resume. Run /goal resume to continue.\n",
      );
      expect(fixture.stdout()).toContain(
        "Session goal: paused - Preserve the restored verifier timeout; criterion(command): pnpm test; verifier timeout: 350ms\n",
      );
      const ledger = await readFile(
        join(home, "sessions", "goal-timeout-restore", "ledger.jsonl"),
        "utf8",
      );
      expect(ledger).toContain('"status":"paused"');
      expect(ledger).toContain('"verificationTimeoutMs":350');
      expect(JSON.parse(await readFile(reportPath, "utf8"))).toMatchObject({
        agentLoopTurns: 0,
        stopReason: "completed",
        costUsd: 0,
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a saved interactive session receives a goal command first,
    When the user checks status,
    Then the CLI entrypoint persists, displays, and starts the goal`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-goal-command-"));
    const home = await mkdtemp(join(tmpdir(), "keel-cli-goal-command-home-"));
    const input = new PassThrough();
    input.write("/goal Track durable goal from entrypoint\n");
    input.write("/goal budget --turns 1\n");
    input.end("/status\n");
    const fixture = createRuntime(
      ["--session", "goal-command", "--provider=fake", "--bash-policy=deny"],
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
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toContain("Goal set: active\n");
      expect(fixture.stdout()).toContain(
        "  goal: active - Track durable goal from entrypoint; criterion(assertion): Track durable goal from entrypoint; usage: 0 turns, 0 tokens, 0ms active; budget: 1 turn\n",
      );
      expect(fixture.stdout()).toContain('source="goal_activation"');
      const ledger = await readFile(
        join(home, "sessions", "goal-command", "ledger.jsonl"),
        "utf8",
      );
      expect(ledger).toContain('"type":"session_goal"');
      expect(ledger).toContain("Track durable goal from entrypoint");
      expect(fixture.stderr()).toContain(
        "Session goal budget reached: turns 1/1",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a saved interactive session receives a goal verification command,
    When the user checks status and later resumes the session,
    Then the CLI entrypoint persists and displays the verification command`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-goal-verify-command-"),
    );
    const home = await mkdtemp(
      join(tmpdir(), "keel-cli-goal-verify-command-home-"),
    );
    const firstInput = new PassThrough();
    firstInput.write("/goal Track verified goal from entrypoint\n");
    firstInput.write("/goal verify --timeout 45s pnpm test\n");
    firstInput.write("/goal budget --turns 1\n");
    firstInput.end("/status\n");
    const firstRun = createRuntime(
      [
        "--session",
        "goal-verify-command",
        "--provider=fake",
        "--bash-policy=deny",
      ],
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
      const resumeInput = new PassThrough();
      resumeInput.end("/status\n");
      const resumeRun = createRuntime(
        ["--resume", "goal-verify-command", "--provider=fake"],
        {
          cwd: workspace,
          env: {
            KEEL_FORCE_INTERACTIVE: "1",
            KEEL_HOME: home,
            KEEL_PROVIDER: "fake",
          },
          input: resumeInput,
        },
      );

      // When
      const resumeExitCode = await runCliMain(resumeRun.runtime);

      // Then
      expect(firstExitCode).toBe(0);
      expect(firstRun.stdout()).toContain(
        "Goal verification command set: pnpm test\n",
      );
      expect(firstRun.stdout()).toContain("Goal verification timeout: 45s\n");
      expect(firstRun.stdout()).toContain(
        "  goal: active - Track verified goal from entrypoint; criterion(command): pnpm test; verifier timeout: 45s; usage: 0 turns, 0 tokens, 0ms active; budget: 1 turn\n",
      );
      const ledger = await readFile(
        join(home, "sessions", "goal-verify-command", "ledger.jsonl"),
        "utf8",
      );
      expect(ledger).toContain('"criterionKind":"command"');
      expect(ledger).toContain('"completionCriterion":"pnpm test"');
      expect(ledger).toContain('"verificationTimeoutMs":45000');
      expect(resumeExitCode).toBe(0);
      expect(resumeRun.stdout()).toContain(
        "  goal: budget_limited - Track verified goal from entrypoint; criterion(command): pnpm test; verifier timeout: 45s; reason: Session goal budget reached: turns 1/1",
      );
      expect(firstRun.stderr()).toContain(
        "Session goal budget reached: turns 1/1",
      );
      expect(resumeRun.stderr()).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given one goal command contains an objective, verifier, timeout, and budgets,
    When Keel accepts the command,
    Then it persists the complete contract atomically and immediately starts work`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-goal-atomic-launch-"),
    );
    const home = await mkdtemp(
      join(tmpdir(), "keel-cli-goal-atomic-launch-home-"),
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
        if (capturedBodies.length > 1) {
          res.end(sseTextReplyWithUsage("Atomic goal completed."));
          return;
        }
        res.write(
          sseToolCall("complete_goal", "update_goal", {
            status: "completed",
          }),
        );
        res.write(sseToolFinish());
        res.end("data: [DONE]\n\n");
      });
    });
    await listen(server);
    const input = new PassThrough();
    input.end(
      '/goal --objective "Ship atomic checkout" --verify "node -e \\"process.exit(0)\\"" --turns 3 --tokens 5000 --time 5s --timeout 2s\n',
    );
    const fixture = createRuntime(
      ["--session", "goal-atomic-launch", "--bash-policy=trusted"],
      {
        cwd: workspace,
        env: {
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
          KEEL_FORCE_INTERACTIVE: "1",
          KEEL_HOME: home,
        },
        input,
      },
    );

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toContain("Goal set: active\n");
      expect(fixture.stdout()).toContain(
        'Session goal: active - Ship atomic checkout; criterion(command): node -e "process.exit(0)"; verifier timeout: 2s; usage: 0 turns, 0 tokens, 0ms active; budget: 3 turns, 5000 tokens, 5s active\n',
      );
      expect(JSON.stringify(capturedBodies[0])).toContain(
        'source=\\"goal_activation\\"',
      );
      const goalRecords = (
        await readFile(
          join(home, "sessions", "goal-atomic-launch", "ledger.jsonl"),
          "utf8",
        )
      )
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((line) => line.type === "session_goal");
      expect(goalRecords[0]).toMatchObject({
        goal: {
          objective: "Ship atomic checkout",
          status: "active",
          budget: { turns: 3, tokens: 5_000, activeTimeMs: 5_000 },
          usage: { turns: 0, tokens: 0, activeTimeMs: 0 },
          criterionKind: "command",
          completionCriterion: 'node -e "process.exit(0)"',
          verificationTimeoutMs: 2_000,
        },
      });
      expect(goalRecords.at(-1)).toMatchObject({
        goal: { status: "completed" },
      });
      expect(fixture.stderr()).toContain(
        'Completion command "node -e \\"process.exit(0)\\"" exited 0 at the completion boundary.',
      );
      expect(fixture.stderr()).not.toContain("Tool failed:");
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a command goal configures a short verification timeout,
    When the model proposes completion and the verifier exceeds that timeout,
    Then the CLI rejects completion at the configured boundary and preserves the contract`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-goal-verifier-timeout-"),
    );
    const home = await mkdtemp(
      join(tmpdir(), "keel-cli-goal-verifier-timeout-home-"),
    );
    const server = createServer((req, res) => {
      if (req.url !== "/chat/completions") {
        res.writeHead(404);
        res.end();
        return;
      }
      req.resume();
      req.on("end", () => {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write(
          sseToolCall("complete_goal", "update_goal", {
            status: "completed",
          }),
        );
        res.write(sseToolFinish());
        res.end("data: [DONE]\n\n");
      });
    });
    await listen(server);
    const input = new PassThrough();
    input.write("/goal Verify a deliberately slow command\n");
    input.write(
      '/goal verify --timeout 20ms node -e "setTimeout(() => {}, 200)"\n',
    );
    input.end("/goal budget --turns 1\n");
    const fixture = createRuntime(
      ["--session", "goal-verifier-timeout", "--bash-policy=trusted"],
      {
        cwd: workspace,
        env: {
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
          KEEL_FORCE_INTERACTIVE: "1",
          KEEL_HOME: home,
        },
        input,
      },
    );

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toContain(
        'Goal verification command set: node -e "setTimeout(() => {}, 200)"\n',
      );
      const ledger = await readFile(
        join(home, "sessions", "goal-verifier-timeout", "ledger.jsonl"),
        "utf8",
      );
      expect(ledger).toContain('"verificationTimeoutMs":20');
      expect(ledger).toContain("Command timed out after 20ms");
      expect(ledger).toContain('"status":"budget_limited"');
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given the provider emits repeated blocked goal proposals in one assistant turn,
    When the CLI entrypoint executes the turn,
    Then only one blocked audit step is persisted for that turn`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-goal-blocked-burst-"),
    );
    const home = await mkdtemp(
      join(tmpdir(), "keel-cli-goal-blocked-burst-home-"),
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
        if (capturedBodies.length === 1) {
          res.write(
            sseToolCall(
              "goal_1",
              "update_goal",
              {
                status: "blocked",
                reason: "Need credentials from the user.",
              },
              { index: 0 },
            ),
          );
          res.write(
            sseToolCall(
              "goal_2",
              "update_goal",
              {
                status: "blocked",
                reason: "Credentials remain unavailable.",
              },
              { index: 1 },
            ),
          );
          res.write(
            sseToolCall(
              "goal_3",
              "update_goal",
              {
                status: "blocked",
                reason: "The user still has not provided credentials.",
              },
              { index: 2 },
            ),
          );
          res.write(sseToolFinish());
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        res.end(sseTextReplyWithUsage("Burst checked."));
      });
    });
    await listen(server);
    const input = new PassThrough();
    input.write("/goal Finish the durable session goal\n");
    input.write("/goal verify pnpm test\n");
    input.write("continue the durable goal\n");
    input.end("/status\n");
    const fixture = createRuntime(
      ["--session", "goal-blocked-burst", "--bash-policy", "deny"],
      {
        cwd: workspace,
        env: {
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
          KEEL_FORCE_INTERACTIVE: "1",
          KEEL_HOME: home,
        },
        input,
      },
    );

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toContain("Burst checked.\n");
      const secondRequest = requestWithMessagesSchema.parse(capturedBodies[1]);
      const secondMessages = secondRequest.messages ?? [];
      expect(
        secondMessages.filter((message) => message.role === "tool"),
      ).toEqual([
        {
          role: "tool",
          tool_call_id: "goal_1",
          content:
            "Session goal blocked proposal recorded (1/3): Finish the durable session goal. Reason: Need credentials from the user. Goal remains active; continue working unless progress remains blocked in later turns.",
        },
        {
          role: "tool",
          tool_call_id: "goal_2",
          content:
            "Tool failed: update_goal blocked proposal already recorded for this agent turn.\nRecovery: Continue working, or wait until the next agent turn before proposing the blocked goal state again.",
        },
        {
          role: "tool",
          tool_call_id: "goal_3",
          content:
            "Tool failed: update_goal blocked proposal already recorded for this agent turn.\nRecovery: Continue working, or wait until the next agent turn before proposing the blocked goal state again.",
        },
      ]);
      const ledger = jsonlRecords(
        await readFile(
          join(home, "sessions", "goal-blocked-burst", "ledger.jsonl"),
          "utf8",
        ),
      );
      const goalRecords = sessionGoalLedgerRecords(ledger);
      expect(goalRecords.at(-1)?.goal).toEqual({
        objective: "Finish the durable session goal",
        status: "active",
        budget: {},
        usage: { turns: 1, tokens: 26, activeTimeMs: expect.any(Number) },
        criterionKind: "command",
        completionCriterion: "pnpm test",
        blockedAudit: {
          consecutiveCount: 1,
          reason: "Need credentials from the user.",
        },
        latestRuntimeOutcome: {
          kind: "blocker_audit",
          reason: "Blocked audit 1/3 recorded: Need credentials from the user.",
        },
      });
      expect(goalRecords).not.toContainEqual(
        expect.objectContaining({
          goal: expect.objectContaining({ status: "blocked" }),
        }),
      );
      expect(fixture.stderr()).toBe(
        [
          "Tool: update_goal\n",
          "Session goal: active - Finish the durable session goal; criterion(command): pnpm test; blocked audit: 1/3 - Need credentials from the user.\n",
          "Session goal outcome: blocker audit - Blocked audit 1/3 recorded: Need credentials from the user.\n",
          "Tool: update_goal\n",
          "Tool failed: update_goal\n",
          "Tool: update_goal\n",
          "Tool failed: update_goal\n",
        ].join(""),
      );
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a pending blocked audit is followed by a non-blocked tool turn,
    When the provider later proposes blocked again through the CLI entrypoint,
    Then the blocked audit restarts from one`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-goal-blocked-reset-"),
    );
    const home = await mkdtemp(
      join(tmpdir(), "keel-cli-goal-blocked-reset-home-"),
    );
    await writeFile(join(workspace, "note.txt"), "work can continue\n", "utf8");
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
        if (capturedBodies.length === 1) {
          res.write(
            sseToolCall("goal_1", "update_goal", {
              status: "blocked",
              reason: "Need credentials from the user.",
            }),
          );
          res.write(sseToolFinish());
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        if (capturedBodies.length === 2) {
          res.end(sseTextReplyWithUsage("First blocked proposal recorded."));
          return;
        }
        if (capturedBodies.length === 3) {
          res.write(sseToolCall("read_1", "read", { path: "note.txt" }));
          res.write(sseToolFinish());
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        if (capturedBodies.length === 4) {
          res.end(sseTextReplyWithUsage("Read completed."));
          return;
        }
        if (capturedBodies.length === 5) {
          res.write(
            sseToolCall("goal_2", "update_goal", {
              status: "blocked",
              reason: "Credentials are unavailable again.",
            }),
          );
          res.write(sseToolFinish());
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        res.end(sseTextReplyWithUsage("Audit restarted."));
      });
    });
    await listen(server);
    const input = new PassThrough();
    input.write("/goal Finish the durable session goal\n");
    input.write("/goal verify pnpm test\n");
    input.write("first blocked proposal\n");
    input.write("read note.txt\n");
    input.write("blocked again\n");
    input.end("/status\n");
    const fixture = createRuntime(
      ["--session", "goal-blocked-reset", "--bash-policy", "deny"],
      {
        cwd: workspace,
        env: {
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
          KEEL_FORCE_INTERACTIVE: "1",
          KEEL_HOME: home,
        },
        input,
      },
    );

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toContain("First blocked proposal recorded.\n");
      expect(fixture.stdout()).toContain("Read completed.\n");
      expect(fixture.stdout()).toContain("Audit restarted.\n");
      const ledger = jsonlRecords(
        await readFile(
          join(home, "sessions", "goal-blocked-reset", "ledger.jsonl"),
          "utf8",
        ),
      );
      const goals = sessionGoalLedgerRecords(ledger).map(
        (record) => record.goal,
      );
      expect(goals).toContainEqual({
        objective: "Finish the durable session goal",
        status: "active",
        budget: {},
        usage: { turns: 1, tokens: 26, activeTimeMs: expect.any(Number) },
        criterionKind: "command",
        completionCriterion: "pnpm test",
        blockedAudit: {
          consecutiveCount: 1,
          reason: "Need credentials from the user.",
        },
        latestRuntimeOutcome: {
          kind: "blocker_audit",
          reason: "Blocked audit 1/3 recorded: Need credentials from the user.",
        },
      });
      expect(goals).toContainEqual({
        objective: "Finish the durable session goal",
        status: "active",
        budget: {},
        usage: { turns: 2, tokens: 52, activeTimeMs: expect.any(Number) },
        criterionKind: "command",
        completionCriterion: "pnpm test",
        latestRuntimeOutcome: {
          kind: "progress_observed",
          reason:
            "The pending blocker audit cleared after a turn continued without another blocked proposal.",
        },
      });
      expect(goals.at(-1)).toEqual({
        objective: "Finish the durable session goal",
        status: "active",
        budget: {},
        usage: { turns: 3, tokens: 78, activeTimeMs: expect.any(Number) },
        criterionKind: "command",
        completionCriterion: "pnpm test",
        blockedAudit: {
          consecutiveCount: 1,
          reason: "Credentials are unavailable again.",
        },
        latestRuntimeOutcome: {
          kind: "blocker_audit",
          reason:
            "Blocked audit 1/3 recorded: Credentials are unavailable again.",
        },
      });
      expect(goals).not.toContainEqual(
        expect.objectContaining({ status: "blocked" }),
      );
      expect(fixture.stderr()).toBe(
        [
          "Tool: update_goal\n",
          "Session goal: active - Finish the durable session goal; criterion(command): pnpm test; blocked audit: 1/3 - Need credentials from the user.\n",
          "Session goal outcome: blocker audit - Blocked audit 1/3 recorded: Need credentials from the user.\n",
          "Tool: read note.txt\n",
          "Session goal: active - Finish the durable session goal; criterion(command): pnpm test\n",
          "Session goal outcome: progress observed - The pending blocker audit cleared after a turn continued without another blocked proposal.\n",
          "Tool: update_goal\n",
          "Session goal: active - Finish the durable session goal; criterion(command): pnpm test; blocked audit: 1/3 - Credentials are unavailable again.\n",
          "Session goal outcome: blocker audit - Blocked audit 1/3 recorded: Credentials are unavailable again.\n",
        ].join(""),
      );
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a saved active goal remains incomplete after a user turn,
    When no user input is queued,
    Then the CLI automatically continues the goal until evidence completes it`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-goal-auto-continue-"),
    );
    const home = await mkdtemp(
      join(tmpdir(), "keel-cli-goal-auto-continue-home-"),
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
        if (capturedBodies.length === 1) {
          res.end(sseTextReplyWithUsage("Initial goal turn done."));
          return;
        }
        if (capturedBodies.length === 2) {
          res.write(
            sseToolCall("write_done", "write", {
              path: "done.txt",
              content: "complete\n",
            }),
          );
          res.write(sseToolFinish());
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        if (capturedBodies.length === 3) {
          res.write(
            sseToolCall("verify_done", "bash", {
              command: "test -f done.txt",
            }),
          );
          res.write(sseToolFinish());
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        if (capturedBodies.length === 4) {
          res.write(
            sseToolCall("complete_goal", "update_goal", {
              status: "completed",
            }),
          );
          res.write(sseToolFinish());
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        res.end(sseTextReplyWithUsage("Goal completed from continuation."));
      });
    });
    await listen(server);
    const input = new PassThrough();
    input.write("/goal Finish the continuation goal\n");
    input.write("/goal verify test -f done.txt\n");
    input.end("start the goal\n");
    const fixture = createRuntime(
      ["--session", "goal-auto-continue", "--bash-policy", "trusted"],
      {
        cwd: workspace,
        env: {
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
          KEEL_FORCE_INTERACTIVE: "1",
          KEEL_HOME: home,
        },
        input,
      },
    );

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(capturedBodies).toHaveLength(5);
      expect(fixture.stdout()).toContain("Initial goal turn done.\n");
      expect(fixture.stdout()).toContain("Goal completed from continuation.\n");
      const continuationRequest = requestWithMessagesSchema.parse(
        capturedBodies[1],
      );
      expect(
        continuationRequest.messages?.filter(
          (message) =>
            message.role === "user" &&
            typeof message.content === "string" &&
            message.content.includes("Keel runtime goal continuation"),
        ),
      ).toEqual([
        expect.objectContaining({
          role: "user",
          content: expect.stringContaining(
            "This is runtime-generated continuation context, not a new user request.",
          ),
        }),
      ]);
      const ledger = jsonlRecords(
        await readFile(
          join(home, "sessions", "goal-auto-continue", "ledger.jsonl"),
          "utf8",
        ),
      );
      expect(sessionGoalLedgerRecords(ledger).at(-1)?.goal).toEqual({
        objective: "Finish the continuation goal",
        status: "completed",
        budget: {},
        usage: { turns: 2, tokens: 65, activeTimeMs: expect.any(Number) },
        criterionKind: "command",
        completionCriterion: "test -f done.txt",
        completionEvidence: {
          kind: "command",
          command: "test -f done.txt",
          cwd: workspace,
          exitCode: 0,
          freshness: "at_completion",
        },
        latestRuntimeOutcome: {
          kind: "completed",
          reason:
            'Completion command "test -f done.txt" exited 0 at the completion boundary.',
        },
      });
      await expect(readFile(join(workspace, "done.txt"), "utf8")).resolves.toBe(
        "complete\n",
      );
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test.each([
    {
      args: ["--provider=fake", "--bash-policy=deny"],
      expected: "  active model: fake/(default model)\n",
    },
    {
      args: ["--model=configured-model", "--bash-policy=deny"],
      expected: "  active model: (default provider)/configured-model\n",
    },
  ])(
    `Given partial provider or model flags are used before the first prompt,
    When the user asks for status,
    Then the snapshot reports the configured selection`,
    async (testCase) => {
      // Given
      const input = new PassThrough();
      input.end("/status\n");
      const fixture = createRuntime(testCase.args, {
        env: { KEEL_PROVIDER: "fake", KEEL_FORCE_INTERACTIVE: "1" },
        input,
      });

      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toContain(testCase.expected);
      expect(fixture.stderr()).toBe("");
    },
  );

  test(`Given the fake provider runs interactively,
    When the user sends two prompts on stdin,
    Then the second reply can use the first prompt as context`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-main-no-agents-"));
    const input = new PassThrough();
    input.end("remember alpha\nwhat did I ask you to remember?\n");
    const fixture = createRuntime([], {
      cwd: workspace,
      env: { KEEL_PROVIDER: "fake", KEEL_FORCE_INTERACTIVE: "1" },
      input,
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toContain("Remembered: remember alpha\n");
      expect(fixture.stdout()).toContain("Earlier you said: remember alpha\n");
      expect(fixture.stderr()).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the user runs interactive mode without a session flag,
    When the prompt completes and the user lists sessions,
    Then the CLI shows a resumable session that restores prior context`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const input = new PassThrough();
    input.end("remember alpha\n");
    const fixture = createRuntime([], {
      cwd: workspace,
      env: {
        KEEL_PROVIDER: "fake",
        KEEL_FORCE_INTERACTIVE: "1",
        KEEL_HOME: home,
      },
      input,
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toBe("Remembered: remember alpha\n");
      expect(fixture.stderr()).toBe("");

      const listFixture = createRuntime(["sessions"], {
        cwd: workspace,
        env: {
          KEEL_HOME: home,
        },
      });
      const listExitCode = await runCliMain(listFixture.runtime);
      expect(listExitCode).toBe(0);
      expect(listFixture.stdout()).toContain("Sessions for workspace ");
      const sessionId = sessionIdFromResumeLine(listFixture.stdout());

      const resumeInput = new PassThrough();
      resumeInput.end("what did I ask you to remember?\n");
      const resumeFixture = createRuntime(["--resume", sessionId], {
        cwd: workspace,
        env: {
          KEEL_PROVIDER: "fake",
          KEEL_FORCE_INTERACTIVE: "1",
          KEEL_HOME: home,
        },
        input: resumeInput,
      });
      const resumeExitCode = await runCliMain(resumeFixture.runtime);
      expect(resumeExitCode).toBe(0);
      expect(resumeFixture.stdout()).toBe("Earlier you said: remember alpha\n");
      expect(resumeFixture.stderr()).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given the user names a saved interactive session,
    When they return through session recovery surfaces,
    Then Keel shows the task title before resuming`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-title-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const input = new PassThrough();
    input.end(
      "/title Fix login timeout\nremember login timeout\n/title\n/status\n",
    );
    const fixture = createRuntime([], {
      cwd: workspace,
      env: {
        KEEL_PROVIDER: "fake",
        KEEL_FORCE_INTERACTIVE: "1",
        KEEL_HOME: home,
      },
      input,
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      const stdout = fixture.stdout();
      expect(stdout).toContain("Remembered: remember login timeout\n");
      expect(stdout).toContain("Session title set to: Fix login timeout\n");
      expect(stdout).toContain("Session title: Fix login timeout\n");
      expect(stdout).toContain("  title: Fix login timeout\n");
      expect(fixture.stderr()).toBe("");

      const listFixture = createRuntime(["sessions"], {
        cwd: workspace,
        env: {
          KEEL_HOME: home,
        },
      });
      const listExitCode = await runCliMain(listFixture.runtime);
      expect(listExitCode).toBe(0);
      expect(listFixture.stdout()).toContain("   title: Fix login timeout\n");
      const sessionId = sessionIdFromResumeLine(listFixture.stdout());

      const showFixture = createRuntime(["sessions", "show", sessionId], {
        cwd: workspace,
        env: {
          KEEL_HOME: home,
        },
      });
      const showExitCode = await runCliMain(showFixture.runtime);
      expect(showExitCode).toBe(0);
      expect(showFixture.stdout()).toContain("title: Fix login timeout\n");
      expect(showFixture.stdout()).toContain("  title: Fix login timeout\n");

      const resumeInput = new PassThrough();
      resumeInput.end("/title\n/status\n");
      const resumeFixture = createRuntime(["--resume", sessionId], {
        cwd: workspace,
        env: {
          KEEL_PROVIDER: "fake",
          KEEL_FORCE_INTERACTIVE: "1",
          KEEL_HOME: home,
        },
        input: resumeInput,
      });
      const resumeExitCode = await runCliMain(resumeFixture.runtime);
      expect(resumeExitCode).toBe(0);
      expect(resumeFixture.stdout()).toContain(
        "Session title: Fix login timeout\n",
      );
      expect(resumeFixture.stdout()).toContain("  title: Fix login timeout\n");

      const startupInput = new PassThrough();
      const startupFixture = createRuntime([], {
        cwd: workspace,
        env: {
          KEEL_PROVIDER: "fake",
          KEEL_HOME: home,
        },
        input: startupInput,
        inputIsTTY: true,
        stderrIsTTY: false,
      });
      const startupRun = runCliMain(startupFixture.runtime);
      await waitForCondition(
        () => startupFixture.stdout().includes("Resume latest saved session?"),
        "resume-first startup prompt did not render",
      );
      startupInput.end("q\n");
      const startupExitCode = await startupRun;
      expect(startupExitCode).toBe(0);
      expect(startupFixture.stdout()).toContain(
        `Saved sessions for workspace ${ledgerWorkspace}:\n`,
      );
      expect(startupFixture.stdout()).toContain("title: Fix login timeout\n");
      expect(startupFixture.stdout()).toContain("Startup cancelled.\n");

      const pickerInput = new PassThrough();
      const pickerFixture = createRuntime(["--resume", "--pick"], {
        cwd: workspace,
        env: {
          KEEL_PROVIDER: "fake",
          KEEL_HOME: home,
        },
        input: pickerInput,
        inputIsTTY: true,
        stderrIsTTY: false,
      });
      const pickerRun = runCliMain(pickerFixture.runtime);
      await waitForCondition(
        () =>
          pickerFixture
            .stdout()
            .includes("Select session [1-1], or q to cancel:"),
        "resume picker did not render the session choice",
      );
      pickerInput.end("q\n");
      const pickerExitCode = await pickerRun;
      expect(pickerExitCode).toBe(0);
      expect(pickerFixture.stdout()).toContain("   title: Fix login timeout\n");
      expect(pickerFixture.stdout()).toContain("Resume cancelled.\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given saved sessions exist in multiple workspaces,
    When the user resumes without a session id,
    Then Keel continues the latest saved session for the current workspace`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const otherWorkspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const env = {
      KEEL_PROVIDER: "fake",
      KEEL_FORCE_INTERACTIVE: "1",
      KEEL_HOME: home,
    };
    const olderInput = new PassThrough();
    olderInput.end("remember alpha\n");
    const olderRun = createRuntime(["--session", "older"], {
      cwd: workspace,
      env,
      input: olderInput,
      now: () => 1_000,
    });
    const otherInput = new PassThrough();
    otherInput.end("remember elsewhere\n");
    const otherRun = createRuntime(["--session", "elsewhere"], {
      cwd: otherWorkspace,
      env,
      input: otherInput,
      now: () => 3_000,
    });
    const latestInput = new PassThrough();
    latestInput.end("remember beta\n");
    const latestRun = createRuntime(["--session", "latest"], {
      cwd: workspace,
      env,
      input: latestInput,
      now: () => 2_000,
    });

    try {
      const olderExitCode = await runCliMain(olderRun.runtime);
      const otherExitCode = await runCliMain(otherRun.runtime);
      const latestExitCode = await runCliMain(latestRun.runtime);
      await mkdir(join(home, "sessions", "broken"), { recursive: true });
      await writeFile(
        join(home, "sessions", "broken", "ledger.jsonl"),
        "{not json\n",
        "utf8",
      );
      const resumeInput = new PassThrough();
      resumeInput.end("what did I ask you to remember?\n");
      const resumeRun = createRuntime(["--resume"], {
        cwd: workspace,
        env,
        input: resumeInput,
        now: () => 4_000,
      });

      // When
      const resumeExitCode = await runCliMain(resumeRun.runtime);

      // Then
      expect(olderExitCode).toBe(0);
      expect(otherExitCode).toBe(0);
      expect(latestExitCode).toBe(0);
      expect(olderRun.stdout()).toBe("Remembered: remember alpha\n");
      expect(otherRun.stdout()).toBe("Remembered: remember elsewhere\n");
      expect(latestRun.stdout()).toBe("Remembered: remember beta\n");
      expect(resumeExitCode).toBe(0);
      expect(resumeRun.stdout()).toBe("Earlier you said: remember beta\n");
      expect(resumeRun.stderr()).toContain(
        'Warning: skipped session "broken": cannot load session ledger',
      );
      expect(resumeRun.stderr()).toContain("Resuming latest session: latest\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(otherWorkspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given saved sessions exist in the current workspace,
    When the user starts bare Keel in a real terminal and accepts the latest session,
    Then Keel continues the saved task before reading the next prompt`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    await writeSessionLedger({
      home,
      id: "older",
      workspace: ledgerWorkspace,
      createdAt: "2026-01-01T00:00:00.000Z",
      records: [
        appendSessionRecordLine("2026-01-01T00:00:05.000Z", [
          {
            role: "user",
            content: "remember alpha",
            origin: { type: "user_prompt" },
          },
          {
            role: "assistant",
            content: "Remembered alpha.",
            toolCalls: [],
          },
        ]),
      ],
    });
    await writeSessionLedger({
      home,
      id: "latest",
      workspace: ledgerWorkspace,
      createdAt: "2026-01-02T00:00:00.000Z",
      records: [
        appendSessionRecordLine("2026-01-02T00:00:05.000Z", [
          {
            role: "user",
            content: "remember beta",
            origin: { type: "user_prompt" },
          },
          {
            role: "assistant",
            content: "Remembered beta.",
            toolCalls: [],
          },
        ]),
      ],
    });
    await mkdir(join(home, "sessions", "broken"), { recursive: true });
    await writeFile(join(home, "sessions", "broken", "ledger.jsonl"), "{bad\n");

    const input = new PassThrough();
    const fixture = createRuntime([], {
      cwd: workspace,
      env: {
        KEEL_PROVIDER: "fake",
        KEEL_HOME: home,
      },
      input,
      inputIsTTY: true,
      stderrIsTTY: false,
    });

    try {
      // When
      const run = runCliMain(fixture.runtime);
      await waitForCondition(
        () => fixture.stdout().includes("Resume latest saved session?"),
        "resume-first startup prompt did not render",
      );
      input.end("\nwhat did I ask you to remember?\n");
      const exitCode = await run;

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toContain(
        `Saved sessions for workspace ${ledgerWorkspace}:\n`,
      );
      expect(fixture.stdout()).toContain(
        "Resume latest saved session?\n  Enter/y  resume latest: latest\n  p        pick another session\n  n        start a new session\n  q        quit\n",
      );
      expect(fixture.stdout()).toContain("Earlier you said: remember beta\n");
      expect(fixture.stderr()).toContain(
        'Warning: skipped session "broken": cannot load session ledger',
      );
      expect(fixture.stderr()).toContain("Resuming latest session: latest\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a saved session has active task progress and queued input,
    When the user starts bare Keel and opens the resume picker,
    Then Keel shows recovery status before the user selects a session`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    await writeSessionLedger({
      home,
      id: "active",
      workspace: ledgerWorkspace,
      createdAt: "2026-03-01T00:00:00.000Z",
      records: [
        appendSessionRecordLine("2026-03-01T00:00:01.000Z", [
          {
            role: "user",
            content: "fix resume status",
            origin: { type: "user_prompt" },
          },
          {
            role: "assistant",
            content: "I will inspect session recovery.",
            toolCalls: [],
          },
        ]),
        taskProgressRecordLine({
          timestamp: "2026-03-01T00:00:02.000Z",
          tasks: [
            { step: "Inspect session recovery", status: "completed" },
            { step: "Patch catalog status", status: "in_progress" },
          ],
        }),
        inputAdmittedRecordLine({
          timestamp: "2026-03-01T00:00:03.000Z",
          id: "active-follow-up",
          line: "also update the startup prompt",
        }),
      ],
    });

    try {
      const startupInput = new PassThrough();
      const startupFixture = createRuntime([], {
        cwd: workspace,
        env: {
          KEEL_PROVIDER: "fake",
          KEEL_HOME: home,
        },
        input: startupInput,
        inputIsTTY: true,
        stderrIsTTY: false,
      });
      const startupRun = runCliMain(startupFixture.runtime);
      await waitForCondition(
        () => startupFixture.stdout().includes("Resume latest saved session?"),
        "resume-first startup prompt did not render",
      );
      startupInput.end("q\n");
      const startupExitCode = await startupRun;

      expect(startupExitCode).toBe(0);
      expect(startupFixture.stdout()).toContain(
        `Saved sessions for workspace ${ledgerWorkspace}:\n`,
      );
      expect(startupFixture.stdout()).toContain(
        "tasks: 1/2 completed; current: Patch catalog status\n",
      );
      expect(startupFixture.stdout()).toContain("pending inputs: 1\n");
      expect(startupFixture.stdout()).toContain("Startup cancelled.\n");

      const pickerInput = new PassThrough();
      const pickerFixture = createRuntime(["--resume", "--pick"], {
        cwd: workspace,
        env: {
          KEEL_PROVIDER: "fake",
          KEEL_HOME: home,
        },
        input: pickerInput,
        inputIsTTY: true,
        stderrIsTTY: false,
      });
      const pickerRun = runCliMain(pickerFixture.runtime);
      await waitForCondition(
        () =>
          pickerFixture
            .stdout()
            .includes("Select session [1-1], or q to cancel:"),
        "resume picker did not render the session choice",
      );
      pickerInput.end("q\n");
      const pickerExitCode = await pickerRun;

      expect(pickerExitCode).toBe(0);
      expect(pickerFixture.stdout()).toContain(
        "   tasks: 1/2 completed; current: Patch catalog status\n",
      );
      expect(pickerFixture.stdout()).toContain("   pending inputs: 1\n");
      expect(pickerFixture.stdout()).toContain("Resume cancelled.\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given saved sessions exist in the current workspace,
    When the user starts bare Keel and asks to pick a session,
    Then Keel opens the picker and continues the selected task`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    await writeSessionLedger({
      home,
      id: "older",
      workspace: ledgerWorkspace,
      createdAt: "2026-01-01T00:00:00.000Z",
      records: [
        appendSessionRecordLine("2026-01-01T00:00:05.000Z", [
          {
            role: "user",
            content: "remember alpha",
            origin: { type: "user_prompt" },
          },
          {
            role: "assistant",
            content: "Remembered alpha.",
            toolCalls: [],
          },
        ]),
      ],
    });
    await writeSessionLedger({
      home,
      id: "latest",
      workspace: ledgerWorkspace,
      createdAt: "2026-01-02T00:00:00.000Z",
      graph: endForkGraph({
        sessionId: "latest",
        parentSessionId: "older",
        sourceLastMessageId: "msg_append-2026-01-01T00_00_05_000Z_2",
        sourceOrdinal: 2,
      }),
      records: [
        appendSessionRecordLine("2026-01-02T00:00:05.000Z", [
          {
            role: "user",
            content: "remember beta",
            origin: { type: "user_prompt" },
          },
          {
            role: "assistant",
            content: "Remembered beta.",
            toolCalls: [],
          },
        ]),
      ],
    });

    const input = new PassThrough();
    const fixture = createRuntime([], {
      cwd: workspace,
      env: {
        KEEL_PROVIDER: "fake",
        KEEL_HOME: home,
      },
      input,
      inputIsTTY: true,
      stderrIsTTY: false,
    });

    try {
      // When
      const run = runCliMain(fixture.runtime);
      await waitForCondition(
        () => fixture.stdout().includes("Resume latest saved session?"),
        "resume-first startup prompt did not render",
      );
      input.end("p\n2\n\nwhat did I ask you to remember?\n");
      const exitCode = await run;

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toContain(
        "Select session [1-2], or q to cancel:",
      );
      expect(fixture.stdout()).toContain("Earlier you said: remember beta\n");
      expect(fixture.stderr()).toContain("Resuming selected session: latest\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given saved sessions exist in the current workspace,
    When the user starts bare Keel and chooses a new session,
    Then Keel starts fresh instead of restoring saved context`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    await writeSessionLedger({
      home,
      id: "latest",
      workspace: ledgerWorkspace,
      createdAt: "2026-01-02T00:00:00.000Z",
      records: [
        appendSessionRecordLine("2026-01-02T00:00:05.000Z", [
          {
            role: "user",
            content: "remember beta",
            origin: { type: "user_prompt" },
          },
          {
            role: "assistant",
            content: "Remembered beta.",
            toolCalls: [],
          },
        ]),
      ],
    });

    const input = new PassThrough();
    const fixture = createRuntime([], {
      cwd: workspace,
      env: {
        KEEL_PROVIDER: "fake",
        KEEL_HOME: home,
      },
      input,
      inputIsTTY: true,
      stderrIsTTY: false,
    });

    try {
      // When
      const run = runCliMain(fixture.runtime);
      await waitForCondition(
        () => fixture.stdout().includes("Resume latest saved session?"),
        "resume-first startup prompt did not render",
      );
      input.end("n\nwhat did I ask you to remember?\n");
      const exitCode = await run;

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toContain(
        "Starting a new saved session.\nRemembered: what did I ask you to remember?\n",
      );
      expect(fixture.stdout()).not.toContain("Earlier you said:");
      expect(fixture.stderr()).not.toContain("Resuming");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given saved sessions exist in the current workspace,
    When the user starts bare Keel and cancels the startup prompt,
    Then Keel exits without starting a provider turn or creating a new session`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    await writeSessionLedger({
      home,
      id: "latest",
      workspace: ledgerWorkspace,
      createdAt: "2026-01-02T00:00:00.000Z",
      records: [
        appendSessionRecordLine("2026-01-02T00:00:05.000Z", [
          {
            role: "user",
            content: "remember beta",
            origin: { type: "user_prompt" },
          },
          {
            role: "assistant",
            content: "Remembered beta.",
            toolCalls: [],
          },
        ]),
      ],
    });

    const input = new PassThrough();
    const fixture = createRuntime([], {
      cwd: workspace,
      env: {
        KEEL_PROVIDER: "fake",
        KEEL_HOME: home,
      },
      input,
      inputIsTTY: true,
      stderrIsTTY: false,
    });

    try {
      // When
      const run = runCliMain(fixture.runtime);
      await waitForCondition(
        () => fixture.stdout().includes("Resume latest saved session?"),
        "resume-first startup prompt did not render",
      );
      input.end("q\nthis must not run\n");
      const exitCode = await run;

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toContain("Startup cancelled.\n");
      expect(fixture.stdout()).not.toContain("Remembered:");
      expect(fixture.stderr()).not.toContain("Keel interactive session");
      expect(await sessionDirectoryNames(home)).toEqual(["latest"]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given saved sessions exist in the current workspace,
    When the user starts bare Keel and cancels after opening the picker,
    Then Keel exits without starting a resumed session`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    await writeSessionLedger({
      home,
      id: "latest",
      workspace: ledgerWorkspace,
      createdAt: "2026-01-02T00:00:00.000Z",
      records: [
        appendSessionRecordLine("2026-01-02T00:00:05.000Z", [
          {
            role: "user",
            content: "remember beta",
            origin: { type: "user_prompt" },
          },
          {
            role: "assistant",
            content: "Remembered beta.",
            toolCalls: [],
          },
        ]),
      ],
    });

    const input = new PassThrough();
    const fixture = createRuntime([], {
      cwd: workspace,
      env: {
        KEEL_PROVIDER: "fake",
        KEEL_HOME: home,
      },
      input,
      inputIsTTY: true,
      stderrIsTTY: false,
    });

    try {
      // When
      const run = runCliMain(fixture.runtime);
      await waitForCondition(
        () => fixture.stdout().includes("Resume latest saved session?"),
        "resume-first startup prompt did not render",
      );
      input.end("p\nq\nthis must not run\n");
      const exitCode = await run;

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toContain(
        "Select session [1-1], or q to cancel:",
      );
      expect(fixture.stdout()).toContain("Resume cancelled.\n");
      expect(fixture.stdout()).not.toContain("Remembered:");
      expect(fixture.stderr()).not.toContain("Resuming selected session");
      expect(fixture.stderr()).not.toContain("Keel interactive session");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given saved sessions exist in the current workspace,
    When input closes while bare Keel waits for the startup choice,
    Then Keel exits without an explicit cancellation message`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    await writeSessionLedger({
      home,
      id: "latest",
      workspace: ledgerWorkspace,
      createdAt: "2026-01-02T00:00:00.000Z",
      records: [
        appendSessionRecordLine("2026-01-02T00:00:05.000Z", [
          {
            role: "user",
            content: "remember beta",
            origin: { type: "user_prompt" },
          },
          {
            role: "assistant",
            content: "Remembered beta.",
            toolCalls: [],
          },
        ]),
      ],
    });

    const input = new PassThrough();
    const fixture = createRuntime([], {
      cwd: workspace,
      env: {
        KEEL_PROVIDER: "fake",
        KEEL_HOME: home,
      },
      input,
      inputIsTTY: true,
      stderrIsTTY: false,
    });

    try {
      // When
      const run = runCliMain(fixture.runtime);
      await waitForCondition(
        () => fixture.stdout().includes("Resume latest saved session?"),
        "resume-first startup prompt did not render",
      );
      input.end();
      const exitCode = await run;

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).not.toContain("Startup cancelled.\n");
      expect(fixture.stdout()).not.toContain("Remembered:");
      expect(fixture.stderr()).not.toContain("Keel interactive session");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given saved sessions exist in the current workspace,
    When the user enters an invalid bare Keel startup choice and then chooses new,
    Then Keel re-prompts and starts a fresh session`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    await writeSessionLedger({
      home,
      id: "latest",
      workspace: ledgerWorkspace,
      createdAt: "2026-01-02T00:00:00.000Z",
      records: [
        appendSessionRecordLine("2026-01-02T00:00:05.000Z", [
          {
            role: "user",
            content: "remember beta",
            origin: { type: "user_prompt" },
          },
          {
            role: "assistant",
            content: "Remembered beta.",
            toolCalls: [],
          },
        ]),
      ],
    });

    const input = new PassThrough();
    const fixture = createRuntime([], {
      cwd: workspace,
      env: {
        KEEL_PROVIDER: "fake",
        KEEL_HOME: home,
      },
      input,
      inputIsTTY: true,
      stderrIsTTY: false,
    });

    try {
      // When
      const run = runCliMain(fixture.runtime);
      await waitForCondition(
        () => fixture.stdout().includes("Resume latest saved session?"),
        "resume-first startup prompt did not render",
      );
      input.end("maybe\nn\nfresh task\n");
      const exitCode = await run;

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stderr()).toContain(
        "Error: choose Enter/y, p, n, or q.\n",
      );
      expect(fixture.stdout()).toContain("Starting a new saved session.\n");
      expect(fixture.stdout()).toContain("Remembered: fresh task\n");
      expect(fixture.stdout()).not.toContain("Earlier you said:");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given saved sessions exist and the user selects a workflow skill,
    When the user starts Keel in a real terminal,
    Then Keel starts the skilled session without showing the bare resume prompt`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    await writeWorkflowSkill({
      workspace,
      name: "review",
      description: "Review a PR using the project checklist.",
      body: "Read PR comments first.",
    });
    await writeSessionLedger({
      home,
      id: "latest",
      workspace: ledgerWorkspace,
      createdAt: "2026-01-02T00:00:00.000Z",
      records: [
        appendSessionRecordLine("2026-01-02T00:00:05.000Z", [
          {
            role: "user",
            content: "remember beta",
            origin: { type: "user_prompt" },
          },
          {
            role: "assistant",
            content: "Remembered beta.",
            toolCalls: [],
          },
        ]),
      ],
    });

    const input = new PassThrough();
    const fixture = createRuntime(["--skill", "review"], {
      cwd: workspace,
      env: {
        KEEL_PROVIDER: "fake",
        KEEL_HOME: home,
      },
      input,
      inputIsTTY: true,
      stderrIsTTY: false,
    });

    try {
      // When
      const run = runCliMain(fixture.runtime);
      await waitForCondition(
        () => fixture.stderr().includes("keel> "),
        "interactive skill session did not render the first prompt",
      );
      input.end("hello from skill\n");
      const exitCode = await run;

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toBe("Remembered: hello from skill\n");
      expect(fixture.stdout()).not.toContain("Resume latest saved session?");
      expect(fixture.stderr()).not.toContain("Resuming latest session");
      expect(fixture.stderr()).not.toContain(
        'session "latest" has no workflow skill',
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given saved sessions exist in the current workspace,
    When the user picks a session to resume,
    Then Keel continues the selected saved task instead of the latest one`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const otherWorkspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const ledgerWorkspace = await realpath(workspace);
    const otherLedgerWorkspace = await realpath(otherWorkspace);
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    await writeSessionLedger({
      home,
      id: "older",
      workspace: ledgerWorkspace,
      createdAt: "2026-01-01T00:00:00.000Z",
      records: [
        appendSessionRecordLine("2026-01-01T00:00:05.000Z", [
          {
            role: "user",
            content: "remember alpha",
            origin: { type: "user_prompt" },
          },
          {
            role: "assistant",
            content: "Remembered alpha.",
            toolCalls: [],
          },
        ]),
      ],
    });
    await writeSessionLedger({
      home,
      id: "latest",
      workspace: ledgerWorkspace,
      createdAt: "2026-01-02T00:00:00.000Z",
      records: [
        appendSessionRecordLine("2026-01-02T00:00:05.000Z", [
          {
            role: "user",
            content: "remember beta",
            origin: { type: "user_prompt" },
          },
          {
            role: "assistant",
            content: "Remembered beta.",
            toolCalls: [],
          },
        ]),
      ],
    });
    await writeSessionLedger({
      home,
      id: "elsewhere",
      workspace: otherLedgerWorkspace,
      createdAt: "2026-01-03T00:00:00.000Z",
      records: [
        appendSessionRecordLine("2026-01-03T00:00:05.000Z", [
          {
            role: "user",
            content: "remember elsewhere",
            origin: { type: "user_prompt" },
          },
          {
            role: "assistant",
            content: "Remembered elsewhere.",
            toolCalls: [],
          },
        ]),
      ],
    });
    await mkdir(join(home, "sessions", "broken"), { recursive: true });
    await writeFile(join(home, "sessions", "broken", "ledger.jsonl"), "{bad\n");

    const input = new PassThrough();
    const fixture = createRuntime(["--resume", "--pick"], {
      cwd: workspace,
      env: {
        KEEL_PROVIDER: "fake",
        KEEL_HOME: home,
      },
      input,
      inputIsTTY: true,
      stderrIsTTY: false,
    });

    try {
      // When
      const run = runCliMain(fixture.runtime);
      await waitForCondition(
        () =>
          fixture.stdout().includes("Select session [1-2], or q to cancel:"),
        "resume picker did not render the session choices",
      );
      input.end("2\n\nwhat did I ask you to remember?\n");
      const exitCode = await run;

      // Then
      expect(exitCode).toBe(0);
      const stdout = fixture.stdout();
      expect(stdout).toContain(`Sessions for workspace ${ledgerWorkspace}:\n`);
      expect(stdout).toContain(
        "Keep one saved session open per task; resume it for follow-ups until the task is done.\n",
      );
      expect(stdout).toContain("1. latest  updated 2026-01-02T00:00:05.000Z\n");
      expect(stdout).toContain("   preview: remember beta\n");
      expect(stdout).toContain("2. older  updated 2026-01-01T00:00:05.000Z\n");
      expect(stdout).toContain("   preview: remember alpha\n");
      expect(stdout).not.toContain("elsewhere");
      expect(stdout).not.toContain("remember elsewhere");
      expect(stdout).toContain("Earlier you said: remember alpha\n");
      expect(fixture.stderr()).toContain(
        'Warning: skipped session "broken": cannot load session ledger',
      );
      expect(fixture.stderr()).toContain("Resuming selected session: older\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(otherWorkspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a saved task has a newer fork beside another session,
    When the user browses resume choices and selects the fork,
    Then Keel shows the task graph and continues the numbered branch`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-graph-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const rootLastMessageId = "msg_append-2026-01-01T00_00_05_000Z_2";
    await writeSessionLedger({
      home,
      id: "login-timeout",
      workspace: ledgerWorkspace,
      createdAt: "2026-01-01T00:00:00.000Z",
      records: [
        appendSessionRecordLine("2026-01-01T00:00:05.000Z", [
          {
            role: "user",
            content: "remember the login timeout task",
            origin: { type: "user_prompt" },
          },
          {
            role: "assistant",
            content: "Remembered the login timeout task.",
            toolCalls: [],
          },
        ]),
      ],
    });
    await writeSessionLedger({
      home,
      id: "database-index",
      workspace: ledgerWorkspace,
      createdAt: "2026-01-03T00:00:00.000Z",
      graph: endForkGraph({
        sessionId: "database-index",
        parentSessionId: "login-timeout",
        sourceLastMessageId: rootLastMessageId,
        sourceOrdinal: 2,
      }),
      records: [
        appendSessionRecordLine("2026-01-03T00:00:05.000Z", [
          {
            role: "user",
            content: "remember the database index branch",
            origin: { type: "user_prompt" },
          },
          {
            role: "assistant",
            content: "Remembered the database index branch.",
            toolCalls: [],
          },
        ]),
      ],
    });
    await writeSessionLedger({
      home,
      id: "unrelated",
      workspace: ledgerWorkspace,
      createdAt: "2026-01-02T00:00:00.000Z",
      records: [
        appendSessionRecordLine("2026-01-02T00:00:05.000Z", [
          {
            role: "user",
            content: "remember the unrelated task",
            origin: { type: "user_prompt" },
          },
          {
            role: "assistant",
            content: "Remembered the unrelated task.",
            toolCalls: [],
          },
        ]),
      ],
    });

    const input = new PassThrough();
    const fixture = createRuntime(["--resume", "--pick"], {
      cwd: workspace,
      env: {
        KEEL_PROVIDER: "fake",
        KEEL_HOME: home,
      },
      input,
      inputIsTTY: true,
      stderrIsTTY: false,
    });

    try {
      // When
      const run = runCliMain(fixture.runtime);
      await waitForCondition(
        () =>
          fixture.stdout().includes("Select session [1-3], or q to cancel:"),
        "graph-aware resume picker did not render",
      );
      input.end("2\n\nwhat did I ask you to remember?\n");
      const exitCode = await run;

      // Then
      expect(exitCode).toBe(0);
      const stdout = fixture.stdout();
      expect(stdout).toContain(
        [
          "graph login-timeout root login-timeout  updated 2026-01-03T00:00:05.000Z",
          "1. login-timeout  updated 2026-01-01T00:00:05.000Z",
          "   branch: main",
          "   preview: remember the login timeout task",
          "  2. database-index  updated 2026-01-03T00:00:05.000Z",
          "     branch: database-index",
          "     parent: login-timeout",
          `     fork point: full restored history from login-timeout through message ${rootLastMessageId} (message 2)`,
          "     preview: remember the database index branch",
        ].join("\n"),
      );
      expect(stdout).toContain(
        [
          "graph unrelated root unrelated  updated 2026-01-02T00:00:05.000Z",
          "3. unrelated  updated 2026-01-02T00:00:05.000Z",
        ].join("\n"),
      );
      expect(stdout).toContain(
        "Earlier you said: remember the database index branch\n",
      );
      expect(fixture.stderr()).toContain(
        "Resuming selected session: database-index\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given saved sessions contain a parent cycle in current graph metadata,
    When the user browses resume choices and selects a numbered session,
    Then Keel keeps every session visible and resumes the selected task`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-cycle-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    await writeSessionLedger({
      home,
      id: "cycle-a",
      workspace: ledgerWorkspace,
      createdAt: "2026-01-01T00:00:00.000Z",
      graph: {
        ...endForkGraph({
          sessionId: "cycle-a",
          parentSessionId: "cycle-b",
          sourceLastMessageId: "msg_cycle_b",
          sourceOrdinal: 2,
        }),
        graphId: "cycle",
        rootSessionId: "cycle-a",
      },
      records: [
        appendSessionRecordLine("2026-01-01T00:00:05.000Z", [
          {
            role: "user",
            content: "remember cycle alpha",
            origin: { type: "user_prompt" },
          },
          {
            role: "assistant",
            content: "Remembered cycle alpha.",
            toolCalls: [],
          },
        ]),
      ],
    });
    await writeSessionLedger({
      home,
      id: "cycle-b",
      workspace: ledgerWorkspace,
      createdAt: "2026-01-02T00:00:00.000Z",
      graph: {
        ...endForkGraph({
          sessionId: "cycle-b",
          parentSessionId: "cycle-a",
          sourceLastMessageId: "msg_cycle_a",
          sourceOrdinal: 2,
        }),
        graphId: "cycle",
        rootSessionId: "cycle-a",
      },
      records: [
        appendSessionRecordLine("2026-01-02T00:00:05.000Z", [
          {
            role: "user",
            content: "remember cycle beta",
            origin: { type: "user_prompt" },
          },
          {
            role: "assistant",
            content: "Remembered cycle beta.",
            toolCalls: [],
          },
        ]),
      ],
    });

    const input = new PassThrough();
    const fixture = createRuntime(["--resume", "--pick"], {
      cwd: workspace,
      env: {
        KEEL_PROVIDER: "fake",
        KEEL_HOME: home,
      },
      input,
      inputIsTTY: true,
      stderrIsTTY: false,
    });

    try {
      // When
      const run = runCliMain(fixture.runtime);
      await waitForCondition(
        () => fixture.stdout().includes("Select session ["),
        "resume picker did not render the cyclic graph",
      );
      input.end("2\n\nwhat did I ask you to remember?\n");
      const exitCode = await run;

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toContain(
        "graph cycle root cycle-a  updated 2026-01-02T00:00:05.000Z\n",
      );
      expect(fixture.stdout()).toContain(
        "1. cycle-b  updated 2026-01-02T00:00:05.000Z\n",
      );
      expect(fixture.stdout()).toContain(
        "  2. cycle-a  updated 2026-01-01T00:00:05.000Z\n",
      );
      expect(fixture.stdout()).toContain(
        "Earlier you said: remember cycle alpha\n",
      );
      expect(fixture.stderr()).toContain(
        "Resuming selected session: cycle-a\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given saved sessions exist in the current workspace,
    When the user cancels the resume picker,
    Then Keel exits without starting a resumed session`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    await writeSessionLedger({
      home,
      id: "cancel-demo",
      workspace: ledgerWorkspace,
      createdAt: "2026-01-01T00:00:00.000Z",
      records: [
        appendSessionRecordLine("2026-01-01T00:00:05.000Z", [
          {
            role: "user",
            content: "remember cancel demo",
            origin: { type: "user_prompt" },
          },
          {
            role: "assistant",
            content: "Remembered cancel demo.",
            toolCalls: [],
          },
        ]),
      ],
    });

    const input = new PassThrough();
    const fixture = createRuntime(["--resume", "--pick"], {
      cwd: workspace,
      env: {
        KEEL_PROVIDER: "fake",
        KEEL_HOME: home,
      },
      input,
      inputIsTTY: true,
      stderrIsTTY: false,
    });

    try {
      // When
      const run = runCliMain(fixture.runtime);
      await waitForCondition(
        () =>
          fixture.stdout().includes("Select session [1-1], or q to cancel:"),
        "resume picker did not render before cancellation",
      );
      input.end("q\nthis must not run\n");
      const exitCode = await run;

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toContain("Resume cancelled.\n");
      expect(fixture.stderr()).not.toContain("Resuming selected session");
      expect(fixture.stderr()).not.toContain("Keel interactive session");
      expect(
        await readFile(
          join(home, "sessions", "cancel-demo", "ledger.jsonl"),
          "utf8",
        ),
      ).not.toContain("this must not run");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given saved sessions exist in the current workspace,
    When input closes while the resume picker waits,
    Then Keel exits without an explicit cancellation message`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    await writeSessionLedger({
      home,
      id: "eof-demo",
      workspace: ledgerWorkspace,
      createdAt: "2026-01-01T00:00:00.000Z",
      records: [
        appendSessionRecordLine("2026-01-01T00:00:05.000Z", [
          {
            role: "user",
            content: "remember eof demo",
            origin: { type: "user_prompt" },
          },
          {
            role: "assistant",
            content: "Remembered eof demo.",
            toolCalls: [],
          },
        ]),
      ],
    });

    const input = new PassThrough();
    const fixture = createRuntime(["--resume", "--pick"], {
      cwd: workspace,
      env: {
        KEEL_PROVIDER: "fake",
        KEEL_HOME: home,
      },
      input,
      inputIsTTY: true,
      stderrIsTTY: false,
    });

    try {
      // When
      const run = runCliMain(fixture.runtime);
      await waitForCondition(
        () =>
          fixture.stdout().includes("Select session [1-1], or q to cancel:"),
        "resume picker did not render before EOF",
      );
      input.end();
      const exitCode = await run;

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).not.toContain("Resume cancelled.\n");
      expect(fixture.stderr()).not.toContain("Resuming selected session");
      expect(fixture.stderr()).not.toContain("Keel interactive session");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given the user starts an ephemeral interactive session,
    When the prompt completes and the user lists sessions,
    Then no persistent session is created`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const input = new PassThrough();
    input.end("hello\n");
    const fixture = createRuntime(["--ephemeral"], {
      cwd: workspace,
      env: {
        KEEL_PROVIDER: "fake",
        KEEL_FORCE_INTERACTIVE: "1",
        KEEL_HOME: home,
      },
      input,
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toBe("Remembered: hello\n");
      expect(fixture.stderr()).toBe("");

      const listFixture = createRuntime(["sessions"], {
        cwd: workspace,
        env: {
          KEEL_HOME: home,
        },
      });
      const listExitCode = await runCliMain(listFixture.runtime);
      expect(listExitCode).toBe(0);
      expect(listFixture.stdout()).toContain("No sessions for workspace ");
      expect(await sessionDirectoryNames(home)).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given the user starts a saved real interactive terminal session,
    When Keel renders the first prompt,
    Then the intro explains to keep follow-ups in the session and how to resume it`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-cli-tui-home-"));
    const input = new PassThrough();
    const fixture = createRuntime([], {
      env: { KEEL_PROVIDER: "fake", KEEL_HOME: home },
      input,
      inputIsTTY: true,
    });

    try {
      // When
      const run = runCliMain(fixture.runtime);
      await waitForCondition(
        () => fixture.stderr().includes("keel> "),
        "interactive session did not render the initial prompt",
      );
      input.end();
      const exitCode = await run;

      // Then
      expect(exitCode).toBe(0);
      const intro = expectDefaultSavedSessionIntro(fixture.stderr());
      expect(fixture.stderr()).toBe(`${intro}keel> \n`);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given the user starts an ephemeral real interactive terminal session,
    When Keel renders the first prompt,
    Then the intro explains the session is not resumable`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-cli-ephemeral-tui-home-"));
    const input = new PassThrough();
    const fixture = createRuntime(["--ephemeral"], {
      env: { KEEL_PROVIDER: "fake", KEEL_HOME: home },
      input,
      inputIsTTY: true,
    });

    try {
      // When
      const run = runCliMain(fixture.runtime);
      await waitForCondition(
        () => fixture.stderr() === `${EPHEMERAL_INTERACTIVE_INTRO}keel> `,
        "ephemeral interactive session did not render the initial prompt",
      );
      input.end();
      const exitCode = await run;

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stderr()).toBe(`${EPHEMERAL_INTERACTIVE_INTRO}keel> \n`);
      expect(fixture.stderr()).not.toContain("keel --resume");
      expect(await sessionDirectoryNames(home)).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given the project bash approval store is invalid while bash ask mode is off,
    When the user starts an interactive session,
    Then Keel ignores the approval store and starts normally`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    await writeFile(join(home, "bash-project-approvals.json"), "{", "utf8");
    const input = new PassThrough();
    input.end("hello\n");
    const fixture = createRuntime([], {
      env: {
        KEEL_PROVIDER: "fake",
        KEEL_FORCE_INTERACTIVE: "1",
        KEEL_HOME: home,
      },
      input,
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toBe("Remembered: hello\n");
      expect(fixture.stderr()).toBe("");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given the project bash approval store is invalid while bash ask mode is on,
    When the user starts an interactive session,
    Then Keel fails closed before resolving a provider`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const input = new PassThrough();
    await writeFile(join(home, "bash-project-approvals.json"), "{", "utf8");
    const fixture = createRuntime(["--bash-policy", "ask"], {
      env: {
        KEEL_HOME: home,
      },
      input,
      inputIsTTY: true,
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(fixture.stdout()).toBe("");
      expect(fixture.stderr()).toBe(
        `Error: cannot read bash project approvals ${join(
          home,
          "bash-project-approvals.json",
        )}: invalid JSON.\n`,
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given bash ask mode runs in a real interactive terminal session,
    When the user approves a command family for the project,
    Then the project approval is persisted for the current workspace`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-main-tui-bash-"));
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    execFileSync("git", ["init", "--quiet", "--initial-branch=main"], {
      cwd: workspace,
    });
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
        if (capturedBodies.length === 1) {
          res.write(
            sseToolCall("call_bash_project", "bash", {
              command: "git status --short",
            }),
          );
          res.write(sseToolFinish());
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        res.end(sseTextReplyWithUsage("Saved."));
      });
    });
    await listen(server);
    const input = new PassThrough();
    let approvalAnswered = false;
    const fixture = createRuntime(["--bash-policy", "ask"], {
      cwd: workspace,
      env: {
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        KEEL_HOME: home,
      },
      input,
      inputIsTTY: true,
      onStderr: (text) => {
        if (text.includes("Approve bash command?") && !approvalAnswered) {
          approvalAnswered = true;
          input.write("r\n");
          input.end();
        }
      },
    });

    try {
      // When
      const run = runCliMain(fixture.runtime);
      input.write("check status\n");
      const exitCode = await run;

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toBe("Saved.\n");
      expect(fixture.stderr()).toContain(
        "[r] allow command family for this project: git status",
      );

      const approvals = createRuntime(["approvals"], {
        cwd: workspace,
        env: { KEEL_HOME: home },
      });
      const approvalsExitCode = await runCliMain(approvals.runtime);
      expect(approvalsExitCode).toBe(0);
      expect(approvals.stdout()).toContain("Bash project approvals:\n");
      expect(approvals.stdout()).toContain("argv prefix: git status\n");
      expect(approvals.stderr()).toBe("");
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given the user runs a one-shot prompt,
    When the prompt completes,
    Then no persistent session is required`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const fixture = createRuntime(["hello"], {
      env: {
        KEEL_PROVIDER: "fake",
        KEEL_HOME: home,
      },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toBe("Hello from fake provider.\n");
      expect(await sessionDirectoryNames(home)).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given root AGENTS instructions exist,
    When the user sends an interactive prompt through CLI main,
    Then the provider receives those project instructions in the system prompt`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-main-agents-"));
    await writeFile(
      join(workspace, "AGENTS.md"),
      "Prefer BDD tests before production changes.\n",
      "utf8",
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
    input.end("fix the bug\n");
    const fixture = createRuntime([], {
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
      expect(system.content).toContain("Project instructions from AGENTS.md");
      expect(system.content).toContain(
        "> Prefer BDD tests before production changes.",
      );
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given root AGENTS escapes the workspace through a symlink,
    When the CLI main starts an interactive run,
    Then it returns the project instructions error before reading input`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-main-agents-"));
    const outside = await mkdtemp(join(tmpdir(), "keel-cli-main-outside-"));
    await writeFile(join(outside, "secret.txt"), "SECRET_OUTSIDE_WORKSPACE");
    await symlink(join(outside, "secret.txt"), join(workspace, "AGENTS.md"));
    const fixture = createRuntime([], {
      cwd: workspace,
      env: { KEEL_PROVIDER: "fake", KEEL_FORCE_INTERACTIVE: "1" },
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(fixture.stdout()).toBe("");
      expect(fixture.stderr()).toContain("cannot load AGENTS.md");
      expect(fixture.stderr()).toContain("outside the workspace");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test(`Given the user starts a real interactive terminal session,
    When the assistant uses a tool and then replies,
    Then the display keeps prompts and status separate from assistant output`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-main-tui-"));
    const home = await mkdtemp(join(tmpdir(), "keel-cli-main-tui-home-"));
    await writeFile(join(workspace, "note.txt"), "hello from note\n", "utf8");
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
        if (capturedBodies.length === 1) {
          res.write(sseToolCall("call_read", "read", { path: "note.txt" }));
          res.write(sseToolFinish());
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        res.end(sseTextReplyWithUsage("Read done."));
      });
    });
    await listen(server);
    const input = new PassThrough();
    const fixture = createRuntime([], {
      cwd: workspace,
      env: {
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        KEEL_HOME: home,
      },
      input,
      inputIsTTY: true,
    });

    try {
      // When
      const run = runCliMain(fixture.runtime);
      input.write("read note.txt\n");
      input.end();
      const exitCode = await run;

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toBe("Read done.\n");
      const intro = expectDefaultSavedSessionIntro(fixture.stderr());
      expect(fixture.stderr()).toBe(
        [
          intro,
          "keel> read note.txt\n",
          "status: Tool: read note.txt\n",
          "assistant:\n",
        ].join(""),
      );
      const secondRequest = requestWithMessagesSchema.parse(capturedBodies[1]);
      expect(secondRequest.messages).toContainEqual({
        role: "tool",
        tool_call_id: "call_read",
        content: "hello from note\n",
      });
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given the provider retries during a real interactive terminal session,
    When the assistant replies after the retry,
    Then the display keeps the retry status separate from assistant output`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-cli-main-tui-home-"));
    let requestCount = 0;
    const server = createServer((req, res) => {
      if (req.url !== "/chat/completions") {
        res.writeHead(404);
        res.end();
        return;
      }

      req.resume();
      req.on("end", () => {
        requestCount++;
        if (requestCount === 1) {
          res.writeHead(429, {
            "Content-Type": "application/json",
            "Retry-After": "0",
          });
          res.end(JSON.stringify({ error: { message: "Rate limited" } }));
          return;
        }

        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.end(sseTextReplyWithUsage("Recovered."));
      });
    });
    await listen(server);
    const input = new PassThrough();
    const fixture = createRuntime([], {
      env: {
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        KEEL_HOME: home,
      },
      input,
      inputIsTTY: true,
    });

    try {
      // When
      const run = runCliMain(fixture.runtime);
      input.write("hello\n");
      input.end();
      const exitCode = await run;

      // Then
      expect(exitCode).toBe(0);
      expect(requestCount).toBe(2);
      expect(fixture.stdout()).toBe("Recovered.\n");
      const intro = expectDefaultSavedSessionIntro(fixture.stderr());
      expect(fixture.stderr()).toBe(
        [
          intro,
          "keel> hello\n",
          "status: Provider retry: DeepSeek rate limited (attempt 1/4 in 0ms)\n",
          "assistant:\n",
        ].join(""),
      );
    } finally {
      await close(server);
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a tool fails during a real interactive terminal session,
    When the assistant replies after seeing the failure,
    Then the display keeps the failed tool status separate from assistant output`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-main-tui-fail-"));
    const home = await mkdtemp(join(tmpdir(), "keel-cli-main-tui-home-"));
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
        if (capturedBodies.length === 1) {
          res.write(sseToolCall("call_read", "read", { path: "missing.txt" }));
          res.write(sseToolFinish());
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        res.end(sseTextReplyWithUsage("Handled failure."));
      });
    });
    await listen(server);
    const input = new PassThrough();
    const fixture = createRuntime([], {
      cwd: workspace,
      env: {
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        KEEL_HOME: home,
      },
      input,
      inputIsTTY: true,
    });

    try {
      // When
      const run = runCliMain(fixture.runtime);
      input.write("read missing.txt\n");
      input.end();
      const exitCode = await run;

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toBe("Handled failure.\n");
      const intro = expectDefaultSavedSessionIntro(fixture.stderr());
      expect(fixture.stderr()).toBe(
        [
          intro,
          "keel> read missing.txt\n",
          "status: Tool: read missing.txt\n",
          "status: Tool failed: read missing.txt\n",
          "assistant:\n",
        ].join(""),
      );
      const secondRequest = requestWithMessagesSchema.parse(capturedBodies[1]);
      expect(secondRequest.messages).toContainEqual({
        role: "tool",
        tool_call_id: "call_read",
        content: expect.stringContaining("Tool failed: read failed"),
      });
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a real interactive terminal session artifacts a large tool output,
    When the assistant replies after the artifact-backed turn,
    Then the display shows the artifact inspection command as a status line`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-main-tui-artifact-"),
    );
    const home = await mkdtemp(join(tmpdir(), "keel-cli-main-tui-home-"));
    await writeFile(
      join(workspace, "large.log"),
      oversizedReadFixture({
        start: "INTERACTIVE_LARGE_START",
        fill: "i",
        end: "INTERACTIVE_LARGE_END",
      }),
      "utf8",
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
        if (capturedBodies.length === 1) {
          res.write(sseToolCall("call_read", "read", { path: "large.log" }));
          res.write(sseToolFinish());
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        const secondRequest = requestWithMessagesSchema.parse(
          capturedBodies[1],
        );
        const toolMessage = secondRequest.messages?.find(
          (message) =>
            message.role === "tool" && message.tool_call_id === "call_read",
        );
        const artifactRef = toolMessage?.content?.match(
          /tool-output:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+/u,
        )?.[0];
        res.end(
          sseTextReplyWithUsage(
            artifactRef === undefined
              ? "Artifact missing."
              : `Artifact ready ${artifactRef}`,
          ),
        );
      });
    });
    await listen(server);
    const input = new PassThrough();
    const fixture = createRuntime([], {
      cwd: workspace,
      env: {
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        KEEL_HOME: home,
      },
      input,
      inputIsTTY: true,
    });

    try {
      // When
      const run = runCliMain(fixture.runtime);
      input.write("read large.log\n");
      input.end();
      const exitCode = await run;

      // Then
      expect(exitCode).toBe(0);
      const artifactRef = fixture
        .stdout()
        .match(/tool-output:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+/u)?.[0];
      expect(artifactRef).toBeDefined();
      expect(fixture.stderr()).toContain("status: Tool: read large.log\n");
      expect(fixture.stderr()).toContain(
        `status: Tool output artifact: ${artifactRef} (keel artifacts show ${artifactRef})\n`,
      );
      expect(fixture.stderr()).toContain("assistant:\n");
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given stderr is redirected from a real interactive terminal session,
    When the assistant uses a tool and then replies,
    Then the stderr log keeps prompts and status on separate lines`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-main-tui-log-"));
    const home = await mkdtemp(join(tmpdir(), "keel-cli-main-tui-home-"));
    await writeFile(join(workspace, "note.txt"), "hello from note\n", "utf8");
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
        if (capturedBodies.length === 1) {
          res.write(sseToolCall("call_read", "read", { path: "note.txt" }));
          res.write(sseToolFinish());
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        res.end(sseTextReplyWithUsage("Read done."));
      });
    });
    await listen(server);
    const input = new PassThrough();
    const fixture = createRuntime([], {
      cwd: workspace,
      env: {
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        KEEL_HOME: home,
      },
      input,
      inputIsTTY: true,
      stderrIsTTY: false,
    });

    try {
      // When
      const run = runCliMain(fixture.runtime);
      input.write("read note.txt\n");
      input.end();
      const exitCode = await run;

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toBe("Read done.\n");
      const intro = expectDefaultSavedSessionIntro(fixture.stderr());
      expect(fixture.stderr()).toBe(
        [
          intro,
          "keel> \n",
          "status: Tool: read note.txt\n",
          "assistant:\n",
        ].join(""),
      );
      const secondRequest = requestWithMessagesSchema.parse(capturedBodies[1]);
      expect(secondRequest.messages).toContainEqual({
        role: "tool",
        tool_call_id: "call_read",
        content: "hello from note\n",
      });
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given bash approval is required in a real interactive terminal session,
    When the assistant asks to run a command,
    Then the approval prompt is separated from the input prompt and still accepts a fresh answer`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-main-tui-bash-"));
    const home = await mkdtemp(join(tmpdir(), "keel-cli-main-tui-home-"));
    const command =
      "node -e \"require('node:fs').writeFileSync('approved.txt', 'yes')\"";
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
        if (capturedBodies.length === 1) {
          res.write(sseToolCall("call_bash", "bash", { command }));
          res.write(sseToolFinish());
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        res.end(sseTextReplyWithUsage("Ran."));
      });
    });
    await listen(server);
    const input = new PassThrough();
    let approvalAnswered = false;
    const fixture = createRuntime(["--bash-policy", "ask"], {
      cwd: workspace,
      env: {
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        KEEL_HOME: home,
      },
      input,
      inputIsTTY: true,
      onStderr: (text) => {
        if (text.includes("Approve bash command?") && !approvalAnswered) {
          approvalAnswered = true;
          input.write("y\n");
          input.end();
        }
      },
    });

    try {
      // When
      const run = runCliMain(fixture.runtime);
      input.write("run approved command\n");
      const exitCode = await run;

      // Then
      expect(exitCode).toBe(0);
      expect(await readFile(join(workspace, "approved.txt"), "utf8")).toBe(
        "yes",
      );
      expect(fixture.stdout()).toBe("Ran.\n");
      const intro = expectDefaultSavedSessionIntro(fixture.stderr());
      expect(fixture.stderr()).toContain(
        `${intro}keel> run approved command\nstatus: Tool: bash ${command}\nApprove bash command?\n`,
      );
      expect(fixture.stderr()).toContain("assistant:\n");
      const secondRequest = requestWithMessagesSchema.parse(capturedBodies[1]);
      expect(secondRequest.messages).toContainEqual({
        role: "tool",
        tool_call_id: "call_bash",
        content: "Exit code: 0\n\n(no output)",
      });
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a real interactive terminal session handles a local command,
    When the user asks for help and then sends a prompt,
    Then the next input prompt is still visible before the assistant replies`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-cli-main-tui-home-"));
    const input = new PassThrough();
    const fixture = createRuntime([], {
      env: { KEEL_PROVIDER: "fake", KEEL_HOME: home },
      input,
      inputIsTTY: true,
    });

    try {
      // When
      const run = runCliMain(fixture.runtime);
      input.write("/help\n");
      await waitForCondition(() => {
        const stderr = fixture.stderr();
        return (
          stderr.includes("Commands: /status /tasks /diff /undo /help\n") &&
          stderr === `${savedSessionIntroFromStderr(stderr)}keel> /help\nkeel> `
        );
      }, "interactive help did not return to a visible prompt");
      input.end("hello\n");
      const exitCode = await run;

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toContain("Interactive commands:\n");
      expect(fixture.stdout()).toContain(
        "Keep one saved session open for a task; send follow-ups or corrections here until it is done.",
      );
      expect(fixture.stdout()).toContain("Remembered: hello\n");
      const intro = expectDefaultSavedSessionIntro(fixture.stderr());
      expect(fixture.stderr()).toContain(
        [intro, "keel> /help\n", "keel> hello\n", "assistant:\n"].join(""),
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a real interactive terminal session waits at an empty prompt,
    When stdin closes,
    Then the prompt line is closed before exit`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-cli-main-tui-home-"));
    const input = new PassThrough();
    const fixture = createRuntime([], {
      env: { KEEL_PROVIDER: "fake", KEEL_HOME: home },
      input,
      inputIsTTY: true,
    });

    try {
      // When
      const run = runCliMain(fixture.runtime);
      await waitForCondition(
        () => fixture.stderr().includes("keel> "),
        "interactive session did not render the initial prompt",
      );
      input.end();
      const exitCode = await run;

      // Then
      expect(exitCode).toBe(0);
      expect(fixture.stdout()).toBe("");
      const intro = expectDefaultSavedSessionIntro(fixture.stderr());
      expect(fixture.stderr()).toBe(`${intro}keel> \n`);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given interactive mode has cost tracking enabled,
    When the user sends one prompt,
    Then the CLI main prints the turn cost report`, async () => {
    // Given
    const input = new PassThrough();
    input.end("hello\n");
    const fixture = createRuntime(["--max-cost", "1"], {
      env: { KEEL_PROVIDER: "fake", KEEL_FORCE_INTERACTIVE: "1" },
      input,
    });

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(0);
    expect(fixture.stdout()).toBe("Remembered: hello\n");
    expect(fixture.stderr()).toBe("Cost: $0.000000 (budget $1.0000)\n");
  });

  test(`Given an interactive session is idle,
    When the CLI main receives SIGINT,
    Then it closes the session as interrupted`, async () => {
    // Given
    const input = new PassThrough();
    const sigint: SigintCapture = { handler: null };
    const fixture = createRuntime([], {
      env: { KEEL_PROVIDER: "fake", KEEL_FORCE_INTERACTIVE: "1" },
      input,
      onSigint: (handler) => {
        sigint.handler = handler;
      },
      offSigint: (handler) => {
        if (sigint.handler === handler) sigint.handler = null;
      },
    });

    // When
    const run = runCliMain(fixture.runtime);
    const handler = sigint.handler;
    if (handler === null) {
      throw new Error("SIGINT handler was not registered");
    }
    handler();
    const exitCode = await run;

    // Then
    expect(exitCode).toBe(130);
    expect(fixture.stdout()).toBe("\n");
    expect(fixture.stderr()).toBe("");
    expect(sigint.handler).toBeNull();
  });

  test(`Given interactive mode resolves a provider configuration error,
    When the user sends a prompt,
    Then the CLI main tells the user how to configure provider credentials`, async () => {
    // Given
    const input = new PassThrough();
    input.end("hello\n");
    const fixture = createRuntime([], {
      env: {
        KEEL_FORCE_INTERACTIVE: "1",
        KEEL_PROVIDER: "deepseek",
        DEEPSEEK_API_KEY: "",
      },
      input,
    });

    // When
    const exitCode = await runCliMain(fixture.runtime);

    // Then
    expect(exitCode).toBe(1);
    expect(fixture.stdout()).toBe("");
    for (const line of DEEPSEEK_MISSING_API_KEY_GUIDANCE) {
      expect(fixture.stderr()).toContain(line);
    }
  });

  test(`Given a default interactive session fails before the first completed turn,
    When the provider configuration is invalid,
    Then the CLI main does not create an empty session ledger`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const input = new PassThrough();
    input.end("hello\n");
    const fixture = createRuntime([], {
      env: {
        KEEL_FORCE_INTERACTIVE: "1",
        KEEL_PROVIDER: "deepseek",
        DEEPSEEK_API_KEY: "",
        KEEL_HOME: home,
      },
      input,
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(fixture.stdout()).toBe("");
      for (const line of DEEPSEEK_MISSING_API_KEY_GUIDANCE) {
        expect(fixture.stderr()).toContain(line);
      }
      expect(await sessionDirectoryNames(home)).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a named session fails before the first completed turn,
    When the provider configuration is invalid,
    Then the CLI main does not create an empty session ledger`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const input = new PassThrough();
    input.end("hello\n");
    const fixture = createRuntime(["--session", "provider-fails"], {
      env: {
        KEEL_FORCE_INTERACTIVE: "1",
        KEEL_PROVIDER: "deepseek",
        DEEPSEEK_API_KEY: "",
        KEEL_HOME: home,
      },
      input,
    });

    try {
      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(fixture.stdout()).toBe("");
      for (const line of DEEPSEEK_MISSING_API_KEY_GUIDANCE) {
        expect(fixture.stderr()).toContain(line);
      }
      expect(await sessionDirectoryNames(home)).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
