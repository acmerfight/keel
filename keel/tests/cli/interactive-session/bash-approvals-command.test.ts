import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../../src/agent/events.ts";
import { parseInteractiveCommand } from "../../../src/cli/interactive-session/commands.ts";
import {
  createSessionStore,
  persistSessionBashApprovalGrant,
  persistSessionBashApprovalRevoked,
  persistSessionQueuedInput,
  resumeSessionStore,
} from "../../../src/cli/session-store.ts";
import {
  createFakeProvider,
  fakeResponse,
  fakeToolResponse,
} from "../../../src/llm/providers/fake.ts";
import type { LLMProvider } from "../../../src/llm/types.ts";
import type { BashApprovalGrant } from "../../../src/permissions/bash.ts";
import {
  EPHEMERAL_INTERACTIVE_SESSION,
  ForcedExit,
  runInteractiveSessionWithoutMemory as runInteractiveSession,
  savedInteractiveSession,
  withTimeout,
  ZERO_COST_MODEL,
} from "../../../src/testing/interactive-session-fixtures.ts";
import { runtime } from "../../../src/testing/session-store-fixtures.ts";

function fakeResolvedProvider(provider: LLMProvider) {
  return {
    provider,
    providerId: "fake",
    model: "fake",
    costModel: ZERO_COST_MODEL,
  } satisfies ReturnType<
    Parameters<typeof runInteractiveSession>[0]["resolveProvider"]
  >;
}

