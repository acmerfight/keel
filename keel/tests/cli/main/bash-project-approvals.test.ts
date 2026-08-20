import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
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
  sseToolCall,
  sseToolFinish,
} from "../../../src/testing/provider-sse-fixtures.ts";

function bashCommandServer(options: {
  readonly command: string;
  readonly toolCallId: string;
  readonly finalText: string;
  readonly capturedBodies: unknown[];
}): Server {
  let requestCount = 0;
  return createServer((req, res) => {
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
      requestCount++;
      options.capturedBodies.push(JSON.parse(body));
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      if (requestCount === 1) {
        res.write(
          sseToolCall(options.toolCallId, "bash", {
            command: options.command,
          }),
        );
        res.write(sseToolFinish());
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      res.end(sseTextReplyWithUsage(options.finalText));
    });
  });
}

function providerEnv(server: Server, home: string): Record<string, string> {
  return {
    DEEPSEEK_API_KEY: "test-key",
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${getPort(server)}`,
    KEEL_HOME: home,
  };
}

async function saveProjectGitStatusApproval(options: {
  readonly workspace: string;
  readonly home: string;
}): Promise<string> {
  const capturedBodies: unknown[] = [];
  const server = bashCommandServer({
    command: "git status --short",
    toolCallId: "call_bash_save",
    finalText: "Saved approval.",
    capturedBodies,
  });
  await listen(server);
  const input = new PassThrough();
  const run = createRuntime(["--bash-policy", "ask", "check status"], {
    cwd: options.workspace,
    env: providerEnv(server, options.home),
    input,
    inputIsTTY: true,
    onStderr: (text) => {
      if (text.includes("Approve bash command?")) {
        input.write("r\n");
        input.end();
      }
    },
  });

  try {
    const exitCode = await runCliMain(run.runtime);
    expect(exitCode).toBe(0);
    expect(run.stdout()).toBe("Saved approval.\n");
    return run.stderr();
  } finally {
    await close(server);
  }
}

describe("CLI Main - Bash Project Approvals", () => {
  test.each([
    {
      args: ["approvals", "revoke"] as const,
      stderr: "Error: approvals revoke requires a positive index.",
    },
    {
      args: ["approvals", "revoke", "0"] as const,
      stderr: "Error: approvals revoke requires a positive index.",
    },
    {
      args: ["approvals", "revoke", "9007199254740992"] as const,
      stderr: "Error: approvals revoke requires a positive index.",
    },
    {
      args: ["approvals", "revoke", "1", "extra"] as const,
      stderr: 'Error: unknown approvals revoke option "extra"',
    },
    {
      args: ["approvals", "clear", "extra"] as const,
      stderr: 'Error: unknown approvals clear option "extra"',
    },
    {
      args: ["approvals", "unknown"] as const,
      stderr: 'Error: unknown approvals option "unknown"',
    },
  ])(
    `Given invalid approvals CLI arguments %#,
    When Keel parses the top-level command,
    Then it prints the argument error without reading approvals`,
    async ({ args, stderr }) => {
      // Given
      const run = createRuntime(args);

      // When
      const exitCode = await runCliMain(run.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(run.stdout()).toBe("");
      expect(run.stderr()).toBe(`${stderr}\n`);
    },
  );

  test(`Given ask bash policy is enabled for one-shot runs,
    When the user approves a command family for the current project,
    Then later runs in that project use the saved approval without another prompt`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-main-bash-project-"),
    );
    const home = await mkdtemp(join(tmpdir(), "keel-home-bash-project-"));
    execFileSync("git", ["init", "--quiet", "--initial-branch=main"], {
      cwd: workspace,
      stdio: "ignore",
    });
    await writeFile(join(workspace, "note.txt"), "hello\n", "utf8");

    try {
      // When
      const firstStderr = await saveProjectGitStatusApproval({
        workspace,
        home,
      });

      // Then
      expect(firstStderr).toContain(
        "[r] allow command family for this project: git status",
      );
      expect(firstStderr).toContain("Tool: bash git status --short\n");

      const list = createRuntime(["approvals"], {
        cwd: workspace,
        env: { KEEL_HOME: home },
      });
      const listExitCode = await runCliMain(list.runtime);
      expect(listExitCode).toBe(0);
      expect(list.stdout()).toContain("Bash project approvals:\n");
      expect(list.stdout()).toContain(`project: ${workspace}\n`);
      expect(list.stdout()).toContain(`approved from: ${workspace}\n`);
      expect(list.stdout()).toContain("argv prefix: git status\n");
      expect(list.stderr()).toBe("");

      const secondCapturedBodies: unknown[] = [];
      const secondServer = bashCommandServer({
        command: "git status --porcelain",
        toolCallId: "call_bash_saved",
        finalText: "Used saved approval.",
        capturedBodies: secondCapturedBodies,
      });
      await listen(secondServer);
      const secondRun = createRuntime(
        ["--bash-policy", "ask", "check status again"],
        {
          cwd: workspace,
          env: providerEnv(secondServer, home),
        },
      );
      try {
        const secondExitCode = await runCliMain(secondRun.runtime);
        expect(secondExitCode).toBe(0);
        expect(secondRun.stdout()).toBe("Used saved approval.\n");
        expect(secondRun.stderr()).toBe("Tool: bash git status --porcelain\n");
        const secondRequest = requestWithMessagesSchema.parse(
          secondCapturedBodies[1],
        );
        expect(secondRequest.messages).toContainEqual(
          expect.objectContaining({
            role: "tool",
            tool_call_id: "call_bash_saved",
            content: expect.stringContaining("stdout:\n?? note.txt"),
          }),
        );
      } finally {
        await close(secondServer);
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given ask mode receives workspace Vitest selectors,
    When the user saves that safe command family for the project,
    Then later safe selectors run without a prompt while traversal fails closed`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-main-bash-project-"),
    );
    const home = await mkdtemp(join(tmpdir(), "keel-home-bash-project-"));
    const fakeBin = await mkdtemp(join(tmpdir(), "keel-fake-pnpm-"));
    const commandLog = join(fakeBin, "commands.log");
    const fakePnpm = join(fakeBin, "pnpm");
    const pathEnvironmentKey = "PATH";
    const logEnvironmentKey = "KEEL_TEST_PNPM_LOG";
    const originalPath = process.env[pathEnvironmentKey];
    const originalLog = process.env[logEnvironmentKey];
    execFileSync("git", ["init", "--quiet", "--initial-branch=main"], {
      cwd: workspace,
      stdio: "ignore",
    });
    await mkdir(join(workspace, "tests"), { recursive: true });
    await writeFile(join(workspace, "tests", "first.test.ts"), "first\n");
    await writeFile(join(workspace, "tests", "second.test.ts"), "second\n");
    await writeFile(
      fakePnpm,
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$KEEL_TEST_PNPM_LOG"\n',
      "utf8",
    );
    await chmod(fakePnpm, 0o755);
    process.env[pathEnvironmentKey] =
      `${fakeBin}${delimiter}${originalPath ?? ""}`;
    process.env[logEnvironmentKey] = commandLog;

    try {
      const firstCommand = "pnpm vitest run tests/first.test.ts";
      const firstServer = bashCommandServer({
        command: firstCommand,
        toolCallId: "call_vitest_first",
        finalText: "Saved Vitest approval.",
        capturedBodies: [],
      });
      await listen(firstServer);
      const input = new PassThrough();
      let approvalPrompts = 0;
      const firstRun = createRuntime(
        ["--bash-policy", "ask", "run the first test"],
        {
          cwd: workspace,
          env: providerEnv(firstServer, home),
          input,
          inputIsTTY: true,
          onStderr: (text) => {
            if (text.includes("Approve bash command?")) {
              approvalPrompts++;
              input.write("r\n");
              input.end();
            }
          },
        },
      );
      try {
        const firstExitCode = await runCliMain(firstRun.runtime);
        expect(firstExitCode).toBe(0);
      } finally {
        await close(firstServer);
      }

      // When
      const secondCommand = "pnpm vitest run ./tests/second.test.ts";
      const secondCapturedBodies: unknown[] = [];
      const secondServer = bashCommandServer({
        command: secondCommand,
        toolCallId: "call_vitest_second",
        finalText: "Used Vitest approval.",
        capturedBodies: secondCapturedBodies,
      });
      await listen(secondServer);
      const secondRun = createRuntime(
        ["--bash-policy", "ask", "run the second test"],
        {
          cwd: workspace,
          env: providerEnv(secondServer, home),
        },
      );
      try {
        const secondExitCode = await runCliMain(secondRun.runtime);
        expect(secondExitCode).toBe(0);
      } finally {
        await close(secondServer);
      }

      const unsafeCommand = "pnpm vitest run tests/..:12";
      const unsafeCapturedBodies: unknown[] = [];
      const unsafeServer = bashCommandServer({
        command: unsafeCommand,
        toolCallId: "call_vitest_outside",
        finalText: "Rejected unsafe selector.",
        capturedBodies: unsafeCapturedBodies,
      });
      await listen(unsafeServer);
      const unsafeRun = createRuntime(
        ["--bash-policy", "ask", "run an outside test"],
        {
          cwd: workspace,
          env: providerEnv(unsafeServer, home),
        },
      );
      try {
        const unsafeExitCode = await runCliMain(unsafeRun.runtime);
        expect(unsafeExitCode).toBe(0);
      } finally {
        await close(unsafeServer);
      }

      // Then
      expect(approvalPrompts).toBe(1);
      expect(firstRun.stdout()).toBe("Saved Vitest approval.\n");
      expect(firstRun.stderr()).toContain(
        "[r] allow command family for this project: pnpm vitest run <workspace test selectors>",
      );
      expect(secondRun.stdout()).toBe("Used Vitest approval.\n");
      expect(secondRun.stderr()).toBe(`Tool: bash ${secondCommand}\n`);
      const secondRequest = requestWithMessagesSchema.parse(
        secondCapturedBodies[1],
      );
      expect(secondRequest.messages).toContainEqual(
        expect.objectContaining({
          role: "tool",
          tool_call_id: "call_vitest_second",
          content: expect.stringContaining("Exit code: 0"),
        }),
      );
      expect(unsafeRun.stdout()).toBe("Rejected unsafe selector.\n");
      expect(unsafeRun.stderr()).toBe(
        `Tool: bash ${unsafeCommand}\nTool failed: bash ${unsafeCommand}\n`,
      );
      const unsafeRequest = requestWithMessagesSchema.parse(
        unsafeCapturedBodies[1],
      );
      expect(unsafeRequest.messages).toContainEqual(
        expect.objectContaining({
          role: "tool",
          tool_call_id: "call_vitest_outside",
          content: expect.stringContaining("bash permission denied"),
        }),
      );
      expect(await readFile(commandLog, "utf8")).toBe(
        [
          "vitest run tests/first.test.ts",
          "vitest run ./tests/second.test.ts",
          "",
        ].join("\n"),
      );
    } finally {
      if (originalPath === undefined) {
        delete process.env[pathEnvironmentKey];
      } else {
        process.env[pathEnvironmentKey] = originalPath;
      }
      if (originalLog === undefined) {
        delete process.env[logEnvironmentKey];
      } else {
        process.env[logEnvironmentKey] = originalLog;
      }
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
      await rm(fakeBin, { recursive: true, force: true });
    }
  });

  test(`Given a command family is approved from the project root,
    When a later one-shot run starts from a subdirectory in the same project,
    Then the project approval is reused without another prompt`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-main-bash-project-"),
    );
    const nestedWorkspace = join(workspace, "packages", "app");
    const home = await mkdtemp(join(tmpdir(), "keel-home-bash-project-"));
    execFileSync("git", ["init", "--quiet", "--initial-branch=main"], {
      cwd: workspace,
      stdio: "ignore",
    });
    await mkdir(nestedWorkspace, { recursive: true });
    await writeFile(join(nestedWorkspace, "child.txt"), "hello\n", "utf8");

    try {
      await saveProjectGitStatusApproval({
        workspace,
        home,
      });

      const capturedBodies: unknown[] = [];
      const server = bashCommandServer({
        command: "git status --porcelain",
        toolCallId: "call_bash_nested",
        finalText: "Used nested approval.",
        capturedBodies,
      });
      await listen(server);
      const run = createRuntime(["--bash-policy", "ask", "check nested"], {
        cwd: nestedWorkspace,
        env: providerEnv(server, home),
      });

      try {
        // When
        const exitCode = await runCliMain(run.runtime);

        // Then
        expect(exitCode).toBe(0);
        expect(run.stdout()).toBe("Used nested approval.\n");
        expect(run.stderr()).toBe("Tool: bash git status --porcelain\n");
        const secondRequest = requestWithMessagesSchema.parse(
          capturedBodies[1],
        );
        expect(secondRequest.messages).toContainEqual(
          expect.objectContaining({
            role: "tool",
            tool_call_id: "call_bash_nested",
            content: expect.stringContaining("stdout:"),
          }),
        );
      } finally {
        await close(server);
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a saved project bash approval,
    When the user revokes it from the CLI,
    Then later approval listings no longer show that project rule`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-main-bash-project-"),
    );
    const home = await mkdtemp(join(tmpdir(), "keel-home-bash-project-"));
    execFileSync("git", ["init", "--quiet", "--initial-branch=main"], {
      cwd: workspace,
      stdio: "ignore",
    });

    try {
      await saveProjectGitStatusApproval({ workspace, home });

      // When
      const revoke = createRuntime(["approvals", "revoke", "1"], {
        cwd: workspace,
        env: { KEEL_HOME: home },
      });
      const revokeExitCode = await runCliMain(revoke.runtime);

      // Then
      expect(revokeExitCode).toBe(0);
      expect(revoke.stdout()).toBe("Revoked bash project approval 1.\n");
      expect(revoke.stderr()).toBe("");

      const list = createRuntime(["approvals"], {
        cwd: workspace,
        env: { KEEL_HOME: home },
      });
      const listExitCode = await runCliMain(list.runtime);
      expect(listExitCode).toBe(0);
      expect(list.stdout()).toBe("No bash project approvals.\n");

      const clear = createRuntime(["approvals", "clear"], {
        cwd: workspace,
        env: { KEEL_HOME: home },
      });
      const clearExitCode = await runCliMain(clear.runtime);
      expect(clearExitCode).toBe(0);
      expect(clear.stdout()).toBe("No bash project approvals to clear.\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given the current project has no saved bash approval,
    When the user revokes an approval index,
    Then Keel reports that the project approval does not exist`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-main-bash-project-"),
    );
    const home = await mkdtemp(join(tmpdir(), "keel-home-bash-project-"));
    const revoke = createRuntime(["approvals", "revoke", "1"], {
      cwd: workspace,
      env: { KEEL_HOME: home },
    });

    try {
      // When
      const exitCode = await runCliMain(revoke.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(revoke.stdout()).toBe("");
      expect(revoke.stderr()).toBe(
        "Error: bash project approval 1 does not exist.\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given the approval store has multiple grants for the current project,
    When the user clears project approvals,
    Then Keel clears only the current project's grants`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-main-bash-project-"),
    );
    const otherWorkspace = await mkdtemp(
      join(tmpdir(), "keel-cli-main-bash-project-other-"),
    );
    const home = await mkdtemp(join(tmpdir(), "keel-home-bash-project-"));
    await writeFile(
      join(home, "bash-project-approvals.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          grants: [
            {
              projectRoot: workspace,
              cwd: workspace,
              argvPrefix: ["git", "status"],
            },
            {
              projectRoot: workspace,
              cwd: workspace,
              argvPrefix: ["pnpm", "test"],
            },
            {
              projectRoot: otherWorkspace,
              cwd: otherWorkspace,
              argvPrefix: ["git", "status"],
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const clear = createRuntime(["approvals", "clear"], {
      cwd: workspace,
      env: { KEEL_HOME: home },
    });

    try {
      // When
      const exitCode = await runCliMain(clear.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(clear.stdout()).toBe("Cleared 2 bash project approvals.\n");
      expect(clear.stderr()).toBe("");

      const currentList = createRuntime(["approvals"], {
        cwd: workspace,
        env: { KEEL_HOME: home },
      });
      const currentListExitCode = await runCliMain(currentList.runtime);
      expect(currentListExitCode).toBe(0);
      expect(currentList.stdout()).toBe("No bash project approvals.\n");

      const otherList = createRuntime(["approvals"], {
        cwd: otherWorkspace,
        env: { KEEL_HOME: home },
      });
      const otherListExitCode = await runCliMain(otherList.runtime);
      expect(otherListExitCode).toBe(0);
      expect(otherList.stdout()).toContain(`project: ${otherWorkspace}\n`);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(otherWorkspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given the approval store has one grant for the current project,
    When the user clears project approvals,
    Then Keel reports the singular cleared approval count`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-main-bash-project-"),
    );
    const home = await mkdtemp(join(tmpdir(), "keel-home-bash-project-"));
    await writeFile(
      join(home, "bash-project-approvals.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        grants: [
          {
            projectRoot: workspace,
            cwd: workspace,
            argvPrefix: ["git", "status"],
          },
        ],
      })}\n`,
      "utf8",
    );
    const clear = createRuntime(["approvals", "clear"], {
      cwd: workspace,
      env: { KEEL_HOME: home },
    });

    try {
      // When
      const exitCode = await runCliMain(clear.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(clear.stdout()).toBe("Cleared 1 bash project approval.\n");
      expect(clear.stderr()).toBe("");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a bash approval is saved for one project,
    When another project requests the same bash command without a terminal,
    Then the saved approval is not reused across projects`, async () => {
    // Given
    const approvedWorkspace = await mkdtemp(
      join(tmpdir(), "keel-cli-main-bash-project-approved-"),
    );
    const otherWorkspace = await mkdtemp(
      join(tmpdir(), "keel-cli-main-bash-project-other-"),
    );
    const home = await mkdtemp(join(tmpdir(), "keel-home-bash-project-"));
    execFileSync("git", ["init", "--quiet", "--initial-branch=main"], {
      cwd: approvedWorkspace,
      stdio: "ignore",
    });
    execFileSync("git", ["init", "--quiet", "--initial-branch=main"], {
      cwd: otherWorkspace,
      stdio: "ignore",
    });
    await writeFile(join(otherWorkspace, "note.txt"), "hello\n", "utf8");

    try {
      await saveProjectGitStatusApproval({
        workspace: approvedWorkspace,
        home,
      });
      const capturedBodies: unknown[] = [];
      const server = bashCommandServer({
        command: "git status --porcelain",
        toolCallId: "call_bash_other",
        finalText: "Other project denied.",
        capturedBodies,
      });
      await listen(server);
      const run = createRuntime(["--bash-policy", "ask", "check status"], {
        cwd: otherWorkspace,
        env: providerEnv(server, home),
      });

      try {
        // When
        const exitCode = await runCliMain(run.runtime);

        // Then
        expect(exitCode).toBe(0);
        expect(run.stdout()).toBe("Other project denied.\n");
        expect(run.stderr()).toBe(
          "Tool: bash git status --porcelain\nTool failed: bash git status --porcelain\n",
        );
        const secondRequest = requestWithMessagesSchema.parse(
          capturedBodies[1],
        );
        expect(secondRequest.messages).toContainEqual(
          expect.objectContaining({
            role: "tool",
            tool_call_id: "call_bash_other",
            content: expect.stringContaining("bash permission denied"),
          }),
        );
      } finally {
        await close(server);
      }
    } finally {
      await rm(approvedWorkspace, { recursive: true, force: true });
      await rm(otherWorkspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given a bash command may write workspace state,
    When the approval prompt is shown,
    Then the command cannot be saved as a project approval`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-main-bash-project-"),
    );
    const home = await mkdtemp(join(tmpdir(), "keel-home-bash-project-"));
    const capturedBodies: unknown[] = [];
    const server = bashCommandServer({
      command: "git add note.txt",
      toolCallId: "call_bash_write",
      finalText: "Write command denied.",
      capturedBodies,
    });
    await listen(server);
    const input = new PassThrough();
    let approvalPrompts = 0;
    const run = createRuntime(["--bash-policy", "ask", "stage files"], {
      cwd: workspace,
      env: providerEnv(server, home),
      input,
      inputIsTTY: true,
      onStderr: (text) => {
        if (text.includes("Approve bash command?")) {
          approvalPrompts++;
          input.write("r\n");
          input.end();
        }
      },
    });

    try {
      // When
      const exitCode = await runCliMain(run.runtime);

      // Then
      expect(exitCode).toBe(0);
      expect(approvalPrompts).toBe(1);
      expect(run.stdout()).toBe("Write command denied.\n");
      expect(run.stderr()).toContain("risk: workspace-write");
      expect(run.stderr()).not.toContain("[r] allow");
      expect(run.stderr()).toContain("Tool failed: bash git add note.txt\n");

      const list = createRuntime(["approvals"], {
        cwd: workspace,
        env: { KEEL_HOME: home },
      });
      const listExitCode = await runCliMain(list.runtime);
      expect(listExitCode).toBe(0);
      expect(list.stdout()).toBe("No bash project approvals.\n");
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given the project bash approval store contains invalid JSON,
    When the user lists approvals,
    Then Keel fails closed with the approval store path`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-main-bash-project-"),
    );
    const home = await mkdtemp(join(tmpdir(), "keel-home-bash-project-"));
    const approvalsPath = join(home, "bash-project-approvals.json");
    await writeFile(approvalsPath, "{", "utf8");
    const list = createRuntime(["approvals"], {
      cwd: workspace,
      env: { KEEL_HOME: home },
    });

    try {
      // When
      const exitCode = await runCliMain(list.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(list.stdout()).toBe("");
      expect(list.stderr()).toBe(
        `Error: cannot read bash project approvals ${approvalsPath}: invalid JSON.\n`,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given the project bash approval store has the current schema with invalid fields,
    When the user lists approvals,
    Then Keel fails closed instead of ignoring the corrupt approval`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-main-bash-project-"),
    );
    const home = await mkdtemp(join(tmpdir(), "keel-home-bash-project-"));
    const approvalsPath = join(home, "bash-project-approvals.json");
    await writeFile(
      approvalsPath,
      `${JSON.stringify({
        schemaVersion: 1,
        grants: [{ projectRoot: "", cwd: workspace, argvPrefix: ["git"] }],
      })}\n`,
      "utf8",
    );
    const list = createRuntime(["approvals"], {
      cwd: workspace,
      env: { KEEL_HOME: home },
    });

    try {
      // When
      const exitCode = await runCliMain(list.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(list.stdout()).toBe("");
      expect(list.stderr()).toContain(
        `Error: cannot read bash project approvals ${approvalsPath}:`,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given KEEL_HOME points at a file,
    When the user lists approvals,
    Then Keel reports the invalid approval store path`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-main-bash-project-"),
    );
    const tempRoot = await mkdtemp(join(tmpdir(), "keel-home-bash-project-"));
    const homeFile = join(tempRoot, "home-file");
    await writeFile(homeFile, "not a directory\n", "utf8");
    const approvalsPath = join(homeFile, "bash-project-approvals.json");
    const list = createRuntime(["approvals"], {
      cwd: workspace,
      env: { KEEL_HOME: homeFile },
    });

    try {
      // When
      const exitCode = await runCliMain(list.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(list.stdout()).toBe("");
      expect(list.stderr()).toContain(
        `Error: cannot read bash project approvals ${approvalsPath}:`,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test(`Given Keel cannot write the project bash approval store,
    When the user clears saved approvals,
    Then Keel fails closed with the approval store path`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-main-bash-project-"),
    );
    const home = await mkdtemp(join(tmpdir(), "keel-home-bash-project-"));
    const approvalsPath = join(home, "bash-project-approvals.json");
    await writeFile(
      approvalsPath,
      `${JSON.stringify({
        schemaVersion: 1,
        grants: [
          {
            projectRoot: workspace,
            cwd: workspace,
            argvPrefix: ["git", "status"],
          },
        ],
      })}\n`,
      "utf8",
    );
    await chmod(approvalsPath, 0o400);
    const clear = createRuntime(["approvals", "clear"], {
      cwd: workspace,
      env: { KEEL_HOME: home },
    });

    try {
      // When
      const exitCode = await runCliMain(clear.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(clear.stdout()).toBe("");
      expect(clear.stderr()).toContain(
        `Error: cannot write bash project approvals ${approvalsPath}:`,
      );
    } finally {
      await chmod(approvalsPath, 0o600).catch(() => {});
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given one-shot ask mode sees an invalid project bash approval store,
    When the run starts,
    Then Keel fails closed before sending a provider request`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-cli-main-bash-project-"),
    );
    const home = await mkdtemp(join(tmpdir(), "keel-home-bash-project-"));
    const approvalsPath = join(home, "bash-project-approvals.json");
    await writeFile(approvalsPath, "{", "utf8");
    const capturedBodies: unknown[] = [];
    const server = bashCommandServer({
      command: "git status --short",
      toolCallId: "call_bash_invalid_store",
      finalText: "Should not run.",
      capturedBodies,
    });
    await listen(server);
    const run = createRuntime(["--bash-policy", "ask", "check status"], {
      cwd: workspace,
      env: providerEnv(server, home),
    });

    try {
      // When
      const exitCode = await runCliMain(run.runtime);

      // Then
      expect(exitCode).toBe(1);
      expect(run.stdout()).toBe("");
      expect(run.stderr()).toBe(
        `Error: cannot read bash project approvals ${approvalsPath}: invalid JSON.\n`,
      );
      expect(capturedBodies).toEqual([]);
    } finally {
      await close(server);
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
});
