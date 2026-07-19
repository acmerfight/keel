import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import { runCliMain } from "../../src/cli/index.ts";
import { runMemoryCandidateCommand } from "../../src/cli/memory-candidate-command.ts";
import { addProjectMemory } from "../../src/cli/project-memory.ts";
import {
  type CandidateExtractionRecord,
  type CandidateProposal,
  failedCandidateExtractionOperation,
  recordCandidateExtraction,
  recordCandidateExtractionOutcome,
  recordCurrentTurnCandidateProposal,
} from "../../src/cli/project-memory-candidates.ts";
import { createGitWorkspace } from "../../src/testing/cli-harness.ts";
import { createRuntime } from "../../src/testing/cli-runtime-fixtures.ts";
import { runtime } from "../../src/testing/session-store-fixtures.ts";

const NOW = Date.parse("2026-07-17T00:00:00.000Z");

function extraction(
  sessionId: string,
  operationId: string,
): CandidateExtractionRecord {
  return {
    operationId,
    sessionId,
    providerId: "deepseek",
    model: "deepseek-v4-flash",
    usage: {
      inputTokens: 10,
      cachedInputTokens: 0,
      uncachedInputTokens: 10,
      outputTokens: 5,
    },
    costUsd: 0.0000028,
    attemptCount: 1,
    retryCount: 0,
    maxCostUsd: 0.05,
    createdAt: new Date(NOW).toISOString(),
    finishedAt: new Date(NOW).toISOString(),
  };
}

function proposal(sessionId: string, statement: string): CandidateProposal {
  return {
    kind: "project_context",
    statement,
    why: "This user-supplied invariant should survive future sessions.",
    sources: [{ sessionId, messageId: "msg_1", quote: statement }],
    conflictMemoryIds: [],
  };
}

async function command(
  args: readonly string[],
  workspace: string,
  keelHome: string,
): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const fixture = createRuntime(args, {
    cwd: workspace,
    env: { KEEL_HOME: keelHome },
    now: () => NOW,
  });
  return {
    exitCode: await runCliMain(fixture.runtime),
    stdout: fixture.stdout(),
    stderr: fixture.stderr(),
  };
}

