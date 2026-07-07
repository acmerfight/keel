import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../../src/agent/events.ts";
import { runInteractiveSession } from "../../../src/cli/interactive-session.ts";
import type { LLMProvider } from "../../../src/llm/types.ts";
import {
  ForcedExit,
  withTimeout,
  ZERO_COST_MODEL,
  ZERO_USAGE,
} from "../../../src/testing/interactive-session-fixtures.ts";

async function createGitWorkspace(prefix: string): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), prefix));
  execFileSync("git", ["init", "-b", "main"], { cwd: workspace });
  execFileSync("git", ["config", "user.email", "keel@example.test"], {
    cwd: workspace,
  });
  execFileSync("git", ["config", "user.name", "Keel Test"], {
    cwd: workspace,
  });
  await writeFile(join(workspace, "tracked.txt"), "before\n", "utf8");
  execFileSync("git", ["add", "tracked.txt"], { cwd: workspace });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: workspace });
  return workspace;
}

async function runInteractiveLocalCommand(
  command: string,
  workspace: string,
  beforeInput?: () => Promise<void> | void,
): Promise<{
  readonly stdout: string;
  readonly stderr: string;
  readonly providerResolved: boolean;
}> {
  const input = new PassThrough();
  let stdout = "";
  let stderr = "";
  let providerResolved = false;
  const session = runInteractiveSession({
    cliArgs: { bashMode: "ask" },
    workspace,
    platform: process.platform,
    input,
    writeStdout: (text) => {
      stdout += text;
    },
    writeStderr: (text) => {
      stderr += text;
    },
    onSigint: () => {},
    offSigint: () => {},
    setExitCode: () => {},
    forceExit: (code) => {
      throw new ForcedExit(code);
    },
    resolveProvider: () => {
      providerResolved = true;
      throw new Error(`${command} should not resolve a provider`);
    },
    requireKnownCostModel: () => ZERO_COST_MODEL,
    printAgentEvents: async () => {
      throw new Error(`${command} should not start a model turn`);
    },
    formatCostReport: () => "",
  });

  await beforeInput?.();
  input.end(`${command}\n`);
  await session;
  return { stdout, stderr, providerResolved };
}

