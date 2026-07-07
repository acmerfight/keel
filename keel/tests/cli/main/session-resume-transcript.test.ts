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
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import { runCliMain } from "../../../src/cli/index.ts";
import {
  createRuntime,
  withTimeout,
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
  rootGraph,
  writeSessionLedger,
} from "../../../src/testing/session-ledger-fixtures.ts";

describe("CLI Main - Session Resume Transcript", () => {
  test(`Given a provider emits invalid update_plan arguments,
    When the model repairs the plan after the tool failure,
    Then the interactive session continues without a provider protocol crash`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    let requestCount = 0;
    const providerRequests: unknown[] = [];
    const server = createServer((req, res) => {
      if (req.url !== "/chat/completions") {
        res.writeHead(404);
        res.end();
        return;
      }

      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      req.on("end", () => {
        requestCount++;
        providerRequests.push(
          JSON.parse(Buffer.concat(chunks).toString("utf8")),
        );
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        if (requestCount === 1) {
          res.write(
            sseToolCall("call_bad_plan", "update_plan", {
              plan: [
                { step: "Inspect request", status: "in_progress" },
                { step: "Answer user", status: "in_progress" },
              ],
            }),
          );
          res.write(sseToolFinish());
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        if (requestCount === 2) {
          res.write(
            sseToolCall("call_fixed_plan", "update_plan", {
              plan: [
                { step: "Inspect request", status: "completed" },
                { step: "Answer user", status: "in_progress" },
              ],
            }),
          );
          res.write(sseToolFinish());
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        res.end(sseTextReplyWithUsage("Recovered."));
      });
    });
    await listen(server);
    const input = new PassThrough();
    input.end("start task\n");
    const fixture = createRuntime(["--session", "task-progress-recovery"], {
      cwd: workspace,
      env: {
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        KEEL_PROVIDER: "deepseek",
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
      expect(fixture.stdout()).toBe("Recovered.\n");
      expect(fixture.stderr()).not.toContain(
        "update_plan tool call has invalid arguments",
      );
      expect(fixture.stderr()).toContain(
        "Task progress: 1/2 completed; current: Answer user",
      );
      expect(JSON.stringify(providerRequests[1])).toContain(
        "Tool failed: update_plan failed: invalid arguments",
      );
      expect(JSON.stringify(providerRequests[1])).toContain(
        "At most one task can be in_progress",
      );
      const ledgerLines = (
        await readFile(
          join(home, "sessions", "task-progress-recovery", "ledger.jsonl"),
          "utf8",
        )
      )
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(
        ledgerLines.filter((line) => line.type === "task_progress"),
      ).toEqual([
        {
          schemaVersion: 2,
          type: "task_progress",
          timestamp: expect.any(String),
          messageOrdinal: 5,
          tasks: [
            { step: "Inspect request", status: "completed" },
            { step: "Answer user", status: "in_progress" },
          ],
        },
      ]);

      const resumeInput = new PassThrough();
      resumeInput.end("/tasks\n");
      const resumeFixture = createRuntime(
        ["--resume", "task-progress-recovery"],
        {
          cwd: workspace,
          env: {
            KEEL_FORCE_INTERACTIVE: "1",
            KEEL_HOME: home,
          },
          input: resumeInput,
        },
      );
      const resumeExitCode = await runCliMain(resumeFixture.runtime);
      expect(resumeExitCode).toBe(0);
      expect(resumeFixture.stdout()).toContain(
        "  2. [in_progress] Answer user",
      );
      expect(resumeFixture.stderr()).toBe("");
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a named interactive session receives task progress from the provider,
    When the turn completes,
    Then the session ledger persists the deterministic task checkpoint`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    let requestCount = 0;
    const server = createServer((req, res) => {
      if (req.url !== "/chat/completions") {
        res.writeHead(404);
        res.end();
        return;
      }

      req.resume();
      requestCount++;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      if (requestCount === 1) {
        res.write(
          sseToolCall("call_plan", "update_plan", {
            plan: [
              {
                step: "Inspect the prompt",
                status: "in_progress",
              },
            ],
          }),
        );
        res.write(sseToolFinish());
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      res.end(sseTextReplyWithUsage("Done."));
    });
    await listen(server);
    const input = new PassThrough();
    input.end("start task\n");
    const fixture = createRuntime(["--session", "task-progress"], {
      cwd: workspace,
      env: {
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
        KEEL_PROVIDER: "deepseek",
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
      expect(fixture.stdout()).toBe("Done.\n");
      expect(fixture.stderr()).toContain("Task progress:");
      const ledgerLines = (
        await readFile(
          join(home, "sessions", "task-progress", "ledger.jsonl"),
          "utf8",
        )
      )
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(ledgerLines).toContainEqual({
        schemaVersion: 2,
        type: "task_progress",
        timestamp: expect.any(String),
        messageOrdinal: 3,
        tasks: [{ step: "Inspect the prompt", status: "in_progress" }],
      });
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given the user starts and resumes a named interactive session,
    When follow-up prompts are sent after process restart,
    Then the provider receives the prior transcript and persists queued input`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
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
      secondInput.end("what did I ask you to remember?\nremember beta\n");
      const secondRun = createRuntime(["--resume=demo"], {
        cwd: workspace,
        env: {
          KEEL_PROVIDER: "fake",
          KEEL_FORCE_INTERACTIVE: "1",
          KEEL_HOME: home,
        },
        input: secondInput,
      });

      // When
      const secondExitCode = await runCliMain(secondRun.runtime);

      // Then
      expect(firstExitCode).toBe(0);
      expect(firstRun.stdout()).toBe("Remembered: remember alpha\n");
      expect(secondExitCode).toBe(0);
      expect(secondRun.stdout()).toContain(
        "Earlier you said: remember alpha\n",
      );
      expect(secondRun.stdout()).toContain("Remembered: remember beta\n");
      expect(firstRun.stderr()).toBe("");
      expect(secondRun.stderr()).toBe("");
      const ledgerLines = (
        await readFile(join(home, "sessions", "demo", "ledger.jsonl"), "utf8")
      )
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      const admittedInput = ledgerLines.find(
        (line) => line.type === "input_admitted",
      );
      expect(admittedInput).toMatchObject({
        type: "input_admitted",
        line: "remember beta",
      });
      const consumingAppend = ledgerLines.find((line) =>
        Array.isArray(line.consumedInputIds),
      );
      expect(consumingAppend).toMatchObject({
        type: "append",
        consumedInputIds: [admittedInput.id],
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a named interactive session approved a bash command for the session,
    When the user resumes and the provider repeats that command,
    Then the resumed CLI run executes it without another approval prompt`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-bash-"));
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const command =
      "node -e \"require('node:fs').appendFileSync('runs.txt', 'x')\"";
    let requestCount = 0;
    const server = createServer((req, res) => {
      if (req.url !== "/chat/completions") {
        res.writeHead(404);
        res.end();
        return;
      }

      req.resume();
      requestCount++;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      if (requestCount === 1 || requestCount === 3) {
        res.write(
          sseToolCall(`call_bash_${requestCount}`, "bash", { command }),
        );
        res.write(sseToolFinish());
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      res.end(
        sseTextReplyWithUsage(
          requestCount === 2 ? "First bash done." : "Second bash done.",
        ),
      );
    });
    await listen(server);

    const firstInput = new PassThrough();
    Object.defineProperty(firstInput, "isTTY", { value: true });
    let firstApprovalPrompts = 0;
    let resolveFirstApprovalPrompt: () => void = () => {};
    const firstApprovalPrompt = new Promise<void>((resolve) => {
      resolveFirstApprovalPrompt = resolve;
    });
    const firstRun = createRuntime(
      ["--session", "bash-resume", "--bash-policy", "ask"],
      {
        cwd: workspace,
        env: {
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
          KEEL_HOME: home,
        },
        input: firstInput,
        onStderr: (text) => {
          if (text.includes("Approve bash command")) {
            firstApprovalPrompts++;
            resolveFirstApprovalPrompt();
          }
        },
      },
    );

    try {
      const firstRunPromise = runCliMain(firstRun.runtime);
      firstInput.write("run bash\n");
      await withTimeout(
        firstApprovalPrompt,
        5000,
        "first bash approval prompt was not shown",
      );
      firstInput.write("s\n");
      firstInput.end();
      const firstExitCode = await withTimeout(
        firstRunPromise,
        5000,
        "first bash approval run did not finish",
      );

      const secondInput = new PassThrough();
      Object.defineProperty(secondInput, "isTTY", { value: true });
      let secondApprovalPrompts = 0;
      const secondRun = createRuntime(
        ["--resume", "bash-resume", "--bash-policy", "ask"],
        {
          cwd: workspace,
          env: {
            DEEPSEEK_API_KEY: "test-key",
            DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
            KEEL_HOME: home,
          },
          input: secondInput,
          onStderr: (text) => {
            if (text.includes("Approve bash command")) {
              secondApprovalPrompts++;
            }
          },
        },
      );

      // When
      const secondRunPromise = runCliMain(secondRun.runtime);
      secondInput.end("run bash again\n");
      const secondExitCode = await withTimeout(
        secondRunPromise,
        5000,
        "second resumed bash run did not finish",
      );

      // Then
      expect(firstExitCode).toBe(0);
      expect(secondExitCode).toBe(0);
      expect(firstApprovalPrompts).toBe(1);
      expect(secondApprovalPrompts).toBe(0);
      expect(await readFile(join(workspace, "runs.txt"), "utf8")).toBe("xx");
      expect(firstRun.stdout()).toBe("First bash done.\n");
      expect(secondRun.stdout()).toBe("Second bash done.\n");
      const ledger = await readFile(
        join(home, "sessions", "bash-resume", "ledger.jsonl"),
        "utf8",
      );
      expect(ledger).toContain('"type":"bash_approval_granted"');
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a named interactive session is resumed before approving bash,
    When the user approves a bash command for the resumed session,
    Then the resumed CLI run persists that approval grant`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-bash-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const command =
      "node -e \"require('node:fs').appendFileSync('runs.txt', 'x')\"";
    await writeSessionLedger({
      home,
      id: "resumed-bash-new-grant",
      workspace: ledgerWorkspace,
      createdAt: "1970-01-01T00:00:00.000Z",
      records: [
        appendSessionRecordLine("1970-01-01T00:00:00.001Z", [
          { role: "user", content: "remember alpha" },
          { role: "assistant", content: "Remembered alpha.", toolCalls: [] },
        ]),
      ],
    });
    let requestCount = 0;
    const server = createServer((req, res) => {
      if (req.url !== "/chat/completions") {
        res.writeHead(404);
        res.end();
        return;
      }

      req.resume();
      requestCount++;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      if (requestCount === 1) {
        res.write(sseToolCall("call_bash_resumed", "bash", { command }));
        res.write(sseToolFinish());
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      res.end(sseTextReplyWithUsage("Resumed bash done."));
    });
    await listen(server);

    const input = new PassThrough();
    Object.defineProperty(input, "isTTY", { value: true });
    let approvalPrompts = 0;
    let resolveApprovalPrompt: () => void = () => {};
    const approvalPrompt = new Promise<void>((resolve) => {
      resolveApprovalPrompt = resolve;
    });
    const fixture = createRuntime(
      ["--resume", "resumed-bash-new-grant", "--bash-policy", "ask"],
      {
        cwd: workspace,
        env: {
          DEEPSEEK_API_KEY: "test-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
          KEEL_HOME: home,
        },
        input,
        onStderr: (text) => {
          if (text.includes("Approve bash command")) {
            approvalPrompts++;
            resolveApprovalPrompt();
          }
        },
      },
    );

    try {
      // When
      const run = runCliMain(fixture.runtime);
      input.write("run bash after resume\n");
      await withTimeout(
        approvalPrompt,
        5000,
        "resumed bash approval prompt was not shown",
      );
      input.write("s\n");
      input.end();
      const exitCode = await withTimeout(
        run,
        5000,
        "resumed bash approval run did not finish",
      );

      // Then
      expect(exitCode).toBe(0);
      expect(approvalPrompts).toBe(1);
      expect(await readFile(join(workspace, "runs.txt"), "utf8")).toBe("x");
      expect(fixture.stdout()).toBe("Resumed bash done.\n");
      const ledgerLines = (
        await readFile(
          join(home, "sessions", "resumed-bash-new-grant", "ledger.jsonl"),
          "utf8",
        )
      )
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(ledgerLines).toContainEqual({
        schemaVersion: 2,
        type: "bash_approval_granted",
        timestamp: "1970-01-01T00:00:00.000Z",
        grant: {
          type: "exact",
          cwd: workspace,
          command,
        },
      });
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a resumed named session has active bash approvals,
    When the user revokes and clears approvals with local commands,
    Then the resumed CLI run persists the approval audit mutations`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-approvals-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const exactGrant = {
      type: "exact",
      cwd: ledgerWorkspace,
      command: "pnpm test",
    };
    const prefixGrant = {
      type: "prefix",
      cwd: ledgerWorkspace,
      argvPrefix: ["git", "status"],
    };
    await writeSessionLedger({
      home,
      id: "approval-management",
      workspace: ledgerWorkspace,
      createdAt: "1970-01-01T00:00:00.000Z",
      records: [
        JSON.stringify({
          schemaVersion: 2,
          type: "bash_approval_granted",
          timestamp: "1970-01-01T00:00:00.001Z",
          grant: exactGrant,
        }),
        JSON.stringify({
          schemaVersion: 2,
          type: "bash_approval_granted",
          timestamp: "1970-01-01T00:00:00.002Z",
          grant: prefixGrant,
        }),
      ],
    });
    const input = new PassThrough();
    input.end("/approvals revoke 1\n/approvals clear\n");
    const fixture = createRuntime(["--resume", "approval-management"], {
      cwd: workspace,
      env: {
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
      expect(fixture.stdout()).toBe(
        "Revoked bash approval 1.\nCleared 1 bash approval.\n",
      );
      expect(fixture.stderr()).toBe("");
      const ledgerLines = (
        await readFile(
          join(home, "sessions", "approval-management", "ledger.jsonl"),
          "utf8",
        )
      )
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(ledgerLines).toContainEqual({
        schemaVersion: 2,
        type: "bash_approval_revoked",
        timestamp: "1970-01-01T00:00:00.000Z",
        grant: exactGrant,
      });
      expect(ledgerLines).toContainEqual(
        expect.objectContaining({
          schemaVersion: 2,
          type: "bash_approvals_cleared",
          timestamp: "1970-01-01T00:00:00.000Z",
          consumedInputIds: expect.any(Array),
        }),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a named session has queued input from an interrupted process,
    When the user resumes with no new stdin,
    Then the queued input runs once and is marked consumed`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const ledgerWorkspace = await realpath(workspace);
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    await mkdir(join(home, "sessions", "queued"), { recursive: true });
    await writeFile(
      join(home, "sessions", "queued", "ledger.jsonl"),
      `${[
        JSON.stringify({
          schemaVersion: 2,
          type: "session",
          id: "queued",
          createdAt: "1970-01-01T00:00:00.000Z",
          workspace: ledgerWorkspace,
          graph: rootGraph("queued"),
        }),
        JSON.stringify({
          schemaVersion: 2,
          type: "input_admitted",
          timestamp: "1970-01-01T00:00:00.001Z",
          id: "queued-input-1",
          sequence: 2,
          line: "remember queued",
        }),
      ].join("\n")}\n`,
      "utf8",
    );
    const input = new PassThrough();
    input.end();
    const fixture = createRuntime(["--resume", "queued"], {
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
      expect(fixture.stdout()).toBe("Remembered: remember queued\n");
      expect(fixture.stderr()).toBe("");
      const ledgerLines = (
        await readFile(join(home, "sessions", "queued", "ledger.jsonl"), "utf8")
      )
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(ledgerLines[2]).toMatchObject({
        type: "append",
        consumedInputIds: ["queued-input-1"],
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a named session has completed history and queued future input,
    When the user forks it into a new session,
    Then the fork continues from history without consuming the source's queued input`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-cli-session-"));
    const home = await mkdtemp(join(tmpdir(), "keel-cli-home-"));
    const firstInput = new PassThrough();
    firstInput.end("remember alpha\n");
    const firstRun = createRuntime(["--session", "source"], {
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
      const sourceLedgerPath = join(home, "sessions", "source", "ledger.jsonl");
      await writeFile(
        sourceLedgerPath,
        `${JSON.stringify({
          schemaVersion: 2,
          type: "input_admitted",
          timestamp: "1970-01-01T00:00:00.001Z",
          id: "queued-source-input",
          sequence: 2,
          line: "remember queued",
        })}\n`,
        { encoding: "utf8", flag: "a" },
      );
      const forkInput = new PassThrough();
      forkInput.end("what did I ask you to remember?\n");
      const forkRun = createRuntime(["--resume=source", "--fork=target"], {
        cwd: workspace,
        env: {
          KEEL_PROVIDER: "fake",
          KEEL_FORCE_INTERACTIVE: "1",
          KEEL_HOME: home,
        },
        input: forkInput,
      });

      // When
      const forkExitCode = await runCliMain(forkRun.runtime);

      // Then
      expect(firstExitCode).toBe(0);
      expect(forkExitCode).toBe(0);
      expect(forkRun.stdout()).toBe("Earlier you said: remember alpha\n");
      expect(forkRun.stderr()).toBe("");
      const sourceLedgerLines = (await readFile(sourceLedgerPath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(
        sourceLedgerLines.some(
          (line) =>
            Array.isArray(line.consumedInputIds) &&
            line.consumedInputIds.includes("queued-source-input"),
        ),
      ).toBe(false);
      const targetLedgerLines = (
        await readFile(join(home, "sessions", "target", "ledger.jsonl"), "utf8")
      )
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(targetLedgerLines[0]).toMatchObject({
        type: "session",
        id: "target",
        graph: { parentSessionId: "source" },
      });
      expect(
        targetLedgerLines.some(
          (line) =>
            line.type === "input_admitted" && line.line === "remember queued",
        ),
      ).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
});