describe("memory candidate command", () => {
  test(`Given a current-turn proposal is waiting for later review,
    When the user shows it through the candidate CLI,
    Then output identifies its real proposal origin without fabricated extraction data`, async () => {
    const workspace = await createGitWorkspace(
      "keel-current-proposal-command-",
    );
    const keelHome = await mkdtemp(
      join(tmpdir(), "keel-current-proposal-command-home-"),
    );
    try {
      const recorded = recordCurrentTurnCandidateProposal(
        runtime(keelHome, NOW),
        workspace,
        {
          sessionId: "interactive-session",
          messageId: "msg_current",
          providerId: "kimi",
          model: "kimi-k2.5",
          createdAt: new Date(NOW).toISOString(),
        },
        {
          kind: "project_context",
          statement: "Release validation uses pnpm test:coverage.",
          why: "This rule should remain visible in later sessions.",
          sources: [
            {
              sessionId: "interactive-session",
              messageId: "msg_current",
              quote: "pnpm test:coverage",
            },
          ],
          conflictMemoryIds: [],
        },
      );

      const shown = await command(
        ["memory", "candidates", "show", recorded.candidate.id],
        workspace,
        keelHome,
      );

      expect(shown.exitCode, shown.stderr).toBe(0);
      expect(shown.stdout).toContain("origin: current_turn_proposal");
      expect(shown.stdout).toContain("provider: kimi");
      expect(shown.stdout).toContain("model: kimi-k2.5");
      expect(shown.stdout).not.toContain("input tokens:");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(keelHome, { recursive: true, force: true });
    }
  });

  test(`Given candidates in several review states,
    When the user manages them through the candidate CLI,
    Then show, edit, approval, rejection, linked purge, clear, and operation output stay connected`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-candidate-command-");
    const keelHome = await mkdtemp(
      join(tmpdir(), "keel-candidate-command-home-"),
    );
    const storeRuntime = runtime(keelHome, NOW);
    try {
      const empty = await command(
        ["memory", "candidates", "list"],
        workspace,
        keelHome,
      );
      expect(empty.exitCode).toBe(0);
      expect(empty.stdout).toContain("No project-memory candidates");

      recordCandidateExtractionOutcome(
        storeRuntime,
        workspace,
        failedCandidateExtractionOperation({
          operationId: "mcex_00000000-0000-4000-8000-000000000000",
          sessionId: "not-admitted",
          maxCostUsd: 0.05,
          createdAt: new Date(NOW).toISOString(),
          finishedAt: new Date(NOW).toISOString(),
          outcome: "admission_rejected",
          providerId: null,
          model: null,
          usage: null,
          costUsd: null,
          attemptCount: 0,
          retryCount: 0,
          failure: "ineligible_session",
        }),
      );

      const first = recordCandidateExtraction(
        storeRuntime,
        workspace,
        extraction("review-1", "mcex_11111111-1111-4111-8111-111111111111"),
        [proposal("review-1", "The platform team owns release validation.")],
        false,
      ).candidates[0];
      expect(first).toBeDefined();

      // When / Then
      const listed = await command(
        ["memory", "candidates", "list"],
        workspace,
        keelHome,
      );
      expect(listed.stdout).toContain("Candidate extraction operations:");
      expect(listed.stdout).toContain("succeeded");
      expect(listed.stdout).toContain("provider=none");
      expect(listed.stdout).toContain("input=none output=none");
      expect(listed.stdout).toContain("cost=none");

      const shown = await command(
        ["memory", "candidates", "show", String(first?.id)],
        workspace,
        keelHome,
      );
      expect(shown.exitCode, shown.stderr).toBe(0);
      expect(shown.stdout).toContain("source session: review-1");
      expect(shown.stdout).toContain("sensitivity validation:");
      expect(shown.stdout).toContain("cost: $0.0000028");

      const edited = await command(
        [
          "memory",
          "candidates",
          "edit",
          String(first?.id),
          "The reliability team owns release validation.",
        ],
        workspace,
        keelHome,
      );
      expect(edited.exitCode, edited.stderr).toBe(0);
      expect(edited.stdout).toContain("Edited pending");
      const editedDetails = await command(
        ["memory", "candidates", "show", String(first?.id)],
        workspace,
        keelHome,
      );
      expect(editedDetails.stdout).toContain(
        "original statement: The platform team owns release validation.",
      );
      expect(editedDetails.stdout).toContain(
        "conflicting memory: not re-evaluated after edit",
      );

      const approved = await command(
        ["memory", "candidates", "approve", String(first?.id), "--keep"],
        workspace,
        keelHome,
      );
      expect(approved.exitCode, approved.stderr).toBe(0);
      const memoryId = /as (mem_[a-f0-9-]+)/u.exec(approved.stdout)?.[1];
      expect(memoryId).toBeDefined();
      const activeList = await command(["memory", "list"], workspace, keelHome);
      expect(activeList.stdout).toContain(`candidate=${String(first?.id)}`);
      const activeDetails = await command(
        ["memory", "show", String(memoryId)],
        workspace,
        keelHome,
      );
      expect(activeDetails.stdout).toContain(
        `source candidate: ${String(first?.id)}`,
      );
      const approvedDetails = await command(
        ["memory", "candidates", "show", String(first?.id)],
        workspace,
        keelHome,
      );
      expect(approvedDetails.stdout).toContain(
        `active memory: ${String(memoryId)}`,
      );

      const refusedPurge = await command(
        ["memory", "candidates", "purge", String(first?.id)],
        workspace,
        keelHome,
      );
      expect(refusedPurge.exitCode).toBe(1);
      expect(refusedPurge.stderr).toContain(
        `--purge-memory ${String(memoryId)}`,
      );

      const purged = await command(
        [
          "memory",
          "candidates",
          "purge",
          String(first?.id),
          "--purge-memory",
          String(memoryId),
        ],
        workspace,
        keelHome,
      );
      expect(purged.exitCode, purged.stderr).toBe(0);
      expect(purged.stdout).toContain(`and linked memory ${String(memoryId)}`);

      const second = recordCandidateExtraction(
        storeRuntime,
        workspace,
        extraction("review-2", "mcex_22222222-2222-4222-8222-222222222222"),
        [proposal("review-2", "Use release trains for major upgrades.")],
        false,
      ).candidates[0];
      const rejected = await command(
        ["memory", "candidates", "reject", String(second?.id)],
        workspace,
        keelHome,
      );
      expect(rejected.exitCode, rejected.stderr).toBe(0);
      expect(rejected.stdout).toContain("audit payload remains on disk");

      const pendingPurge = recordCandidateExtraction(
        storeRuntime,
        workspace,
        extraction("review-purge", "mcex_55555555-5555-4555-8555-555555555555"),
        [proposal("review-purge", "Keep the changelog audience-specific.")],
        false,
      ).candidates[0];
      const purgedPending = await command(
        ["memory", "candidates", "purge", String(pendingPurge?.id)],
        workspace,
        keelHome,
      );
      expect(purgedPending.exitCode, purgedPending.stderr).toBe(0);
      expect(purgedPending.stdout).not.toContain("and linked memory");

      recordCandidateExtraction(
        storeRuntime,
        workspace,
        extraction("review-3", "mcex_33333333-3333-4333-8333-333333333333"),
        [proposal("review-3", "Review release ownership quarterly.")],
        false,
      );
      const cleared = await command(
        ["memory", "candidates", "clear", "--yes"],
        workspace,
        keelHome,
      );
      expect(cleared.exitCode, cleared.stderr).toBe(0);
      expect(cleared.stdout).toContain("Rejected 1 pending");

      const physicallyCleared = await command(
        ["memory", "candidates", "clear", "--purge", "--yes"],
        workspace,
        keelHome,
      );
      expect(physicallyCleared.exitCode, physicallyCleared.stderr).toBe(0);
      expect(physicallyCleared.stdout).toContain(
        "Purged 2 project-memory candidate payload entries",
      );

      const unknown = await command(
        ["memory", "candidates", "show", "cand_00000000"],
        workspace,
        keelHome,
      );
      expect(unknown.exitCode).toBe(1);
      expect(unknown.stderr).toContain("does not exist in this project");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(keelHome, { recursive: true, force: true });
    }
  });

  test(`Given a pending candidate and the statement length boundary,
    When the user submits an over-limit edit followed by a boundary-length edit,
    Then Keel reports a clean error and still accepts the valid edit`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-candidate-edit-length-");
    const keelHome = await mkdtemp(
      join(tmpdir(), "keel-candidate-edit-length-home-"),
    );
    const candidate = recordCandidateExtraction(
      runtime(keelHome, NOW),
      workspace,
      extraction("edit-length", "mcex_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
      [proposal("edit-length", "Keep release validation deterministic.")],
      false,
    ).candidates[0];
    expect(candidate).toBeDefined();

    try {
      // When
      const overLimit = await command(
        [
          "memory",
          "candidates",
          "edit",
          String(candidate?.id),
          "x".repeat(1_001),
        ],
        workspace,
        keelHome,
      );
      const atLimit = await command(
        [
          "memory",
          "candidates",
          "edit",
          String(candidate?.id),
          "x".repeat(1_000),
        ],
        workspace,
        keelHome,
      );

      // Then
      expect(overLimit.exitCode).toBe(1);
      expect(overLimit.stderr).toBe(
        "Error: project-memory candidate text must be at most 1000 characters.\n",
      );
      expect(overLimit.stderr).not.toContain("unexpected runtime failure");
      expect(atLimit.exitCode, atLimit.stderr).toBe(0);
      const shown = await command(
        ["memory", "candidates", "show", String(candidate?.id)],
        workspace,
        keelHome,
      );
      expect(shown.stdout).toContain(`statement: ${"x".repeat(1_000)}`);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(keelHome, { recursive: true, force: true });
    }
  });

  test(`Given a non-interactive or declined candidate clear request,
    When confirmation is missing or refused,
    Then Keel fails safely or leaves the pending candidate unchanged`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-candidate-confirm-");
    const keelHome = await mkdtemp(
      join(tmpdir(), "keel-candidate-confirm-home-"),
    );
    const storeRuntime = runtime(keelHome, NOW);
    recordCandidateExtraction(
      storeRuntime,
      workspace,
      extraction("confirm-1", "mcex_44444444-4444-4444-8444-444444444444"),
      [proposal("confirm-1", "Keep canary releases enabled.")],
      false,
    );
    try {
      // When / Then
      const nonInteractive = await command(
        ["memory", "candidates", "clear"],
        workspace,
        keelHome,
      );
      expect(nonInteractive.exitCode).toBe(1);
      expect(nonInteractive.stderr).toContain(
        "requires an interactive confirmation",
      );
      const nonInteractivePurge = await command(
        ["memory", "candidates", "clear", "--purge"],
        workspace,
        keelHome,
      );
      expect(nonInteractivePurge.exitCode).toBe(1);
      expect(nonInteractivePurge.stderr).toContain(
        "clear --purge requires an interactive confirmation",
      );

      const input = new PassThrough();
      input.end("n\n");
      const declined = createRuntime(["memory", "candidates", "clear"], {
        cwd: workspace,
        env: { KEEL_HOME: keelHome },
        input,
        inputIsTTY: true,
        now: () => NOW,
      });
      expect(await runCliMain(declined.runtime)).toBe(0);
      expect(declined.stdout()).toBe("Project-memory candidates unchanged.\n");
      expect(
        (await command(["memory", "candidates", "list"], workspace, keelHome))
          .stdout,
      ).toContain("\tpending\t");

      const acceptedInput = new PassThrough();
      recordCandidateExtraction(
        storeRuntime,
        workspace,
        extraction("confirm-2", "mcex_77777777-7777-4777-8777-777777777777"),
        [proposal("confirm-2", "Keep rollback instructions current.")],
        false,
      );
      acceptedInput.end("yes\n");
      const accepted = createRuntime(["memory", "candidates", "clear"], {
        cwd: workspace,
        env: { KEEL_HOME: keelHome },
        input: acceptedInput,
        inputIsTTY: true,
        now: () => NOW,
      });
      expect(await runCliMain(accepted.runtime)).toBe(0);
      expect(accepted.stdout()).toContain("Rejected 2 pending");

      const purgeInput = new PassThrough();
      purgeInput.end("y\n");
      const purge = createRuntime(
        ["memory", "candidates", "clear", "--purge"],
        {
          cwd: workspace,
          env: { KEEL_HOME: keelHome },
          input: purgeInput,
          inputIsTTY: true,
          now: () => NOW,
        },
      );
      expect(await runCliMain(purge.runtime)).toBe(0);
      expect(purge.stderr()).not.toContain("linked active memory");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(keelHome, { recursive: true, force: true });
    }
  });

  test(`Given an approved candidate is cleared interactively with linked purge,
    When the user confirms the irreversible operation,
    Then the prompt names the linked memory effect and both payloads are removed`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-candidate-purge-confirm-");
    const keelHome = await mkdtemp(
      join(tmpdir(), "keel-candidate-purge-confirm-home-"),
    );
    const storeRuntime = runtime(keelHome, NOW);
    try {
      const candidate = recordCandidateExtraction(
        storeRuntime,
        workspace,
        extraction(
          "purge-confirm",
          "mcex_66666666-6666-4666-8666-666666666666",
        ),
        [proposal("purge-confirm", "Keep the canary ring enabled.")],
        false,
      ).candidates[0];
      expect(candidate).toBeDefined();
      expect(
        (
          await command(
            ["memory", "candidates", "approve", String(candidate?.id)],
            workspace,
            keelHome,
          )
        ).exitCode,
      ).toBe(0);
      const second = recordCandidateExtraction(
        storeRuntime,
        workspace,
        extraction(
          "purge-confirm-2",
          "mcex_88888888-8888-4888-8888-888888888888",
        ),
        [proposal("purge-confirm-2", "Keep the rollback ring enabled.")],
        false,
      ).candidates[0];
      expect(second).toBeDefined();
      expect(
        (
          await command(
            ["memory", "candidates", "approve", String(second?.id)],
            workspace,
            keelHome,
          )
        ).exitCode,
      ).toBe(0);
      const input = new PassThrough();
      input.end("y\n");
      const fixture = createRuntime(
        ["memory", "candidates", "clear", "--purge", "--purge-memories"],
        {
          cwd: workspace,
          env: { KEEL_HOME: keelHome },
          input,
          inputIsTTY: true,
          now: () => NOW,
        },
      );

      // When
      const exitCode = await runCliMain(fixture.runtime);

      // Then
      expect(exitCode, fixture.stderr()).toBe(0);
      expect(fixture.stderr()).toContain("and every linked active memory");
      expect(fixture.stdout()).toContain(
        "Purged 2 project-memory candidate payload entries and 2 linked active memories",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(keelHome, { recursive: true, force: true });
    }
  });

  test(`Given candidates expose duplicate and conflict relations or the event path is unsafe,
    When the user asks for details or lists the inbox,
    Then relations render explicitly and event-file failures stay safe and concise`, async () => {
    // Given
    const workspace = await createGitWorkspace("keel-candidate-relations-");
    const keelHome = await mkdtemp(
      join(tmpdir(), "keel-candidate-relations-home-"),
    );
    const storeRuntime = runtime(keelHome, NOW);
    try {
      const active = addProjectMemory(
        storeRuntime,
        workspace,
        "Release tags use a v prefix.",
        { type: "user_explicit", channel: "cli", evidence: "test" },
        { reviewAfter: null, expiresAt: null },
      );
      const duplicate = recordCandidateExtraction(
        storeRuntime,
        workspace,
        extraction("relations-1", "mcex_99999999-9999-4999-8999-999999999999"),
        [proposal("relations-1", "Release tags use a v prefix.")],
        false,
      ).candidates[0];
      const conflict = recordCandidateExtraction(
        storeRuntime,
        workspace,
        extraction("relations-2", "mcex_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
        [
          {
            ...proposal("relations-2", "Release tags no longer use a prefix."),
            conflictMemoryIds: [active.entry.id],
          },
        ],
        false,
      ).candidates[0];

      // When / Then
      const duplicateDetails = await command(
        ["memory", "candidates", "show", String(duplicate?.id)],
        workspace,
        keelHome,
      );
      expect(duplicateDetails.stdout).toContain(
        `duplicate memory: ${active.entry.id}`,
      );
      const conflictDetails = await command(
        ["memory", "candidates", "show", String(conflict?.id)],
        workspace,
        keelHome,
      );
      expect(conflictDetails.stdout).toContain(
        `conflicting memory: ${active.entry.id}`,
      );

      const eventsPath = join(
        keelHome,
        "memory",
        "projects",
        active.scope.id,
        "events.jsonl",
      );
      await rm(eventsPath);
      await mkdir(eventsPath);
      const unsafe = await command(
        ["memory", "candidates", "list"],
        workspace,
        keelHome,
      );
      expect(unsafe.exitCode).toBe(1);
      expect(unsafe.stderr).toContain("unsafe project memory path");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(keelHome, { recursive: true, force: true });
    }
  });

  test(`Given candidate command execution throws an unrelated programming error,
    When the command boundary catches it,
    Then it rethrows instead of misreporting it as a user-facing memory error`, async () => {
    // Given
    const fixture = createRuntime([], { cwd: "." });
    const unexpected = new Error("unexpected candidate defect");
    const crashingRuntime = {
      ...fixture.runtime,
      cwd: () => {
        throw unexpected;
      },
    };

    // When / Then
    await expect(
      runMemoryCandidateCommand(
        { command: "memory", mode: "candidates-list" },
        crashingRuntime,
      ),
    ).rejects.toBe(unexpected);
  });

  test(`Given exactly one approved candidate exists,
    When confirmed physical clear includes linked active memory,
    Then the CLI uses singular accounting for both removed payloads`, async () => {
    // Given
    const workspace = await createGitWorkspace(
      "keel-candidate-singular-clear-",
    );
    const keelHome = await mkdtemp(
      join(tmpdir(), "keel-candidate-singular-clear-home-"),
    );
    const storeRuntime = runtime(keelHome, NOW);
    try {
      const candidate = recordCandidateExtraction(
        storeRuntime,
        workspace,
        extraction(
          "singular-clear",
          "mcex_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        ),
        [proposal("singular-clear", "Keep one canary ring enabled.")],
        false,
      ).candidates[0];
      expect(
        (
          await command(
            ["memory", "candidates", "approve", String(candidate?.id)],
            workspace,
            keelHome,
          )
        ).exitCode,
      ).toBe(0);
      const refused = await command(
        ["memory", "candidates", "clear", "--purge", "--yes"],
        workspace,
        keelHome,
      );
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr).toContain(
        "1 project-memory candidate is linked to active memory",
      );

      // When
      const cleared = await command(
        [
          "memory",
          "candidates",
          "clear",
          "--purge",
          "--purge-memories",
          "--yes",
        ],
        workspace,
        keelHome,
      );

      // Then
      expect(cleared.exitCode, cleared.stderr).toBe(0);
      expect(cleared.stdout).toContain(
        "Purged 1 project-memory candidate payload entry and 1 linked active memory",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(keelHome, { recursive: true, force: true });
    }
  });
});
