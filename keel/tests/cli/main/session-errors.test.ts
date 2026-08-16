import { mkdirSync, rmSync } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import { runCliMain } from "../../../src/cli/index.ts";
import { acquireSessionLock } from "../../../src/cli/session-store.ts";
import { createRuntime } from "../../../src/testing/cli-runtime-fixtures.ts";
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
  rootGraph,
  storedMessages,
  writeSessionLedger,
} from "../../../src/testing/session-ledger-fixtures.ts";

describe("CLI Main - Session Errors", () => {
  test.each(["next prompt", "bash approval"] as const)(
    `Given queued-input persistence fails from a real filesystem race before the %s,
    When the failure originates in the asynchronous input event,
    Then the named session exits through the normal CLI error boundary instead of an uncaught exception`,
    async (failureConsumer) => {
      // Given
      const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
      const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
      const sessionId = `queued-failure-${failureConsumer.replace(" ", "-")}`;
      const ledgerPath = join(home, "sessions", sessionId, "ledger.jsonl");
      const command =
        "node -e \"require('node:fs').writeFileSync('must-not-run.txt', 'bad')\"";
      const input = new PassThrough();
      const server = createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          JSON.parse(body);
          rmSync(ledgerPath, { force: true });
          mkdirSync(ledgerPath, { recursive: true });
          input.write("queue while the turn is active\n");
          input.write("ignore input after persistence fails\n");
          rmSync(ledgerPath, { recursive: true, force: true });
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          if (failureConsumer === "bash approval") {
            res.write(sseToolCall("blocked_bash", "bash", { command }));
            res.write(sseToolFinish());
            res.end("data: [DONE]\n\n");
            return;
          }
          res.end(sseTextReplyWithUsage("Turn completed."));
        });
      });
      await listen(server);
      const fixture = createRuntime(
        [
          "--session",
          sessionId,
          ...(failureConsumer === "bash approval"
            ? ["--bash-policy", "ask"]
            : []),
        ],
        {
          cwd: workspace,
          env: {
            KEEL_FORCE_INTERACTIVE: "1",
            KEEL_HOME: home,
            DEEPSEEK_API_KEY: "test-key",
            DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
          },
          input,
          inputIsTTY: failureConsumer === "bash approval",
        },
      );

      try {
        // When
        const run = runCliMain(fixture.runtime);
        setTimeout(() => input.write("start the turn\n"), 0);
        const exitCode = await run;

        // Then
        expect(exitCode).toBe(1);
        expect(fixture.stderr()).toMatch(
          /Error: (?:cannot write session ledger|completed durable Task .* is missing its settled final response)/u,
        );
        expect(fixture.stderr()).not.toContain("UNCAUGHT");
        expect(fixture.stderr()).not.toContain("unexpected runtime failure");
        await expect(
          access(join(workspace, "must-not-run.txt")),
        ).rejects.toThrow();
      } finally {
        input.end();
        await close(server);
        await rm(workspace, { recursive: true, force: true });
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  test(`Given a sessions fork point is beyond the restored user messages,
    When the user forks a source session at that point,
    Then the CLI fails with the sessions fork option name before creating the target ledger`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    await writeSessionLedger({
      home,
      id: "source",
      workspace: ledgerWorkspace,
      createdAt: "2026-01-01T00:00:00.000Z",
      records: [
        appendSessionRecordLine("2026-01-01T00:00:01.000Z", [
          {
            role: "user",
            content: "remember alpha",
            origin: { type: "user_prompt" },
          },
          {
            role: "assistant",
            content: "Remembered: remember alpha",
            toolCalls: [],
          },
        ]),
      ],
    });
    const forkRun = createRuntime(
      [
        "sessions",
        "fork",
        "source",
        "target",
        "--before-message",
        "msg_missing",
      ],
      {
        cwd: workspace,
        env: {
          KEEL_HOME: home,
        },
      },
    );

    try {
      // When
      const forkExitCode = await runCliMain(forkRun.runtime);

      // Then
      expect(forkExitCode).toBe(1);
      expect(forkRun.stdout()).toBe("");
      expect(forkRun.stderr()).toBe(
        'Error: cannot fork session "target": --before-message msg_missing does not match a restored message id in session "source".\n',
      );
      await expect(
        access(join(home, "sessions", "target", "ledger.jsonl")),
      ).rejects.toThrow();
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a fork point is beyond the restored user messages,
    When the user forks a source session at that point,
    Then the CLI fails before creating the target ledger`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const sourceInput = new PassThrough();
    sourceInput.end("remember alpha\n");
    const sourceRun = createRuntime(["--session", "source"], {
      cwd: workspace,
      env: {
        KEEL_PROVIDER: "fake",
        KEEL_FORCE_INTERACTIVE: "1",
        KEEL_HOME: home,
      },
      input: sourceInput,
    });

    try {
      const sourceExitCode = await runCliMain(sourceRun.runtime);
      const forkInput = new PassThrough();
      forkInput.end("what did I ask you to remember?\n");
      const forkRun = createRuntime(
        [
          "--resume",
          "source",
          "--fork",
          "target",
          "--fork-before-message",
          "msg_missing",
        ],
        {
          cwd: workspace,
          env: {
            KEEL_PROVIDER: "fake",
            KEEL_FORCE_INTERACTIVE: "1",
            KEEL_HOME: home,
          },
          input: forkInput,
        },
      );

      // When
      const forkExitCode = await runCliMain(forkRun.runtime);

      // Then
      expect(sourceExitCode).toBe(0);
      expect(forkExitCode).toBe(1);
      expect(forkRun.stdout()).toBe("");
      expect(forkRun.stderr()).toBe(
        'Error: cannot fork session "target": --fork-before-message msg_missing does not match a restored message id in session "source".\n',
      );
      await expect(
        access(join(home, "sessions", "target", "ledger.jsonl")),
      ).rejects.toThrow();
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given the fork target session already exists,
    When the user forks a source session into that target,
    Then the CLI fails without overwriting the target ledger`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const sourceInput = new PassThrough();
    sourceInput.end("remember source\n");
    const sourceRun = createRuntime(["--session", "source"], {
      cwd: workspace,
      env: {
        KEEL_PROVIDER: "fake",
        KEEL_FORCE_INTERACTIVE: "1",
        KEEL_HOME: home,
      },
      input: sourceInput,
    });
    const targetInput = new PassThrough();
    targetInput.end("remember target\n");
    const targetRun = createRuntime(["--session", "target"], {
      cwd: workspace,
      env: {
        KEEL_PROVIDER: "fake",
        KEEL_FORCE_INTERACTIVE: "1",
        KEEL_HOME: home,
      },
      input: targetInput,
    });

    try {
      const sourceExitCode = await runCliMain(sourceRun.runtime);
      const targetExitCode = await runCliMain(targetRun.runtime);
      const targetLedgerPath = join(home, "sessions", "target", "ledger.jsonl");
      const targetLedgerBefore = await readFile(targetLedgerPath, "utf8");
      const forkInput = new PassThrough();
      forkInput.end("what did I ask you to remember?\n");
      const forkRun = createRuntime(
        ["--resume", "source", "--fork", "target"],
        {
          cwd: workspace,
          env: {
            KEEL_PROVIDER: "fake",
            KEEL_FORCE_INTERACTIVE: "1",
            KEEL_HOME: home,
          },
          input: forkInput,
        },
      );

      // When
      const forkExitCode = await runCliMain(forkRun.runtime);

      // Then
      expect(sourceExitCode).toBe(0);
      expect(targetExitCode).toBe(0);
      expect(forkExitCode).toBe(1);
      expect(forkRun.stdout()).toBe("");
      expect(forkRun.stderr()).toBe(
        'Error: session "target" already exists. Use --resume target to continue it.\n',
      );
      expect(await readFile(targetLedgerPath, "utf8")).toBe(targetLedgerBefore);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given the fork source session is already active,
    When the user forks it into a new session,
    Then the CLI fails before creating the target ledger`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const activeLock = acquireSessionLock({
      sessionId: "source",
      runtime: {
        env: (key) => (key === "KEEL_HOME" ? home : undefined),
        now: () => 0,
      },
    });
    const input = new PassThrough();
    input.end("what did I ask you to remember?\n");
    const fixture = createRuntime(["--resume", "source", "--fork", "target"], {
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
      expect(exitCode).toBe(1);
      expect(fixture.stdout()).toBe("");
      expect(fixture.stderr()).toBe(
        'Error: session "source" is already active. Stop the other Keel process before using it again.\n',
      );
      await expect(
        access(join(home, "sessions", "target", "ledger.jsonl")),
      ).rejects.toThrow();
    } finally {
      activeLock.release();
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given the user resumes an oversized session with a bounded snapshot,
    When queued input is restored from that snapshot,
    Then the CLI runs it against the snapshotted transcript`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const ledgerPath = join(
      home,
      "sessions",
      "snapshot-queued",
      "ledger.jsonl",
    );
    await mkdir(join(home, "sessions", "snapshot-queued"), {
      recursive: true,
    });
    await writeFile(
      ledgerPath,
      `${JSON.stringify({
        schemaVersion: 9,
        type: "session",
        id: "snapshot-queued",
        createdAt: "1970-01-01T00:00:00.000Z",
        workspace: ledgerWorkspace,
        graph: rootGraph("snapshot-queued"),
      })}\n`,
      "utf8",
    );
    await truncate(ledgerPath, 32 * 1024 * 1024 + 1);
    await writeFile(
      ledgerPath,
      `\n${JSON.stringify({
        schemaVersion: 9,
        type: "snapshot",
        timestamp: "1970-01-01T00:00:00.001Z",
        reason: "size_threshold",
        messages: storedMessages(
          [
            {
              role: "user",
              content: "remember alpha",
              origin: { type: "user_prompt" },
            },
            {
              role: "assistant",
              content: "Remembered: remember alpha",
              toolCalls: [],
            },
          ],
          "snapshot-queued",
        ),
        pendingInputs: [
          {
            id: "snapshot-question",
            timestamp: "1970-01-01T00:00:00.002Z",
            sequence: 2,
            line: "what did I ask you to remember?",
          },
        ],
        skillStateCheckpoints: [
          {
            messageOrdinal: 0,
            skillActivations: [],
            activeSkillIds: [],
          },
        ],
      })}\n`,
      { encoding: "utf8", flag: "a" },
    );
    const input = new PassThrough();
    input.end();
    const fixture = createRuntime(["--resume", "snapshot-queued"], {
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
      expect(fixture.stdout()).toBe("Earlier you said: remember alpha\n");
      expect(fixture.stderr()).toBe("");
      const ledger = await readFile(ledgerPath, "utf8");
      expect(ledger).toContain('"consumedInputIds":["snapshot-question"]');
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a named interactive session receives multiple prompts,
    When the prompts complete in one process,
    Then all completed turns are persisted to the same ledger`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const input = new PassThrough();
    input.end("remember beta\nwhat did I ask you to remember?\n");
    const fixture = createRuntime(["--session", "multi-turn"], {
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
      expect(fixture.stdout()).toContain("Remembered: remember beta\n");
      expect(fixture.stdout()).toContain("Earlier you said: remember beta\n");
      const ledger = await readFile(
        join(home, "sessions", "multi-turn", "ledger.jsonl"),
        "utf8",
      );
      const ledgerLines = ledger
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      const admittedInput = ledgerLines.find(
        (line) => line.type === "input_admitted",
      );
      expect(admittedInput).toMatchObject({
        type: "input_admitted",
        line: "what did I ask you to remember?",
      });
      const consumingAdmissions = ledgerLines.filter(
        (line) =>
          Array.isArray(line.consumedInputIds) &&
          line.consumedInputIds.includes(admittedInput.id),
      );
      expect(consumingAdmissions).toHaveLength(1);
      expect(consumingAdmissions[0]).toMatchObject({
        type: "task_admitted",
        consumedInputIds: [admittedInput.id],
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a named session is already active,
    When another interactive process resumes the same session,
    Then the CLI fails before reading prompts or writing a ledger`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const activeLock = acquireSessionLock({
      sessionId: "active",
      runtime: {
        env: (key) => (key === "KEEL_HOME" ? home : undefined),
        now: () => 0,
      },
    });
    const input = new PassThrough();
    input.end("remember should-not-run\n");
    const fixture = createRuntime(["--resume", "active"], {
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
      expect(exitCode).toBe(1);
      expect(fixture.stdout()).toBe("");
      expect(fixture.stderr()).toBe(
        'Error: session "active" is already active. Stop the other Keel process before using it again.\n',
      );
      await expect(
        access(join(home, "sessions", "active", "ledger.jsonl")),
      ).rejects.toThrow();
    } finally {
      activeLock.release();
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given the user resumes a malformed session,
    When the CLI main starts,
    Then it fails closed before reading an interactive prompt`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    await mkdir(join(home, "sessions", "broken"), { recursive: true });
    await writeFile(
      join(home, "sessions", "broken", "ledger.jsonl"),
      [
        JSON.stringify({
          schemaVersion: 9,
          type: "session",
          id: "broken",
          createdAt: "1970-01-01T00:00:00.000Z",
          workspace,
          graph: rootGraph("broken"),
        }),
        "{not-json",
      ].join("\n"),
      "utf8",
    );
    const input = new PassThrough();
    input.end("this should not run\n");
    const fixture = createRuntime(["--resume", "broken"], {
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
      expect(exitCode).toBe(1);
      expect(fixture.stdout()).toBe("");
      expect(fixture.stderr()).toContain(
        'Error: cannot resume session "broken"',
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given the user resumes a session ledger larger than the resume cap,
    When the CLI main starts,
    Then it reports recovery guidance before parsing the ledger`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const ledgerPath = join(home, "sessions", "huge", "ledger.jsonl");
    await mkdir(join(home, "sessions", "huge"), { recursive: true });
    await writeFile(
      ledgerPath,
      `${JSON.stringify({
        schemaVersion: 9,
        type: "session",
        id: "huge",
        createdAt: "1970-01-01T00:00:00.000Z",
        workspace,
        graph: rootGraph("huge"),
      })}\n{not-json`,
      "utf8",
    );
    await truncate(ledgerPath, 32 * 1024 * 1024 + 1);
    const input = new PassThrough();
    input.end("this should not run\n");
    const fixture = createRuntime(["--resume", "huge"], {
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
      expect(exitCode).toBe(1);
      expect(fixture.stdout()).toBe("");
      expect(fixture.stderr()).toContain(
        `Error: cannot resume session "huge": cannot load session ledger ${ledgerPath}: ledger is too large to resume safely`,
      );
      expect(fixture.stderr()).toContain(
        "33,554,433 bytes; limit 33,554,432 bytes",
      );
      expect(fixture.stderr()).toContain(
        "Start a new session with --session <new-id>",
      );
      expect(fixture.stderr()).not.toContain("not valid JSON");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
});