describe("Interactive Session - Lifecycle", () => {
  test(`Given staged unstaged and untracked workspace changes,
    When user enters /diff,
    Then Keel prints current git changes without starting a model turn`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-interactive-diff-");
    await writeFile(join(workspace, "tracked.txt"), "after\n", "utf8");
    await writeFile(join(workspace, "staged.txt"), "staged\n", "utf8");
    execFileSync("git", ["add", "staged.txt"], { cwd: workspace });
    await writeFile(join(workspace, "untracked.txt"), "untracked\n", "utf8");

    try {
      // When
      const result = await runInteractiveLocalCommand("/diff", workspace);

      // Then
      expect(result.stdout).toContain("Branch: main");
      expect(result.stdout).toContain("Staged changes:");
      expect(result.stdout).toContain("- A staged.txt");
      expect(result.stdout).toContain("Unstaged changes:");
      expect(result.stdout).toContain("- M tracked.txt");
      expect(result.stdout).toContain("Untracked files:");
      expect(result.stdout).toContain("- untracked.txt");
      expect(result.stdout).toContain("diff --git a/tracked.txt b/tracked.txt");
      expect(result.stdout).toContain("-before");
      expect(result.stdout).toContain("+after");
      expect(result.stdout).toContain("diff --git a/staged.txt b/staged.txt");
      expect(result.stdout).toContain("+staged");
      expect(result.stdout).toContain(
        "diff --git a/untracked.txt b/untracked.txt",
      );
      expect(result.stdout).toContain("+untracked");
      expect(result.stderr).toBe("");
      expect(result.providerResolved).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the session workspace is a git repository subdirectory,
    When user enters /diff,
    Then Keel prints only workspace changes with their diff hunks`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-interactive-diff-subdir-");
    await mkdir(join(workspace, "src"));
    await writeFile(join(workspace, ".gitignore"), "src/secret.env\n", "utf8");
    await writeFile(join(workspace, "root.txt"), "before\n", "utf8");
    await writeFile(join(workspace, "src", "app.ts"), "before\n", "utf8");
    await writeFile(
      join(workspace, "src", "secret.env"),
      "TOKEN=OLD\n",
      "utf8",
    );
    execFileSync("git", ["add", ".gitignore", "root.txt", "src/app.ts"], {
      cwd: workspace,
    });
    execFileSync("git", ["add", "-f", "src/secret.env"], { cwd: workspace });
    execFileSync("git", ["commit", "-m", "add nested files"], {
      cwd: workspace,
    });
    await writeFile(join(workspace, "root.txt"), "after\n", "utf8");
    await writeFile(join(workspace, "src", "app.ts"), "after\n", "utf8");
    await writeFile(
      join(workspace, "src", "secret.env"),
      "TOKEN=NEW\n",
      "utf8",
    );
    await writeFile(join(workspace, "src", "new.ts"), "new\n", "utf8");

    try {
      // When
      const result = await runInteractiveLocalCommand(
        "/diff",
        join(workspace, "src"),
      );

      // Then
      expect(result.stdout).toContain("Branch: main");
      expect(result.stdout).toContain("- M src/app.ts");
      expect(result.stdout).toContain("- src/new.ts");
      expect(result.stdout).toContain("diff --git a/src/app.ts b/src/app.ts");
      expect(result.stdout).toContain("diff --git a/src/new.ts b/src/new.ts");
      expect(result.stdout).not.toContain("root.txt");
      expect(result.stdout).not.toContain("secret.env");
      expect(result.stdout).not.toContain("TOKEN=NEW");
      expect(result.stderr).toBe("");
      expect(result.providerResolved).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a clean git workspace,
    When user enters /diff,
    Then Keel reports that no git changes exist without starting a model turn`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-interactive-diff-clean-");

    try {
      // When
      const result = await runInteractiveLocalCommand("/diff", workspace);

      // Then
      expect(result.stdout).toContain("Branch: main");
      expect(result.stdout).toContain("No git changes found.");
      expect(result.stdout.match(/No git changes found\./gu)?.length).toBe(1);
      expect(result.stderr).toBe("");
      expect(result.providerResolved).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a non-git workspace,
    When user enters /diff,
    Then Keel explains that git changes are unavailable without starting a model turn`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-interactive-diff-none-"),
    );

    try {
      // When
      const result = await runInteractiveLocalCommand("/diff", workspace);

      // Then
      expect(result.stdout).toBe(
        "Not in a git work tree. /diff can only inspect changes inside a Git repository.\n",
      );
      expect(result.stderr).toBe("");
      expect(result.providerResolved).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given the user passes arguments to /diff,
    When the interactive session handles the local command,
    Then Keel rejects the command without starting a model turn`, async () => {
    // When
    const result = await runInteractiveLocalCommand("/diff now", process.cwd());

    // Then
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Error: /diff does not accept arguments.\n");
    expect(result.providerResolved).toBe(false);
  });

  test(`Given the workspace path is unavailable,
    When user enters /diff,
    Then Keel reports the local command failure without starting a model turn`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-interactive-diff-missing-"),
    );

    // When
    const result = await runInteractiveLocalCommand("/diff", workspace, () =>
      rm(workspace, { recursive: true, force: true }),
    );

    // Then
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("ENOENT:");
    expect(result.providerResolved).toBe(false);
  });

  test(`Given the interactive session has restorable state,
    When user enters /status,
    Then Keel prints an actionable snapshot without starting a model turn`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-status-"));
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    let providerResolved = false;
    const session = runInteractiveSession({
      cliArgs: { bashMode: "ask" },
      workspace,
      platform: process.platform,
      sessionId: "status-detail",
      workflowSkill: {
        name: "review",
        relativePath: ".agents/skills/review/SKILL.md",
        resourcePaths: ["references/checklist.md"],
        content: "Review workflow instructions.",
      },
      initialMessages: [{ role: "user", content: "remember prior context" }],
      initialModelSelection: {
        providerId: "qwen",
        model: "qwen3.7-max",
      },
      initialBashApprovalGrants: [
        {
          type: "exact",
          cwd: workspace,
          command: "pnpm test",
        },
      ],
      initialModelSwitchCount: 1,
      listForkPoints: () => ({ sessionId: "status-detail", points: [] }),
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: (handler) => {
        sigintHandlers.add(handler);
      },
      offSigint: (handler) => {
        sigintHandlers.delete(handler);
      },
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => {
        providerResolved = true;
        throw new Error("status should not resolve a provider");
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => {
        throw new Error("status should not start a model turn");
      },
      formatCostReport: () => "",
    });

    try {
      // When
      input.end("/status\n");

      // Then
      await session;
      expect(stdout).toContain("status:\n");
      expect(stdout).toContain("  session: status-detail\n");
      expect(stdout).toContain(`  workspace: ${workspace}\n`);
      expect(stdout).toContain("  active model: qwen/qwen3.7-max\n");
      expect(stdout).toContain(
        "  workflow skill: review (.agents/skills/review/SKILL.md)\n",
      );
      expect(stdout).toContain("  messages: 1\n");
      expect(stdout).toContain("  pending inputs: 0\n");
      expect(stdout).toContain("  bash approvals: 1\n");
      expect(stdout).toContain("  model switches: 1\n");
      expect(stdout).toContain("  latest checkpoint: none\n");
      expect(stdout).toContain("  undo checkpoints: 0\n");
      expect(stdout).toContain(
        "  continue: send follow-ups or corrections here until the task is done\n",
      );
      expect(stdout).toContain("recovery:\n");
      expect(stdout).toContain("  resume: keel --resume status-detail\n");
      expect(stdout).toContain("  fork-points: /fork-points\n");
      expect(stdout).toContain("  undo-list: /undo --list\n");
      expect(stderr).toBe("");
      expect(providerResolved).toBe(false);
      expect(sigintHandlers.size).toBe(0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given no provider or model has been selected,
    When user enters /status,
    Then Keel reports that the next prompt will use defaults`, async () => {
    // Given
    const input = new PassThrough();
    let stdout = "";
    let providerResolved = false;
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: () => {},
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => {
        providerResolved = true;
        throw new Error("default status should not resolve a provider");
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => {
        throw new Error("default status should not start a model turn");
      },
      formatCostReport: () => "",
    });

    // When
    input.end("/status\n");

    // Then
    await session;
    expect(stdout).toContain("  active model: (default for next prompt)\n");
    expect(providerResolved).toBe(false);
  });

  test(`Given an interactive session already resolved a provider,
    When user enters /status,
    Then Keel reports the active provider and model without starting another turn`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    let turnCount = 0;
    const provider: LLMProvider = {
      id: "fake",
      async *stream() {
        yield { type: "text", text: "Remembered." };
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: (handler) => {
        sigintHandlers.add(handler);
      },
      offSigint: (handler) => {
        sigintHandlers.delete(handler);
      },
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        turnCount++;
        let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
        for await (const event of stream) {
          if (event.type === "text") {
            stdout += event.text;
          } else if (event.type === "end") {
            finalEnd = event;
          }
        }
        return finalEnd;
      },
      formatCostReport: () => "",
    });

    // When
    input.end("first prompt\n/status\n");

    // Then
    await session;
    expect(stdout).toContain("Remembered.");
    expect(stdout).toContain("status:\n");
    expect(stdout).toContain("  active model: fake/fake\n");
    expect(turnCount).toBe(1);
    expect(stderr).toBe("");
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given the user passes arguments to /status,
    When the interactive session handles the local command,
    Then Keel rejects the command without starting a model turn`, async () => {
    // Given
    const input = new PassThrough();
    let stderr = "";
    let providerResolved = false;
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: () => {},
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => {
        providerResolved = true;
        throw new Error("invalid status should not resolve a provider");
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => {
        throw new Error("invalid status should not start a model turn");
      },
      formatCostReport: () => "",
    });

    // When
    input.end("/status now\n");

    // Then
    await session;
    expect(stderr).toBe("Error: /status does not accept arguments.\n");
    expect(providerResolved).toBe(false);
  });

  test(`Given the interactive session is idle,
    When user interrupts,
    Then the session exits as interrupted`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let exitCode: number | undefined;
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: () => {},
      onSigint: (handler) => {
        sigintHandlers.add(handler);
      },
      offSigint: (handler) => {
        sigintHandlers.delete(handler);
      },
      setExitCode: (code) => {
        exitCode = code;
      },
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => {
        throw new Error("idle interrupt should not resolve a provider");
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => undefined,
      formatCostReport: () => "",
    });

    // When
    for (const handler of [...sigintHandlers]) {
      handler();
    }

    // Then
    await session;
    expect(stdout).toBe("\n");
    expect(exitCode).toBe(130);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given the interactive session is idle,
    When user enters /help,
    Then help is printed without starting a model turn`, async () => {
    // Given
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    let providerResolved = false;
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: (handler) => {
        sigintHandlers.add(handler);
      },
      offSigint: (handler) => {
        sigintHandlers.delete(handler);
      },
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => {
        providerResolved = true;
        throw new Error("help should not resolve a provider");
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => {
        throw new Error("help should not start a model turn");
      },
      formatCostReport: () => "",
    });

    // When
    input.end("/help\n");

    // Then
    await session;
    expect(stdout).toContain("Interactive commands:");
    expect(stdout).toContain(
      "Keep one saved session open for a task; send follow-ups or corrections here until it is done.",
    );
    expect(stdout).toContain(
      "Input typed while a turn runs is applied at the next safe model request.",
    );
    expect(stdout).toContain("/help");
    expect(stdout).toContain("/status");
    expect(stdout).toContain("/diff");
    expect(stdout).toContain("/undo");
    expect(stdout).toContain("/compact [focus]");
    expect(stdout).toContain("keel sessions");
    expect(stdout).toContain("keel sessions fork");
    expect(stderr).toBe("");
    expect(providerResolved).toBe(false);
    expect(sigintHandlers.size).toBe(0);
  });

  test(`Given an active interactive turn fails without abort,
    When the provider error reaches the session,
    Then the error is rethrown`, async () => {
    // Given
    const provider: LLMProvider = {
      id: "fake",
      async *stream() {
        yield { type: "text", text: "Before failure" };
        throw new Error("provider failed");
      },
    };
    const input = new PassThrough();
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: () => {},
      writeStderr: () => {},
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
        for await (const _event of stream) {
          // Consume the stream so provider errors surface through the session.
        }
        return undefined;
      },
      formatCostReport: () => "",
    });

    // When
    input.write("hello\n");
    input.end();

    // Then
    await expect(session).rejects.toThrow("provider failed");
  });

  test(`Given an active interactive turn has already been interrupted,
    When user interrupts the still-running turn again,
    Then the CLI exits as interrupted`, async () => {
    // Given
    let releaseHang: () => void = () => {};
    let receiveHanging: () => void = () => {};
    let receiveAbort: () => void = () => {};
    let receiveAbortMarker: () => void = () => {};
    const hangReleased = new Promise<void>((resolve) => {
      releaseHang = resolve;
    });
    const hangingReceived = new Promise<void>((resolve) => {
      receiveHanging = resolve;
    });
    const abortReceived = new Promise<void>((resolve) => {
      receiveAbort = resolve;
    });
    const abortMarkerReceived = new Promise<void>((resolve) => {
      receiveAbortMarker = resolve;
    });
    const provider: LLMProvider = {
      id: "fake",
      async *stream(options) {
        yield { type: "text", text: "Hanging" };
        await new Promise<void>((resolve) => {
          options.signal.addEventListener(
            "abort",
            () => {
              receiveAbort();
              resolve();
            },
            { once: true },
          );
        });
        yield { type: "text", text: " Aborted" };
        await hangReleased;
        yield { type: "stop", reason: "stop", usage: ZERO_USAGE };
      },
    };
    const input = new PassThrough();
    const sigintHandlers = new Set<() => void>();
    let stdout = "";
    let stderr = "";
    let exitCode: number | undefined;
    const printAgentEvents = async (stream: AsyncIterable<AgentEvent>) => {
      let finalEnd: Extract<AgentEvent, { readonly type: "end" }> | undefined;
      for await (const event of stream) {
        if (event.type === "text") {
          stdout += event.text;
          if (stdout.includes("Hanging")) {
            receiveHanging();
          }
          if (stdout.includes("Hanging Aborted")) {
            receiveAbortMarker();
          }
        } else if (event.type === "end") {
          finalEnd = event;
        }
      }
      return finalEnd;
    };
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace: process.cwd(),
      platform: process.platform,
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
      onSigint: (handler) => {
        sigintHandlers.add(handler);
      },
      offSigint: (handler) => {
        sigintHandlers.delete(handler);
      },
      setExitCode: (code) => {
        exitCode = code;
      },
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => ({
        provider,
        providerId: "fake",
        model: "fake",
        costModel: ZERO_COST_MODEL,
      }),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents,
      formatCostReport: () => "",
    });
    const emitSigint = () => {
      for (const handler of [...sigintHandlers]) {
        handler();
      }
    };

    try {
      // When
      input.write("hang\n");
      await withTimeout(
        hangingReceived,
        5000,
        "interactive session did not start the hanging turn",
      );
      emitSigint();
      await withTimeout(
        abortReceived,
        5000,
        "interactive session did not deliver the first interrupt",
      );
      await withTimeout(
        abortMarkerReceived,
        5000,
        "interactive session did not print the first interrupt marker",
      );

      // Then
      let forcedExit: ForcedExit | null = null;
      try {
        emitSigint();
      } catch (error) {
        if (error instanceof ForcedExit) {
          forcedExit = error;
        } else {
          throw error;
        }
      }
      expect(forcedExit?.code).toBe(130);
      expect(exitCode).toBeUndefined();
      expect(stdout).toBe("Hanging Aborted\n");
      expect(stderr).toBe("");
    } finally {
      releaseHang();
      input.end();
      await session;
    }
  });
});