describe("Interactive Session - Bash Approvals Command", () => {
  test(`Given approval management commands,
    When Keel parses their arguments,
    Then list, revoke, clear, and invalid forms have explicit command results`, () => {
    // Given / When / Then
    expect(parseInteractiveCommand("/approvals")).toEqual({
      kind: "approvals",
      action: "list",
    });
    expect(parseInteractiveCommand("/approvals clear")).toEqual({
      kind: "approvals",
      action: "clear",
    });
    expect(parseInteractiveCommand("/approvals revoke 2")).toEqual({
      kind: "approvals",
      action: "revoke",
      index: 2,
    });
    expect(parseInteractiveCommand("/approvals revoke 0")).toEqual({
      kind: "invalid",
      message: "Error: /approvals revoke requires a positive integer.",
    });
    expect(parseInteractiveCommand("/approvals revoke")).toEqual({
      kind: "invalid",
      message: "Error: /approvals revoke requires a positive integer.",
    });
    expect(
      parseInteractiveCommand("/approvals revoke 9007199254740992"),
    ).toEqual({
      kind: "invalid",
      message: "Error: /approvals revoke requires a positive integer.",
    });
    expect(parseInteractiveCommand("/approvals revoke 1 extra")).toEqual({
      kind: "invalid",
      message: 'Error: unknown /approvals argument "extra".',
    });
    expect(parseInteractiveCommand("/approvals clear extra")).toEqual({
      kind: "invalid",
      message: 'Error: unknown /approvals argument "extra".',
    });
    expect(parseInteractiveCommand("/approvals nope")).toEqual({
      kind: "invalid",
      message: 'Error: unknown /approvals argument "nope".',
    });
  });

  test(`Given an interactive session has no bash approvals,
    When the user enters /approvals,
    Then Keel reports that there are no active session or project approvals`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-approvals-empty-"));
    const input = new PassThrough();
    let stdout = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "ask" },
      workspace,
      platform: process.platform,
      session: EPHEMERAL_INTERACTIVE_SESSION,
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
        throw new Error(
          "empty approvals command should not resolve a provider",
        );
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => {
        throw new Error(
          "empty approvals command should not start a model turn",
        );
      },
      formatCostReport: () => "",
    });

    try {
      // When
      input.end("/approvals\n");

      // Then
      await session;
      expect(stdout).toBe(
        "No bash approvals for this session.\nNo bash project approvals.\n",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an interactive session has no bash approvals,
    When the user clears approvals,
    Then Keel reports that there is nothing to clear without starting a model turn`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-approvals-clear-empty-"),
    );
    const input = new PassThrough();
    let stdout = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "ask" },
      workspace,
      platform: process.platform,
      session: EPHEMERAL_INTERACTIVE_SESSION,
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
        throw new Error(
          "empty clear approvals command should not resolve a provider",
        );
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => {
        throw new Error(
          "empty clear approvals command should not start a model turn",
        );
      },
      formatCostReport: () => "",
    });

    try {
      // When
      input.end("/approvals clear\n");

      // Then
      await session;
      expect(stdout).toBe("No bash approvals to clear.\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an interactive session has bash approval grants,
    When the user enters /approvals,
    Then Keel lists active session and project approvals without starting a model turn`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-approvals-list-"));
    const input = new PassThrough();
    let stdout = "";
    let stderr = "";
    let providerResolved = false;
    const session = runInteractiveSession({
      cliArgs: { bashMode: "ask" },
      workspace,
      platform: process.platform,
      session: EPHEMERAL_INTERACTIVE_SESSION,
      initialBashApprovalGrants: [
        {
          type: "exact",
          cwd: workspace,
          command: "printf 'x\u001b[2Jy'",
        },
        {
          type: "prefix",
          cwd: workspace,
          argvPrefix: ["git", "status"],
        },
        {
          type: "command_family",
          cwd: workspace,
          commandFamily: "pnpm_vitest_run_workspace_test_selectors",
        },
      ],
      projectRoot: workspace,
      initialProjectBashApprovalGrants: [
        {
          projectRoot: workspace,
          cwd: workspace,
          argvPrefix: ["pnpm", "test"],
        },
        {
          projectRoot: workspace,
          cwd: workspace,
          commandFamily: "pnpm_vitest_run_workspace_test_selectors",
        },
      ],
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
        throw new Error("approvals command should not resolve a provider");
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => {
        throw new Error("approvals command should not start a model turn");
      },
      formatCostReport: () => "",
    });

    try {
      // When
      input.end("/approvals\n");

      // Then
      await session;
      expect(stdout).toContain("Bash approvals:\n");
      expect(stdout).toContain("  1. exact command\n");
      expect(stdout).toContain(`     cwd: ${workspace}\n`);
      expect(stdout).toContain("     command: printf 'x\\x1b[2Jy'\n");
      expect(stdout).toContain("  2. command family\n");
      expect(stdout).toContain("     argv prefix: git status\n");
      expect(stdout).toContain("  3. command family\n");
      expect(stdout).toContain(
        "     family: pnpm vitest run <workspace test selectors>\n",
      );
      expect(stdout).toContain(
        "Use /approvals revoke <index> or /approvals clear to remove approvals.\n",
      );
      expect(stdout).toContain("Bash project approvals:\n");
      expect(stdout).toContain(`     project: ${workspace}\n`);
      expect(stdout).toContain(`     approved from: ${workspace}\n`);
      expect(stdout).toContain("     argv prefix: pnpm test\n");
      expect(stdout).toContain("  2. command family\n");
      expect(stdout).toContain(
        "     family: pnpm vitest run <workspace test selectors>\n",
      );
      expect(stdout).toContain(
        "Use keel approvals revoke <index> or keel approvals clear to remove project approvals.\n",
      );
      expect(stdout).not.toContain("\u001b");
      expect(stderr).toBe("");
      expect(providerResolved).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an interactive session has one bash approval,
    When the user clears approvals,
    Then Keel reports the singular cleared approval count`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-approvals-one-"));
    const input = new PassThrough();
    let stdout = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "ask" },
      workspace,
      platform: process.platform,
      session: EPHEMERAL_INTERACTIVE_SESSION,
      initialBashApprovalGrants: [
        {
          type: "exact",
          cwd: workspace,
          command: "pnpm test",
        },
      ],
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
        throw new Error(
          "clear approvals command should not resolve a provider",
        );
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => {
        throw new Error(
          "clear approvals command should not start a model turn",
        );
      },
      formatCostReport: () => "",
    });

    try {
      // When
      input.end("/approvals clear\n");

      // Then
      await session;
      expect(stdout).toBe("Cleared 1 bash approval.\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given bash approvals are restored while bash ask mode is off,
    When the user revokes and clears approvals,
    Then Keel updates the local approval list without starting a model turn`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-approvals-inactive-"));
    const input = new PassThrough();
    let stdout = "";
    let stderr = "";
    const session = runInteractiveSession({
      cliArgs: { bashMode: "disabled" },
      workspace,
      platform: process.platform,
      session: EPHEMERAL_INTERACTIVE_SESSION,
      initialBashApprovalGrants: [
        {
          type: "exact",
          cwd: workspace,
          command: "pnpm test",
        },
        {
          type: "prefix",
          cwd: workspace,
          argvPrefix: ["git", "status"],
        },
      ],
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
        throw new Error("inactive approvals commands should not resolve");
      },
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async () => {
        throw new Error("inactive approvals commands should not start a turn");
      },
      formatCostReport: () => "",
    });

    try {
      // When
      input.end("/approvals revoke 1\n/approvals clear\n/approvals revoke 1\n");

      // Then
      await session;
      expect(stdout).toContain("Revoked bash approval 1.\n");
      expect(stdout).toContain("Cleared 1 bash approval.\n");
      expect(stderr).toContain("Error: no bash approval at index 1.\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given an interactive session has an exact bash approval,
    When the user revokes it with /approvals revoke,
    Then the next matching command asks for approval again`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-approvals-revoke-"));
    const command =
      "node -e \"require('node:fs').appendFileSync('runs.txt', 'x')\"";
    const provider = createFakeProvider([
      fakeToolResponse("bash", { command }),
      fakeResponse("Ran after revoke."),
    ]);
    const input = new PassThrough();
    let stdout = "";
    let stderr = "";
    let approvalPrompts = 0;
    const revokedGrants: BashApprovalGrant[] = [];
    const session = runInteractiveSession({
      cliArgs: { bashMode: "ask" },
      workspace,
      platform: process.platform,
      session: savedInteractiveSession({
        id: "test-session",
        persistBashApprovalRevoked: (revocation) => {
          revokedGrants.push(revocation.grant);
        },
      }),
      initialBashApprovalGrants: [
        {
          type: "exact",
          cwd: workspace,
          command,
        },
      ],
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
        if (text.includes("Approve bash command")) {
          approvalPrompts++;
          input.write("y\n");
          input.end();
        }
      },
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => fakeResolvedProvider(provider),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
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

    try {
      // When
      input.write("/approvals revoke 1\n");
      input.write("run it\n");

      // Then
      await withTimeout(session, 5000, "revoked approval run did not finish");
      expect(stdout).toContain("Revoked bash approval 1.\n");
      expect(stdout).toContain("Ran after revoke.\n");
      expect(await readFile(join(workspace, "runs.txt"), "utf8")).toBe("x");
      expect(approvalPrompts).toBe(1);
      expect(stderr).toContain("Approve bash command?");
      expect(revokedGrants).toEqual([
        { type: "exact", cwd: workspace, command },
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test(`Given a queued approval revoke command is persisted before a crash,
    When the session is resumed,
    Then the queued command is already consumed and cannot revoke a different approval`, async () => {
    // Given
    const workspace = await mkdtemp(
      join(tmpdir(), "keel-approvals-queued-revoke-"),
    );
    const home = await mkdtemp(join(tmpdir(), "keel-session-home-"));

    try {
      const session = createSessionStore({
        sessionId: "queued-approval-revoke",
        workspace,
        runtime: runtime(home),
      });
      const exactGrant = {
        type: "exact",
        cwd: session.workspace,
        command: "pnpm test",
      } satisfies BashApprovalGrant;
      const prefixGrant = {
        type: "prefix",
        cwd: session.workspace,
        argvPrefix: ["git", "status"],
      } satisfies BashApprovalGrant;
      persistSessionBashApprovalGrant({
        session,
        grant: exactGrant,
        runtime: runtime(home, 1),
      });
      persistSessionBashApprovalGrant({
        session,
        grant: prefixGrant,
        runtime: runtime(home, 2),
      });
      const queuedInput = persistSessionQueuedInput({
        session,
        sequence: 3,
        line: "/approvals revoke 1",
        runtime: runtime(home, 3),
      });
      const input = new PassThrough();
      const crashingSession = runInteractiveSession({
        cliArgs: { bashMode: "ask" },
        workspace,
        platform: process.platform,
        session: savedInteractiveSession({
          id: "test-session",
          persistBashApprovalRevoked: (revocation) => {
            persistSessionBashApprovalRevoked({
              session,
              grant: revocation.grant,
              runtime: runtime(home, 4),
              consumedInputIds: revocation.consumedInputIds,
            });
            throw new Error("crash after approval revocation persisted");
          },
        }),
        initialQueuedInputs: [queuedInput],
        initialBashApprovalGrants: [exactGrant, prefixGrant],
        input,
        writeStdout: () => {},
        writeStderr: () => {},
        onSigint: () => {},
        offSigint: () => {},
        setExitCode: () => {},
        forceExit: (code) => {
          throw new ForcedExit(code);
        },
        resolveProvider: () => {
          throw new Error("queued revoke should not resolve a provider");
        },
        requireKnownCostModel: () => ZERO_COST_MODEL,
        printAgentEvents: async () => {
          throw new Error("queued revoke should not start a model turn");
        },
        formatCostReport: () => "",
      });

      // When
      input.end();

      // Then
      await expect(
        withTimeout(
          crashingSession,
          5000,
          "queued revoke crash did not happen",
        ),
      ).rejects.toThrow("crash after approval revocation persisted");
      const resumed = resumeSessionStore({
        sessionId: "queued-approval-revoke",
        workspace,
        runtime: runtime(home, 5),
      });
      const ledger = await readFile(session.filePath, "utf8");
      expect(ledger).toContain('"type":"bash_approval_revoked"');
      expect(ledger).toContain(`"consumedInputIds":["${queuedInput.id}"]`);
      expect(resumed.pendingInputs).toEqual([]);
      expect(resumed.bashApprovalGrants).toEqual([prefixGrant]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given an interactive session has bash approvals,
    When the user clears them with /approvals clear,
    Then the next matching command asks for approval again`, async () => {
    // Given
    const workspace = await mkdtemp(join(tmpdir(), "keel-approvals-clear-"));
    const command =
      "node -e \"require('node:fs').appendFileSync('runs.txt', 'x')\"";
    const provider = createFakeProvider([
      fakeToolResponse("bash", { command }),
      fakeResponse("Ran after clear."),
    ]);
    const input = new PassThrough();
    let stdout = "";
    let stderr = "";
    let approvalPrompts = 0;
    let clearCount = 0;
    const session = runInteractiveSession({
      cliArgs: { bashMode: "ask" },
      workspace,
      platform: process.platform,
      session: savedInteractiveSession({
        id: "test-session",
        persistBashApprovalsCleared: () => {
          clearCount++;
        },
      }),
      initialBashApprovalGrants: [
        {
          type: "exact",
          cwd: workspace,
          command,
        },
        {
          type: "prefix",
          cwd: workspace,
          argvPrefix: ["git", "status"],
        },
      ],
      input,
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
        if (text.includes("Approve bash command")) {
          approvalPrompts++;
          input.write("y\n");
          input.end();
        }
      },
      onSigint: () => {},
      offSigint: () => {},
      setExitCode: () => {},
      forceExit: (code) => {
        throw new ForcedExit(code);
      },
      resolveProvider: () => fakeResolvedProvider(provider),
      requireKnownCostModel: () => ZERO_COST_MODEL,
      printAgentEvents: async (stream) => {
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

    try {
      // When
      input.write("/approvals clear\n");
      input.write("run it\n");

      // Then
      await withTimeout(session, 5000, "cleared approval run did not finish");
      expect(stdout).toContain("Cleared 2 bash approvals.\n");
      expect(stdout).toContain("Ran after clear.\n");
      expect(await readFile(join(workspace, "runs.txt"), "utf8")).toBe("x");
      expect(approvalPrompts).toBe(1);
      expect(stderr).toContain("Approve bash command?");
      expect(clearCount).toBe(1);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
