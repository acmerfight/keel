import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
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

  test.each([
    {
      args: ["--provider=fake", "--bash-policy=deny"],
      expected: "  active model: fake/(default model)\n",
    },
    {
      args: ["--model=configured-model", "--bash-policy=deny"],
      expected: "  active model: (default provider)/configured-model\n",
    },
  ])(`Given partial provider or model flags are used before the first prompt,
    When the user asks for status,
    Then the snapshot reports the configured selection`, async (testCase) => {
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
  });

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
    const input = new PassThrough();
    const fixture = createRuntime([], {
      env: { KEEL_PROVIDER: "fake" },
      input,
      inputIsTTY: true,
    });

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
    execFileSync("git", ["init", "--quiet"], { cwd: workspace });
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
    }
  });

  test(`Given the provider retries during a real interactive terminal session,
    When the assistant replies after the retry,
    Then the display keeps the retry status separate from assistant output`, async () => {
    // Given
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
    }
  });

  test(`Given a tool fails during a real interactive terminal session,
    When the assistant replies after seeing the failure,
    Then the display keeps the failed tool status separate from assistant output`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-main-tui-fail-"));
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
    }
  });

  test(`Given bash approval is required in a real interactive terminal session,
    When the assistant asks to run a command,
    Then the approval prompt is separated from the input prompt and still accepts a fresh answer`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-main-tui-bash-"));
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
    }
  });

  test(`Given a real interactive terminal session handles a local command,
    When the user asks for help and then sends a prompt,
    Then the next input prompt is still visible before the assistant replies`, async () => {
    // Given
    const input = new PassThrough();
    const fixture = createRuntime([], {
      env: { KEEL_PROVIDER: "fake" },
      input,
      inputIsTTY: true,
    });

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
  });

  test(`Given a real interactive terminal session waits at an empty prompt,
    When stdin closes,
    Then the prompt line is closed before exit`, async () => {
    // Given
    const input = new PassThrough();
    const fixture = createRuntime([], {
      env: { KEEL_PROVIDER: "fake" },
      input,
      inputIsTTY: true,
    });

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
